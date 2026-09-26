import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  SCHEMA_VERSION,
  STEP_TYPE,
  totalTokens,
  toDate,
  toHour,
  toMonthDir,
  isStepRow,
} from "../shared/schema.ts"
import { resolvePrice, computeCost, fromModelCost, DEFAULT_BILLING } from "../shared/billing.ts"
import {
  emptyAggregates,
  record,
  hitRate,
  successRate,
  snapshotOf,
  subtreeBucket,
  seedStepCounters,
} from "../shared/aggregate.ts"

const tokens = { input: 100_000, cacheRead: 900_000, cacheWrite: 50_000, output: 20_000, reasoning: 5_000 }

describe("schema", () => {
  test("五档之和", () => {
    assert.equal(totalTokens(tokens), 1_075_000)
    assert.equal(totalTokens({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }), 0)
  })

  test("日期键按本地时区派生", () => {
    const ts = Date.UTC(2026, 8, 26, 16, 30) // 2026-09-26T16:30Z
    const off = 8 * 60 // UTC+8
    assert.equal(toDate(ts, off), "2026-09-27") // 本地已是 27 日
    assert.equal(toHour(ts, off), "2026-09-27T00")
    assert.equal(toMonthDir(ts, off), "2026-09")
    assert.equal(toDate(ts, 0), "2026-09-26")
    assert.equal(toMonthDir(ts, 0), "2026-09")
  })

  test("isStepRow 只认真正的数据行", () => {
    const row = { type: STEP_TYPE, ts: 1, session_id: "ses_a", schema: SCHEMA_VERSION }
    assert.equal(isStepRow(row), true)
    assert.equal(isStepRow({ type: "meta", ts: 1, session_id: "ses_a" }), false)
    assert.equal(isStepRow({ type: STEP_TYPE, session_id: "ses_a" }), false)
    assert.equal(isStepRow(null), false)
    assert.equal(isStepRow("x"), false)
  })
})

describe("billing", () => {
  const model = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

  test("useModelPrice=true 时忽略自定义价", () => {
    const p = resolvePrice({ useModelPrice: true, currency: "¥", prices: { input: 999 } }, model)
    assert.deepEqual(p, model)
  })

  test("单项为 null 回落到模型价，其余用自定义价", () => {
    const p = resolvePrice(
      { useModelPrice: false, currency: "¥", prices: { input: 2, output: 8, cacheRead: null } },
      model,
    )
    assert.equal(p.input, 2)
    assert.equal(p.output, 8)
    assert.equal(p.cacheRead, 0.3) // 回落
    assert.equal(p.cacheWrite, 3.75) // 未配置 → 回落
  })

  test("模型价缺失时用 0 兜底，不产生 NaN", () => {
    const p = resolvePrice(DEFAULT_BILLING, undefined)
    assert.deepEqual(p, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    assert.equal(computeCost(tokens, p), 0)
  })

  test("useModelPrice=false 且完全无配置 → 全 0", () => {
    const p = resolvePrice(DEFAULT_BILLING, undefined)
    assert.ok(Number.isFinite(computeCost(tokens, p)))
  })

  test("计费公式：output 档覆盖 output + reasoning，除以百万", () => {
    const p = { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 8 }
    // 100000*2 + 900000*0.2 + 50000*2.5 + (20000+5000)*8 = 200000+180000+125000+200000 = 705000
    assert.equal(computeCost(tokens, p), 705_000 / 1_000_000)
    assert.equal(computeCost(tokens, p), 0.705)
  })

  test("自定义标签不影响数值", () => {
    const p = resolvePrice({ useModelPrice: false, currency: "credits", prices: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 } }, model)
    const cost = computeCost(tokens, p)
    // 1_075_000 * 1000 / 1e6 = 1075
    assert.equal(cost, 1075)
  })

  test("fromModelCost 容忍松散形状", () => {
    assert.deepEqual(
      fromModelCost({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }),
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    )
    assert.deepEqual(fromModelCost({ input: 3, output: 15 }), {
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    })
    assert.equal(fromModelCost(null), undefined)
    assert.equal(fromModelCost(undefined), undefined)
  })
})

