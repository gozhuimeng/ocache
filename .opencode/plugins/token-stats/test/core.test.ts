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
    assert.equal(record(agg, { date: "2026-09-26", tokens, cost: 1, ok: true, kind: "primary" }), true)
    assert.equal(record(agg, { date: "2026-09-26", tokens, cost: 1, ok: true, kind: "title" }), false)
    assert.equal(record(agg, { date: "2026-09-26", tokens, cost: 1, ok: false, kind: "compaction" }), false)
    assert.equal(agg.totals.steps, 1)
    assert.equal(agg.totals.cost, 1)
  })

  test("今日/本月/全部三个口径同步累加", () => {
    const agg = emptyAggregates()
    record(agg, { date: "2026-09-26", tokens, cost: 0.5, ok: true, kind: "primary" })
    record(agg, { date: "2026-09-26", tokens, cost: 0.25, ok: false, kind: "primary" })
    record(agg, { date: "2026-09-20", tokens, cost: 2, ok: true, kind: "primary" })
    record(agg, { date: "2026-08-31", tokens, cost: 4, ok: true, kind: "primary" })

    assert.equal(agg.totals.steps, 4)
    assert.equal(agg.totals.cost, 6.75)
    assert.equal(agg.daily["2026-09-26"].steps, 2)
    assert.equal(agg.daily["2026-09-26"].cost, 0.75)
    assert.equal(agg.monthly["2026-09"].steps, 3)
    assert.equal(agg.monthly["2026-09"].cost, 2.75)
    assert.equal(agg.monthly["2026-08"].steps, 1)

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
    record(agg, { date: "2026-09-26", tokens, cost: 1, ok: true, kind: "primary" })
    record(agg, { date: "2026-09-26", tokens, cost: 1, ok: true, kind: "primary" })
    record(agg, { date: "2026-09-26", tokens, cost: 1, ok: false, kind: "primary" })
    assert.equal(successRate(agg.totals), 2 / 3)
    assert.equal(successRate(emptyAggregates().totals), 0)
  })

  test("聚合可从空完全重建（派生数据语义）", () => {
    const a = emptyAggregates()
    const b = emptyAggregates()
    for (const date of ["2026-01-01", "2026-09-26"]) {
      record(a, { date, tokens, cost: 1, ok: true, kind: "primary" })
      record(b, { date, tokens, cost: 1, ok: true, kind: "primary" })
    }
    assert.deepEqual(a, b)
  })
})
