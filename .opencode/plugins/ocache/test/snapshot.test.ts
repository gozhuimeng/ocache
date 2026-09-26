import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises"
import path from "node:path"
import {
  writeSnapshot,
  readSnapshot,
  writeAggregate,
  readAggregate,
  snapshotPath,
  selectSessions,
  selectedSessionIds,
  subtreeBucketOf,
  SNAPSHOT_SCHEMA,
} from "../shared/snapshot.ts"
import { emptyAggregates, emptyBucket, record, snapshotOf } from "../shared/aggregate.ts"
import type { Snapshot } from "../shared/snapshot.ts"

let root = ""

before(async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  root = await mkdtemp(path.join("/tmp/opencode", "ocache-snap-"))
})

after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

const snap: Snapshot = {
  schema: SNAPSHOT_SCHEMA,
  updated: 1,
  record: true,
  currency: "¥",
  last_session_id: null,
  sessions: {},
  agg: null,
}

describe("snapshot", () => {
  test("原子写后可读回，内容一致", async () => {
    const dir = path.join(root, "a")
    assert.equal(await writeSnapshot(dir, snap), true)
    const got = await readSnapshot(dir)
    assert.deepEqual(got, snap)
    // 临时文件不能残留
    const files = await readdir(dir)
    assert.deepEqual(files, [".snapshot.json"])
  })

  test("读不存在的快照返回 null", async () => {
    assert.equal(await readSnapshot(path.join(root, "nope")), null)
  })

  test("内容损坏返回 null 而非抛异常", async () => {
    const dir = path.join(root, "b")
    await mkdir(dir, { recursive: true })
    await writeFile(snapshotPath(dir), "{坏", "utf8")
    assert.equal(await readSnapshot(dir), null)
    await writeFile(snapshotPath(dir), JSON.stringify({ hello: 1 }), "utf8")
    assert.equal(await readSnapshot(dir), null)
  })

  test("并发写不产生半截文件", async () => {
    const dir = path.join(root, "c")
    const variants = Array.from({ length: 10 }, (_, i) => ({ ...snap, updated: i }))
    await Promise.all(variants.map((v) => writeSnapshot(dir, v)))
    const got = await readSnapshot(dir)
    assert.ok(got, "任意一次写完都必须可读")
    assert.ok(variants.some((v) => v.updated === got!.updated))
    const files = await readdir(dir)
    assert.deepEqual(files, [".snapshot.json"], "临时文件已被 rename 消费")
  })
})

describe("aggregate 持久化", () => {
  test("往返保留聚合与游标", async () => {
    const dir = path.join(root, "d")
    const agg = emptyAggregates()
    record(agg, {
      ts: 1,
      date: "2026-09-26",
      tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5 },
      cost: 0.5,
      ok: true,
      kind: "primary",
    })
    const data = { schema: 1, aggregates: agg, cursors: { "2026-09/ses_a.jsonl": 123 }, sessionDirs: { ses_a: "2026-09" } }
    assert.equal(await writeAggregate(dir, data), true)
    const got = await readAggregate(dir)
    assert.deepEqual(got, data)
    assert.deepEqual(snapshotOf(got!.aggregates, "2026-09-26", "2026-09").today.steps, 1)
  })

  test("schema 版本不符时丢弃（返回 null 重建）", async () => {
    const dir = path.join(root, "e")
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, ".aggregate.json"),
      JSON.stringify({ schema: 999, aggregates: emptyAggregates(), cursors: {} }),
      "utf8",
    )
    assert.equal(await readAggregate(dir), null)
  })

  test("文件缺失或损坏返回 null", async () => {
    assert.equal(await readAggregate(path.join(root, "f")), null)
    const dir = path.join(root, "g")
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, ".aggregate.json"), "not json", "utf8")
    assert.equal(await readAggregate(dir), null)
  })
})