describe("aggregate", () => {
  test("只统计 primary，其他 kind 不计入", () => {
    const agg = emptyAggregates()
    assert.equal(record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 1, ok: true, kind: "primary" }), true)
    assert.equal(record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 1, ok: true, kind: "title" }), false)
    assert.equal(record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 1, ok: false, kind: "compaction" }), false)
    assert.equal(agg.totals.steps, 1)
    assert.equal(agg.totals.cost, 1)
  })

  test("今日/本月/全部三个口径同步累加", () => {
    const agg = emptyAggregates()
    record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 0.5, ok: true, kind: "primary" })
    record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 0.25, ok: false, kind: "primary" })
    record(agg, { ts: 1, date: "2026-09-20", tokens, cost: 2, ok: true, kind: "primary" })
    record(agg, { ts: 1, date: "2026-08-31", tokens, cost: 4, ok: true, kind: "primary" })

    assert.equal(agg.totals.steps, 4)
    assert.equal(agg.totals.cost, 6.75)
    assert.equal(agg.daily["2026-09-26"]!.steps, 2)
    assert.equal(agg.daily["2026-09-26"]!.cost, 0.75)
    assert.equal(agg.monthly["2026-09"]!.steps, 3)
    assert.equal(agg.monthly["2026-09"]!.cost, 2.75)
    assert.equal(agg.monthly["2026-08"]!.steps, 1)

    const snap = snapshotOf(agg, "2026-09-26", "2026-09")
    assert.equal(snap.today.steps, 2)
    assert.equal(snap.month.steps, 3)
    assert.equal(snap.totals.steps, 4)
  })

  test("缺失日期返回空桶而非 undefined", () => {
    const agg = emptyAggregates()
    const snap = snapshotOf(agg, "2099-01-01", "2099-01")
    assert.equal(snap.today.steps, 0)
    assert.equal(snap.month.steps, 0)
  })

  test("命中率与成功率", () => {
    assert.equal(hitRate(tokens), 900_000 / 1_050_000)
    assert.equal(hitRate({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }), 0)

    const agg = emptyAggregates()
    record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 1, ok: true, kind: "primary" })
    record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 1, ok: true, kind: "primary" })
    record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 1, ok: false, kind: "primary" })
    assert.equal(successRate(agg.totals), 2 / 3)
    assert.equal(successRate(emptyAggregates().totals), 0)
  })

  test("聚合可从空完全重建（派生数据语义）", () => {
    const a = emptyAggregates()
    const b = emptyAggregates()
    for (const date of ["2026-01-01", "2026-09-26"]) {
      record(a, { ts: 1, date, tokens, cost: 1, ok: true, kind: "primary" })
      record(b, { ts: 1, date, tokens, cost: 1, ok: true, kind: "primary" })
    }
    assert.deepEqual(a, b)
  })

  const sinfo = (parent: string | null) => ({
    parent_id: parent,
    title: "t",
    provider_id: "p",
    model_id: "m",
    model_name: "M",
    variant: null,
    agent: "build",
  })

  test("带 session 时按会话分桶，归属取最新一步", () => {
    const agg = emptyAggregates()
    record(agg, {
      ts: 100,
      date: "2026-09-26",
      tokens,
      cost: 1,
      ok: true,
      kind: "primary",
      session_id: "ses_a",
      session: { ...sinfo(null), title: "旧标题", model_id: "old" },
    })
    record(agg, {
      ts: 200,
      date: "2026-09-26",
      tokens,
      cost: 2,
      ok: false,
      kind: "primary",
      session_id: "ses_a",
      session: sinfo(null),
    })
    const b = agg.sessions["ses_a"]!
    assert.equal(b.steps, 2)
    assert.equal(b.ok, 1)
    assert.equal(b.error, 1)
    assert.equal(b.cost, 3)
    assert.equal(b.last_ts, 200)
    assert.equal(b.title, "t")
    assert.equal(b.model_id, "m")
    // 会话桶合计必须与 totals 一致
    assert.equal(b.cost, agg.totals.cost)
    assert.equal(b.steps, agg.totals.steps)
  })

  test("非 primary 只占位会话桶，用量一律不计入", () => {
    const agg = emptyAggregates()
    assert.equal(
      record(agg, { ts: 1, date: "2026-09-26", tokens, cost: 1, ok: true, kind: "title", session_id: "ses_a", session: sinfo(null) }),
      false,
    )
    const b = agg.sessions["ses_a"]
    assert.ok(b, "桶要建出来，否则只有辅助请求的会话编号会归 1")
    assert.equal(b.steps, 0)
    assert.equal(b.input, 0)
    assert.equal(b.cost, 0)
    assert.equal(agg.totals.steps, 0)
    assert.equal(agg.totals.cost, 0)
    assert.deepEqual(agg.daily, {})
    assert.deepEqual(agg.monthly, {})
    // 但 token 要记进 aux：它是和 session.usage.updated 对账的依据（shared/aux.ts）
    assert.equal(agg.aux["ses_a"]!.input, tokens.input)
    assert.equal(agg.aux["ses_a"]!.cacheRead, tokens.cacheRead)
    assert.equal(agg.aux["ses_a"]!.cacheWrite, tokens.cacheWrite)
    assert.equal(agg.aux["ses_a"]!.output, tokens.output)
    assert.equal(agg.aux["ses_a"]!.reasoning, tokens.reasoning)
  })

  test("subtreeBucket 聚合整棵子树且不重复计数", () => {
    const agg = emptyAggregates()
    const add = (id: string, parent: string | null, ok: boolean) =>
      record(agg, {
        ts: 1,
        date: "2026-09-26",
        tokens,
        cost: 1,
        ok,
        kind: "primary",
        session_id: id,
        session: sinfo(parent),
      })
    add("root", null, true)
    add("child1", "root", true)
    add("child2", "root", false)
    add("grand", "child1", true)
    add("unrelated", null, true)

    const sub = subtreeBucket(agg, "root")
    assert.equal(sub.steps, 4) // root + child1 + child2 + grand
    assert.equal(sub.cost, 4)
    assert.equal(sub.ok, 3)
    assert.equal(sub.error, 1)
    assert.equal(agg.totals.steps, 5)

    assert.equal(subtreeBucket(agg, "child1").steps, 2)
    assert.equal(subtreeBucket(agg, "grand").steps, 1)
    assert.equal(subtreeBucket(agg, "missing").steps, 0)
  })
})

