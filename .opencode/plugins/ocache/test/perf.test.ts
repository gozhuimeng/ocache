/**
 * `readSince` 规模化与耗时（M5/#2）。
 *
 * 要回答的问题是需求 §10 验收第 7 条那句"**重启后启动开销为毫秒级（有基线时）**"——
 * 之前只有正确性单测，没有任何规模化的数字。
 *
 * 成本模型（`shared/store.ts`）：
 *
 * | 路径 | 触发条件 | 做的事 |
 * |---|---|---|
 * | 有基线·无新增 | `cursors[k] === size` | 每个文件一次 `stat`，**完全不读内容** |
 * | 有基线·有新增 | `cursors[k] < size` | 只读 `start` 之后的字节，只 parse 新增行 |
 * | 无基线 / 游标超前 | `cursors` 为空或 `> size` | 全量读 + 全量 parse |
 *
 * 断言分两类，刻意**不把墙钟时间卡太死**（CI 抖动会让它变成 flaky 测试）：
 *   1. **正确性**：行数、游标、rebuilt —— 全部精确断言；
 *   2. **量级守卫**：用"取多次最小值"屏蔽调度抖动，只断言差**一个数量级**的关系，
 *      并给一个宽松到只在出现 O(n²) 回归时才会爆的绝对上界。
 * 实际数字通过 `t.diagnostic()` 打出来，方便随手看。
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile, appendFile, stat } from "node:fs/promises"
import path from "node:path"
import { readSince, type SyncResult } from "../shared/store.ts"
import { STEP_TYPE, SCHEMA_VERSION, type StepRow } from "../shared/schema.ts"

let root = ""

before(async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  root = await mkdtemp(path.join("/tmp/opencode", "ocache-perf-"))
})

after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

function row(id: string, ts: number): StepRow {
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
  }
}

/** 造一个月份目录：`files` 个会话文件，每个 1 条 meta + `rows` 条数据行。 */
async function build(dir: string, files: number, rows: number): Promise<void> {
  await mkdir(path.join(dir, "2026-09"), { recursive: true })
  const meta = JSON.stringify({
    type: "meta",
    schema: SCHEMA_VERSION,
    record: true,
    price_tag: "$",
    created: 0,
  })
  await Promise.all(
    Array.from({ length: files }, (_, f) => {
      const id = `ses_${String(f).padStart(4, "0")}`
      const chunks = [meta]
      for (let r = 0; r < rows; r++) chunks.push(JSON.stringify(row(id, r)))
      return writeFile(path.join(dir, "2026-09", `${id}.jsonl`), chunks.join("\n") + "\n", "utf8")
    }),
  )
}

/** 取多次中的最小值：屏蔽系统调度与 GC 抖动，量的是代码路径的下界。 */
async function best(fn: () => Promise<unknown>, runs = 5): Promise<number> {
  let min = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    min = Math.min(min, performance.now() - t0)
  }
  return min
}

