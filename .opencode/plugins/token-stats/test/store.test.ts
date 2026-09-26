import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, appendFile, writeFile, stat } from "node:fs/promises"
import path from "node:path"
import { JsonlStore, readSince } from "../shared/store.ts"
import { STEP_TYPE, SCHEMA_VERSION, type StepRow } from "../shared/schema.ts"

let root = ""

before(async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  root = await mkdtemp(path.join("/tmp/opencode", "token-stats-store-"))
})

after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

function row(id: string, ts: number, extra: Partial<StepRow> = {}): StepRow {
  return {
    type: STEP_TYPE,
    schema: SCHEMA_VERSION,
    ts,
    date: "2026-09-26",
    hour: "2026-09-26T16",
    session_id: id,
    session_title: null,
    parent_id: null,
    project: null,
    step_index: 1,
    provider_id: "opencode",
    model_id: "m",
    model_name: null,
    variant: null,
    agent: "build",
    kind: "primary",
    finish: "stop",
    status: "ok",
    error_type: null,
    error_status: null,
    input: 1,
    cache_read: 2,
    cache_write: 3,
    output: 4,
    reasoning: 5,
    tokens_total: 15,
    currency: "$",
    price: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    cost: 0,
    dist: null,
    ...extra,
  }
}

async function lines(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8")
  return text.split("\n").filter((l) => l !== "")
}

function tmpStore(opts: Partial<ConstructorParameters<typeof JsonlStore>[0]> = {}) {
  const dir = opts.baseDir ?? path.join(root, `s${Math.random().toString(36).slice(2)}`)
  return { dir, store: new JsonlStore({ baseDir: dir, record: true, now: () => Date.now(), ...opts }) }
}

describe("JsonlStore 写侧", () => {
  test("flush 落盘：meta 头 + 数据行，文件名与月份目录正确", async () => {
    const { dir, store } = tmpStore()
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 1)))
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 2)))
    assert.deepEqual(store.pending(), { sessions: 1, rows: 2, bytes: store.pending().bytes })
    await store.flushAll()

    const file = path.join(dir, "2026-09", "ses_a.jsonl")
    const ls = await lines(file)
    assert.equal(ls.length, 3)
    const meta = JSON.parse(ls[0])
    assert.equal(meta.type, "meta")
    assert.equal(meta.schema, SCHEMA_VERSION)
    const first = JSON.parse(ls[1]) as StepRow
    assert.equal(first.session_id, "ses_a")
    assert.equal(first.ts, 1)
    assert.deepEqual(store.pending(), { sessions: 0, rows: 0, bytes: 0 })
  })

  test("record=false 时完全不落盘", async () => {
    const { dir, store } = tmpStore({ record: false })
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 1)))
    await store.flushAll()
    assert.deepEqual(store.pending(), { sessions: 0, rows: 0, bytes: 0 })
    await assert.rejects(() => readdir(dir))
  })

  test("归档目录以首次写入为准，跨月 push 仍写同一文件", async () => {
    const { dir, store } = tmpStore()
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 1)))
    store.push("ses_a", "2026-10", JSON.stringify(row("ses_a", 2)))
    await store.flushAll()
    const ls = await lines(path.join(dir, "2026-09", "ses_a.jsonl"))
    assert.equal(ls.length, 3)
    await assert.rejects(() => readdir(path.join(dir, "2026-10")))
  })

  test("多 session 并行 flush 不串文件", async () => {
    const { dir, store } = tmpStore()
    for (let i = 0; i < 5; i++) {
      store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", i)))
      store.push("ses_b", "2026-09", JSON.stringify(row("ses_b", i)))
    }
    await store.flushAll()
    const a = await lines(path.join(dir, "2026-09", "ses_a.jsonl"))
    const b = await lines(path.join(dir, "2026-09", "ses_b.jsonl"))
    assert.equal(a.length, 6)
    assert.equal(b.length, 6)
    const aTs = a.slice(1).map((l) => (JSON.parse(l) as StepRow).ts)
    assert.deepEqual(aTs, [0, 1, 2, 3, 4]) // 同 session 行序保持
    for (const l of b.slice(1)) assert.equal((JSON.parse(l) as StepRow).session_id, "ses_b")
  })

  test("meta 头只写一次（多次 flush 不重复）", async () => {
    const { dir, store } = tmpStore()
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 1)))
    await store.flushAll()
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 2)))
    await store.flushAll()
    const ls = await lines(path.join(dir, "2026-09", "ses_a.jsonl"))
    assert.equal(ls.filter((l) => JSON.parse(l).type === "meta").length, 1)
    assert.equal(ls.length, 3)
  })
})