describe("step_index 续接", () => {
  const session = {
    parent_id: null as string | null,
    title: "t",
    provider_id: "p",
    model_id: "m",
    model_name: "M",
    variant: null as string | null,
    agent: "build",
  }
  const row = (step_index: number, kind: "primary" | "title" = "primary") => ({
    ts: step_index,
    date: "2026-09-26",
    tokens,
    cost: 0,
    ok: true,
    kind,
    session_id: "ses_a",
    session,
    step_index,
  })

  test("会话桶记录见过的最大步号", () => {
    const agg = emptyAggregates()
    record(agg, row(5))
    record(agg, row(3)) // 回放顺序可能乱，取最大值
    record(agg, row(7))
    assert.equal(agg.sessions["ses_a"]!.step_index, 7)
  })

  test("非 primary 行也推进步号，但不计入用量", () => {
    const agg = emptyAggregates()
    record(agg, row(2))
    record(agg, row(9, "title"))
    assert.equal(agg.sessions["ses_a"]!.step_index, 9)
    assert.equal(agg.totals.steps, 1)
  })

  test("首行就是非 primary 时也建桶占位，用量仍不计入", () => {
    const agg = emptyAggregates()
    assert.equal(record(agg, row(1, "title")), false)
    // 桶只为续接 step_index 而建：用量字段必须全是 0
    const b = agg.sessions["ses_a"]
    assert.ok(b)
    assert.equal(b.step_index, 1)
    assert.equal(b.steps, 0)
    assert.equal(b.input, 0)
    assert.equal(agg.totals.steps, 0)
    assert.deepEqual(agg.daily, {})

    // 之后的第一条 primary 行照常把编号往前推
    record(agg, row(2))
    assert.equal(agg.sessions["ses_a"]!.step_index, 2)
    assert.equal(agg.sessions["ses_a"]!.steps, 1)
    assert.equal(agg.totals.steps, 1)
  })

  test("旧缓存里没有 step_index 字段的会话桶也能被后续行推进", () => {
    const agg = emptyAggregates()
    record(agg, row(3))
    // 模拟旧版 .aggregate.json 反序列化出来的桶：压根没这个字段
    Reflect.deleteProperty(agg.sessions["ses_a"]!, "step_index")
    assert.equal(seedStepCounters(agg).get("ses_a"), undefined)

    record(agg, row(6)) // 若直接和 undefined 比较，这里会永远为 false
    assert.equal(agg.sessions["ses_a"]!.step_index, 6)
  })

  test("JSON 往返（聚合缓存落盘再读）后仍能拿到步号", () => {
    const agg = emptyAggregates()
    record(agg, row(4))
    const reloaded = JSON.parse(JSON.stringify(agg)) as typeof agg
    assert.equal(seedStepCounters(reloaded).get("ses_a"), 4)
    // 重载时游标已覆盖全部行 → readSince 返回 0 行，只能靠这里续接
    assert.equal((seedStepCounters(reloaded).get("ses_a") ?? 0) + 1, 5)
  })

  test("旧缓存缺 step_index 字段容忍为 0，未知会话不返回", () => {
    const legacy = JSON.parse(
      JSON.stringify({ sessions: { ses_old: { ...emptyAggregates().totals, last_ts: 1 } } }),
    )
    assert.equal(seedStepCounters(legacy).get("ses_old"), undefined)
    assert.equal(seedStepCounters(emptyAggregates()).size, 0)
  })
})