describe("readSince 规模化与耗时（M5/#2）", () => {
  const FILES = 100
  const ROWS = 200
  const TOTAL = FILES * ROWS
  let dir = ""
  let bytes = 0

  before(async () => {
    dir = path.join(root, "perf")
    await build(dir, FILES, ROWS)
    bytes = (await stat(path.join(dir, "2026-09", "ses_0000.jsonl"))).size * FILES
  })

  test("无基线全量重扫：行数与规模精确一致", async (t) => {
    const full: SyncResult = await readSince(dir)
    assert.equal(full.rows.length, TOTAL, "全量重扫应读出全部数据行")
    assert.deepEqual(full.rebuilt, [], "没有基线时不算 rebuilt")
    assert.equal(Object.keys(full.cursors).length, FILES, "游标覆盖每个文件")
    assert.equal(Object.keys(full.sessionDirs).length, FILES)

    const ms = await best(() => readSince(dir))
    t.diagnostic(
      `全量重扫：${TOTAL} 行 / ${FILES} 文件 / 约 ${(bytes / 1e6).toFixed(1)} MB → ${ms.toFixed(1)} ms`,
    )
    // 绝对上界放得很松：正常应在几十~几百 ms，这里只拦 O(n²) 级的回归
    assert.ok(ms < 10_000, `全量重扫明显变慢：${ms.toFixed(1)} ms`)
  })

  test("有基线且无新增：只 stat 不读内容，毫秒级（验收第 7 条）", async (t) => {
    const base = await readSince(dir)
    const idle = await readSince(dir, base.cursors)
    assert.equal(idle.rows.length, 0, "游标已覆盖全部字节 → 一行都不返回")
    assert.deepEqual(idle.cursors, base.cursors, "游标不漂移")
    assert.deepEqual(idle.rebuilt, [], "文件没被截断，不该触发全量重读")

    const ms = await best(() => readSince(dir, base.cursors))
    t.diagnostic(`有基线·无新增：${FILES} 文件（每个只 stat 一次）→ ${ms.toFixed(1)} ms`)
    assert.ok(ms < 250, `启动同步明显变慢：${ms.toFixed(1)} ms`)
  })

  test("有基线·有新增：只返回新增的那几行", async (t) => {
    const base = await readSince(dir)
    const before = (await stat(path.join(dir, "2026-09", "ses_0000.jsonl"))).size

    const added = 50
    const parts: string[] = []
    for (let i = 0; i < added; i++) parts.push(JSON.stringify(row("ses_0000", 10_000 + i)))
    await appendFile(path.join(dir, "2026-09", "ses_0000.jsonl"), parts.join("\n") + "\n", "utf8")

    const delta = await readSince(dir, base.cursors)
    assert.equal(delta.rows.length, added, "增量只含新增行")
    assert.ok(
      delta.rows.every((r) => r.session_id === "ses_0000" && r.ts >= 10_000),
      "增量不该混进旧文件的行",
    )
    assert.deepEqual(delta.rebuilt, [])

    const ms = await best(() => {
      // 每次从同一份"已追加"的状态读，游标固定在追加前的位置
      return readSince(dir, base.cursors)
    })
    const grew = (await stat(path.join(dir, "2026-09", "ses_0000.jsonl"))).size - before
    t.diagnostic(`有基线·新增 ${added} 行（${grew} 字节）→ ${ms.toFixed(1)} ms`)
    assert.ok(ms < 250, `增量同步明显变慢：${ms.toFixed(1)} ms`)

    // 追加完成后游标推进到位，再来一次必须是 0 行（幂等）
    const settled = await readSince(dir, delta.cursors)
    assert.equal(settled.rows.length, 0, "游标追上后不再重复读")
  })

  /**
   * 这条是整组测试的核心：**文件数相同、内容差 8 倍**，
   * 若"无新增"路径真的只做 `stat`，两个耗时应当在同一量级；
   * 而全量重扫则会随内容线性变慢。两者一对照就把成本模型钉死了。
   */
  test("文件数相同、内容差 8 倍：无新增耗时不随内容增长", async (t) => {
    const small = path.join(root, "scale-small")
    const big = path.join(root, "scale-big")
    await build(small, FILES, 25)
    await build(big, FILES, 200)

    const cSmall = await readSince(small)
    const cBig = await readSince(big)
    assert.equal(cSmall.rows.length, FILES * 25)
    assert.equal(cBig.rows.length, FILES * 200)

    const idleSmall = await best(() => readSince(small, cSmall.cursors))
    const idleBig = await best(() => readSince(big, cBig.cursors))
    const fullBig = await best(() => readSince(big))
    t.diagnostic(
      `无新增：25 行/文件 ${idleSmall.toFixed(1)} ms ｜ 200 行/文件 ${idleBig.toFixed(1)} ms；` +
        `全量重扫大目录 ${fullBig.toFixed(1)} ms`,
    )

    // 允许 6 倍余量 + 30ms 噪声下限：小目录耗时接近 0 时不会因为比值爆炸而误报
    assert.ok(
      idleBig < Math.max(idleSmall * 6, 30),
      `无新增耗时随内容增长了：小 ${idleSmall.toFixed(1)}ms vs 大 ${idleBig.toFixed(1)}ms —— ` +
        "说明游标没有真正挡住内容读取",
    )
    // 对照组：全量重扫确实随内容线性变慢（否则上面的比较没有意义）
    assert.ok(
      fullBig > idleBig * 5,
      `全量重扫应显著慢于无新增路径：full ${fullBig.toFixed(1)}ms vs idle ${idleBig.toFixed(1)}ms`,
    )
  })

  test("文件被截断（游标超前）→ 该文件全量重读，其余文件仍走增量", async (t) => {
    const d = path.join(root, "truncated")
    await build(d, 10, 100)
    const base = await readSince(d)
    assert.equal(base.rows.length, 1000)

    // 把一个文件砍到 30 行：它的游标 > size，必须全量重读
    const victim = path.join(d, "2026-09", "ses_0003.jsonl")
    const kept = Array.from({ length: 30 }, (_, i) => JSON.stringify(row("ses_0003", i)))
    await writeFile(victim, kept.join("\n") + "\n", "utf8")

    const after = await readSince(d, base.cursors)
    assert.deepEqual(after.rebuilt, ["2026-09/ses_0003.jsonl"], "只有被截断的文件进 rebuilt")
    assert.equal(after.rows.length, 30, "重建文件全量重读 30 行，其余 9 个文件 0 行")
    assert.equal(after.cursors["2026-09/ses_0003.jsonl"], Buffer.byteLength(kept.join("\n") + "\n"))
    t.diagnostic("截断重建：1 个文件回退全量、9 个文件走增量")

    // 游标追平后再读必须是 0 行，且不再触发 rebuilt
    const settled = await readSince(d, after.cursors)
    assert.equal(settled.rows.length, 0)
    assert.deepEqual(settled.rebuilt, [])
  })
})
