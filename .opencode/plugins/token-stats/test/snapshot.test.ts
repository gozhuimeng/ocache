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
  SNAPSHOT_SCHEMA,
} from "../shared/snapshot.ts"
import { emptyAggregates, record, snapshotOf } from "../shared/aggregate.ts"
import type { Snapshot } from "../shared/snapshot.ts"

let root = ""

before(async () => {
  await mkdir("/tmp/opencode", { recursive: true })
  root = await mkdtemp(path.join("/tmp/opencode", "token-stats-snap-"))
})

after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

const snap: Snapshot = {
  schema: SNAPSHOT_SCHEMA,
  updated: 1,
  record: true,
  currency: "¥",
  session: null,
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
