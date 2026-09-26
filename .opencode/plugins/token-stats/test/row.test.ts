import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { buildRow, pickModelCost, rowTokens, rowMonth } from "../shared/row.ts"
import { parseConfig, DEFAULT_CONFIG } from "../shared/config.ts"
import { computeCost } from "../shared/billing.ts"

const session = {
  session_id: "ses_x",
  session_title: "标题",
  parent_id: null,
  project: "/home/meng/Project/ocache",
}

const price = { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 8 }

function base(over: Partial<Parameters<typeof buildRow>[0]> = {}) {
  return {
    ts: Date.UTC(2026, 8, 26, 8, 30), // 本地时区下 2026-09-26（UTC+8 为 16:30）
    session,
    step_index: 3,
    provider_id: "opencode",
    model_id: "mimo-v2.6-flash-free",
    model_name: "MiMo Flash",
    variant: null,
    agent: "build",
    kind: "primary" as const,
    finish: "tool-calls",
    status: "ok" as const,
    error_type: null,
    error_status: null,
    tokens: { input: 100, cacheRead: 900, cacheWrite: 50, output: 20, reasoning: 5 },
    currency: "¥",
    price,
    ...over,
  }
}

describe("buildRow", () => {
  test("五档、总和、成本与派生时间键齐全", () => {
    const r = buildRow(base())
    assert.equal(r.type, "step")
    assert.equal(r.schema, 1)
    assert.equal(r.input, 100)
    assert.equal(r.cache_read, 900)
    assert.equal(r.cache_write, 50)
    assert.equal(r.output, 20)
    assert.equal(r.reasoning, 5)
    assert.equal(r.tokens_total, 1075)
    assert.equal(r.cost, computeCost({ input: 100, cacheRead: 900, cacheWrite: 50, output: 20, reasoning: 5 }, price))
    assert.equal(r.date.length, 10)
    assert.match(r.hour, /^\d{4}-\d{2}-\d{2}T\d{2}$/)
    assert.equal(r.currency, "¥")
    assert.deepEqual(r.price, price)
    assert.equal(r.dist, null)
    assert.equal(r.parent_id, null)
    assert.equal(r.project, "/home/meng/Project/ocache")
    assert.equal(r.error_type, null)
    assert.equal(r.error_status, null)
  })

  test("status=error 且 tokens/cost 缺省 → 数值列写 0，不写 null", () => {
    const r = buildRow(base({ status: "error", tokens: undefined, error_type: "rate_limit", error_status: 429 }))
    for (const k of ["input", "cache_read", "cache_write", "output", "reasoning", "tokens_total", "cost"] as const) {
      assert.equal(typeof r[k], "number", `${k} 必须是 number`)
      assert.ok(Number.isFinite(r[k]), `${k} 必须有限`)
    }
    assert.equal(r.tokens_total, 0)
    assert.equal(r.cost, 0)
    assert.equal(r.status, "error")
    assert.equal(r.error_type, "rate_limit")
    assert.equal(r.error_status, 429)
  })

  test("部分 token 缺省按 0 补齐", () => {
    const r = buildRow(base({ tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 } }))
    assert.equal(r.cache_write, 0)
    assert.equal(r.tokens_total, 10)
  })

  test("负数与 NaN 被归零（保证外部 SUM 不被污染）", () => {
    const r = buildRow(
      base({
        tokens: { input: -5, cacheRead: Number.NaN, cacheWrite: 0, output: 5, reasoning: 0 },
      }),
    )
    assert.equal(r.input, 0)
    assert.equal(r.cache_read, 0)
    assert.equal(r.output, 5)
    assert.equal(r.tokens_total, 5)
  })

  test("rowTokens / rowMonth 与行字段一致", () => {
    const r = buildRow(base())
    assert.deepEqual(rowTokens(r), { input: 100, cacheRead: 900, cacheWrite: 50, output: 20, reasoning: 5 })
    assert.match(rowMonth(r), /^\d{4}-\d{2}$/)
  })
})

describe("pickModelCost", () => {
  const cost = (tier?: { type: "context"; size: number }) => ({
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    ...(tier ? { tier } : {}),
  })

  test("优先无 tier 的基础价", () => {
    const got = pickModelCost([cost({ type: "context", size: 200_000 }), cost()])
    assert.equal(got?.input, 3)
    assert.equal(got?.tier, undefined)
  })

  test("只有分档价时取第一档", () => {
    const got = pickModelCost([cost({ type: "context", size: 200_000 })])
    assert.equal(got?.tier?.size, 200_000)
  })

  test("空数组与缺省返回 undefined（由 resolvePrice 兜底为 0）", () => {
    assert.equal(pickModelCost([]), undefined)
    assert.equal(pickModelCost(undefined), undefined)
    assert.equal(pickModelCost(undefined as never), undefined)
  })
})

describe("parseConfig", () => {
  test("空/非法 options 回落到默认值", () => {
    assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG)
    assert.deepEqual(parseConfig(null), DEFAULT_CONFIG)
    assert.deepEqual(parseConfig("x"), DEFAULT_CONFIG)
    assert.deepEqual(parseConfig({}), DEFAULT_CONFIG)
  })

  test("只接受合法字段，非法值被丢弃", () => {
    const c = parseConfig({
      record: false,
      currency: "credits",
      useModelPrice: true,
      prices: { input: 2, cacheRead: null, cacheWrite: -1, output: "8", bogus: 1 },
      flushRows: 50,
      flushAgeMs: -1,
      flushBytes: "nope",
      memoryCapBytes: 10,
      retentionDays: 30,
    })
    assert.equal(c.record, false)
    assert.equal(c.currency, "credits")
    assert.equal(c.useModelPrice, true)
    assert.equal(c.prices.input, 2)
    assert.equal(c.prices.cacheRead, null)
    assert.equal(c.prices.cacheWrite, undefined) // 负数丢弃
    assert.equal(c.prices.output, undefined) // 字符串丢弃
    assert.equal("bogus" in c.prices, false)
    assert.equal(c.flushRows, 50)
    assert.equal(c.flushAgeMs, DEFAULT_CONFIG.flushAgeMs) // 负数回落
    assert.equal(c.flushBytes, DEFAULT_CONFIG.flushBytes)
    assert.equal(c.memoryCapBytes, DEFAULT_CONFIG.memoryCapBytes) // 低于下限回落
    assert.equal(c.retentionDays, 30)
  })

  test("currency 限制长度，防止超长标签污染每行", () => {
    assert.equal(parseConfig({ currency: "¥" }).currency, "¥")
    assert.equal(parseConfig({ currency: "" }).currency, "$")
    assert.equal(parseConfig({ currency: "x".repeat(64) }).currency, "$")
    assert.equal(parseConfig({ currency: 123 }).currency, "$")
  })
})