describe("selectSessions", () => {
  const bucket = (last_ts: number, parent_id: string | null = null) => ({
    ...emptyBucket(),
    last_ts,
    parent_id,
    title: "t",
    provider_id: "p",
    model_id: "m",
    model_name: "M",
    variant: null,
    agent: "build",
    step_index: 0,
    recent: [],
  })

  test("字段按 snake_case 平铺，货币标签统一填入", () => {
    const got = selectSessions({ ses_a: bucket(100) }, "¥")
    assert.deepEqual(got.ses_a, {
      session_id: "ses_a",
      session_title: "t",
      parent_id: null,
      last_ts: 100,
      steps: 0,
      ok: 0,
      error: 0,
      input: 0,
      cache_read: 0,
      cache_write: 0,
      output: 0,
      reasoning: 0,
      cost: 0,
      currency: "¥",
      provider_id: "p",
      model_id: "m",
      model_name: "M",
      variant: null,
      agent: "build",
      recent: [],
    })
  })

  test("按 last_ts 倒序截断到上限", () => {
    const sessions = {
      ses_old: bucket(1),
      ses_new: bucket(9),
      ses_mid: bucket(5),
      ses_new2: bucket(9), // 同秒，按 id 稳定排序
    }
    const got = selectSessions(sessions, "$", 2)
    const ids = Object.keys(got)
    assert.equal(ids.length, 2)
    assert.deepEqual(ids.sort(), ["ses_new", "ses_new2"])
  })

  test("空桶返回空对象", () => {
    assert.deepEqual(selectSessions({}, "$"), {})
  })

  // ── M5/A1：选中粒度必须是"整棵树"，否则子树要么算漏、要么整片变 — ──

  /** 带用量的桶，便于断言子树合计而不是只看 id 在不在。 */
  const busy = (last_ts: number, parent_id: string | null = null, steps = 1) => ({
    ...bucket(last_ts, parent_id),
    steps,
    ok: steps,
  })

  test("父会话比子会话旧时，整棵树一起进快照", () => {
    const sessions = {
      ses_root: busy(1, null, 3),
      ses_child: busy(100, "ses_root", 5),
      ses_x: busy(90, null, 1),
      ses_y: busy(80, null, 1),
    }
    // 按 last_ts 逐个截断只会留 {ses_child, ses_x}，父会话被挤掉 → 面板整片显示 —
    const got = selectSessions(sessions, "$", 2)
    assert.deepEqual(Object.keys(got).sort(), ["ses_child", "ses_root"])
  })

  test("子会话更旧时不被父会话挤掉（子树合计不偏低）", () => {
    const sessions = {
      ses_root: busy(100, null, 3),
      ses_child: busy(1, "ses_root", 5), // 最旧，逐个截断必被丢
      ses_x: busy(90, null, 1),
      ses_y: busy(80, null, 1),
    }
    const got = selectSessions(sessions, "$", 2)
    assert.deepEqual(Object.keys(got).sort(), ["ses_child", "ses_root"])
    // 断言的是"合计没错"：漏掉 ses_child 的话会只剩 3 步
    assert.equal(subtreeBucketOf(got, "ses_root").steps, 8)
  })

  test("选中的会话必然连带整条父链与全部后代", () => {
    const sessions: Record<string, ReturnType<typeof bucket>> = {}
    // 主树：根 + 3 层子会话
    sessions.ses_root = bucket(800, null)
    sessions.ses_a = bucket(5, "ses_root")
    sessions.ses_b = bucket(4, "ses_a")
    sessions.ses_c = bucket(3, "ses_b")
    sessions.ses_d = bucket(190, "ses_root")
    // 两棵比主树更新的独立会话，再加一批更旧的，逼出截断
    sessions.ses_n901 = bucket(901, null)
    sessions.ses_n900 = bucket(900, null)
    for (let i = 0; i < 40; i++) sessions[`ses_o${i}`] = bucket(50 + i, null)

    const keep = new Set(selectedSessionIds(sessions, 10))
    for (const id of keep) {
      let p = sessions[id]!.parent_id
      while (p !== null && sessions[p]) {
        assert.ok(keep.has(p), `${id} 的父 ${p} 也被选中`)
        p = sessions[p]!.parent_id
      }
      for (const [other, b] of Object.entries(sessions)) {
        if (b.parent_id === id) assert.ok(keep.has(other), `${other} 是 ${id} 的后代`)
      }
    }
    // 5 个主树成员 + 5 个独立会话 = 10，主树没被拆开
    assert.equal(keep.size, 10)
    for (const id of ["ses_root", "ses_a", "ses_b", "ses_c", "ses_d"]) {
      assert.ok(keep.has(id), `${id} 必须在快照里`)
    }
  })

  test("整棵树大过上限也整棵进（上限是软的）", () => {
    const sessions: Record<string, ReturnType<typeof bucket>> = {
      ses_root: bucket(100, null),
    }
    for (let i = 0; i < 5; i++) sessions[`ses_k${i}`] = bucket(100, "ses_root")
    assert.equal(selectedSessionIds(sessions, 2).length, 6)
  })

  test("父会话从没写过用量行时，子会话自成一棵树", () => {
    const sessions = { ses_child: bucket(5, "ses_never_wrote") }
    assert.deepEqual(selectedSessionIds(sessions, 10), ["ses_child"])
  })

  test("parent_id 成环不抛异常，且结果仍然完整", () => {
    const sessions = {
      ses_a: bucket(1, "ses_b"),
      ses_b: bucket(2, "ses_a"),
    }
    assert.deepEqual(selectedSessionIds(sessions, 10).sort(), ["ses_a", "ses_b"])
  })
})