describe("JsonlStore 触发条件", () => {
  test("行数触发", async () => {
    const { store } = tmpStore({ flushRows: 3, flushAgeMs: 10 ** 9 })
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 1)))
    assert.equal(store.dueSessions().length, 0)
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 2)))
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 3)))
    assert.deepEqual(store.dueSessions(), ["ses_a"])
  })

  test("驻留时间触发（注入时钟）", async () => {
    let t = 1_000_000
    const { store } = tmpStore({ flushAgeMs: 30_000, flushRows: 10 ** 9, now: () => t })
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 1)))
    assert.equal(store.dueSessions().length, 0)
    t += 29_999
    assert.equal(store.dueSessions().length, 0)
    t += 1
    assert.deepEqual(store.dueSessions(), ["ses_a"])
  })

  test("字节触发", async () => {
    const base = JSON.stringify(row("ses_a", 1))
    const { store } = tmpStore({
      flushBytes: base.length + 100,
      flushAgeMs: 10 ** 9,
      flushRows: 10 ** 9,
    })
    store.push("ses_a", "2026-09", base)
    assert.equal(store.dueSessions().length, 0)
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 2, { dist: "x".repeat(500) })))
    assert.deepEqual(store.dueSessions(), ["ses_a"])
  })

  test("内存上限触发最老优先强制 flush", async () => {
    const { dir, store } = tmpStore({ memoryCapBytes: 2000, flushAgeMs: 10 ** 9, flushRows: 10 ** 9 })
    const payload = (id: string) => JSON.stringify(row(id, 1, { dist: "x".repeat(400) }))
    const size = Buffer.byteLength(payload("ses_a"))
    assert.ok(size * 3 > 2000, "三次 push 必须能越过上限")

    store.push("ses_a", "2026-09", payload("ses_a"))
    store.push("ses_b", "2026-09", payload("ses_b"))
    assert.equal(store.pending().sessions, 2) // 尚未越界
    store.push("ses_c", "2026-09", payload("ses_c"))

    // 越界后最老的 ses_a 被强制刷掉，剩余不超上限
    assert.equal(store.pending().sessions, 2)
    assert.ok(store.pending().bytes <= 2000)
    await store.flushAll()
    const ls = await lines(path.join(dir, "2026-09", "ses_a.jsonl"))
    assert.equal(ls.length, 2) // meta + 1 行
    assert.deepEqual(store.pending(), { sessions: 0, rows: 0, bytes: 0 })
  })
})

describe("readSince 增量同步", () => {
  test("首轮全量、次轮无新增、追加后只读增量", async () => {
    const { dir, store } = tmpStore()
    for (let i = 0; i < 3; i++) store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", i)))
    await store.flushAll()

    const first = await readSince(dir)
    assert.equal(first.rows.length, 3)
    assert.deepEqual(first.rebuilt, [])
    assert.equal(first.sessionDirs["ses_a"], "2026-09")

    const second = await readSince(dir, first.cursors)
    assert.equal(second.rows.length, 0)
    assert.deepEqual(second.cursors, first.cursors)

    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 9)))
    await store.flushAll()
    const third = await readSince(dir, second.cursors)
    assert.equal(third.rows.length, 1)
    assert.equal(third.rows[0].ts, 9)
  })

  test("游标停在完整行尾：崩溃留下的半行不会被永久跳过", async () => {
    const { dir } = tmpStore()
    const file = path.join(dir, "2026-09", "ses_a.jsonl")
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(row("ses_a", 1))}\n${JSON.stringify(row("ses_a", 2))}\n`)

    const first = await readSince(dir)
    assert.equal(first.rows.length, 2)

    // 模拟写入中断：只有半行（无换行）
    await appendFile(file, JSON.stringify(row("ses_a", 3)).slice(0, 50))
    const second = await readSince(dir, first.cursors)
    assert.equal(second.rows.length, 0)
    assert.equal(second.cursors["2026-09/ses_a.jsonl"], first.cursors["2026-09/ses_a.jsonl"])

    // 补完半行
    const rest = JSON.stringify(row("ses_a", 3)).slice(50)
    await appendFile(file, `${rest}\n`)
    const third = await readSince(dir, second.cursors)
    assert.equal(third.rows.length, 1)
    assert.equal(third.rows[0].ts, 3)
  })

  test("坏行被跳过且游标仍推进", async () => {
    const { dir } = tmpStore()
    const file = path.join(dir, "2026-09", "ses_a.jsonl")
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(
      file,
      `${JSON.stringify(row("ses_a", 1))}\n{坏行:not json\n${JSON.stringify({ type: "unknown" })}\n${JSON.stringify(row("ses_a", 2))}\n`,
    )
    const res = await readSince(dir)
    assert.equal(res.rows.length, 2)
    assert.equal(res.cursors["2026-09/ses_a.jsonl"], (await stat(file)).size)
    // 推进后的游标不会再重复读到坏行
    const again = await readSince(dir, res.cursors)
    assert.equal(again.rows.length, 0)
  })

  test("文件被截断（size < cursor）→ 全量重读", async () => {
    const { dir, store } = tmpStore()
    for (let i = 0; i < 3; i++) store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", i)))
    await store.flushAll()
    const first = await readSince(dir)

    const file = path.join(dir, "2026-09", "ses_a.jsonl")
    await writeFile(file, `${JSON.stringify(row("ses_a", 100))}\n`)
    const second = await readSince(dir, first.cursors)
    assert.deepEqual(second.rebuilt, ["2026-09/ses_a.jsonl"])
    assert.equal(second.rows.length, 1)
    assert.equal(second.rows[0].ts, 100)
  })

  test("目录不存在返回空结果；被删文件的游标被剔除", async () => {
    const empty = await readSince(path.join(root, "does-not-exist"))
    assert.deepEqual(empty, { rows: [], cursors: {}, sessionDirs: {}, rebuilt: [] })

    const { dir, store } = tmpStore()
    store.push("ses_a", "2026-09", JSON.stringify(row("ses_a", 1)))
    await store.flushAll()
    const first = await readSince(dir)
    await rm(path.join(dir, "2026-09"), { recursive: true })
    const second = await readSince(dir, first.cursors)
    assert.deepEqual(second.cursors, {})
  })
})
