/**
 * 自定义计费：四档单价。
 *
 * 优先级（REQUIREMENTS §3.1 / D3）：
 *   1. useModelPrice=true  → 四档全部取模型自带 Model.Cost（美元）
 *   2. prices 中某项为数字 → 用自定义价
 *   3. prices 中某项为 null/缺失 → 回落到模型价
 *
 * 公式：cost = Σ(档位用量 × 该档单价) / 1_000_000
 *   output 档覆盖 output + reasoning。
 */

import type { Price, StepTokens } from "./schema.ts"

/** 模型自带价格（USD / 百万 token），来自 Model.Cost。 */
export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface BillingConfig {
  /** true = 忽略 prices，四档全用模型美元价 */
  readonly useModelPrice: boolean
  /** 货币标签，如 "¥"、"$"、"credits" */
  readonly currency: string
  /** 四档自定义价；null = 回落到模型价 */
  readonly prices: Readonly<Partial<Record<keyof Price, number | null>>>
}

export const DEFAULT_BILLING: BillingConfig = {
  useModelPrice: false,
  currency: "$",
  prices: {},
}

/** 兜底价：模型价拿不到时的占位，避免 NaN 污染数值列。 */
const FALLBACK: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * 解析本次请求实际生效的四档单价。
 * 落盘时必须把结果整体快照进 price 字段，价格改了历史不重算。
 */
export function resolvePrice(config: BillingConfig, model: ModelPrice | undefined): Price {
  const m = model ?? FALLBACK
  const p = config.prices
  const pick = (key: keyof Price, modelValue: number): number => {
    if (config.useModelPrice) return modelValue
    const v = p[key]
    return typeof v === "number" && Number.isFinite(v) ? v : modelValue
  }
  return {
    input: pick("input", m.input),
    cacheRead: pick("cacheRead", m.cacheRead),
    cacheWrite: pick("cacheWrite", m.cacheWrite),
    output: pick("output", m.output),
  }
}

/** 结算一行的费用。price 必须是落盘时快照过的那份。 */
export function computeCost(tokens: StepTokens, price: Price): number {
  const raw =
    tokens.input * price.input +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite * price.cacheWrite +
    (tokens.output + tokens.reasoning) * price.output
  const cost = raw / 1_000_000
  // 防御：非有限值会让外部 SUM 整列变 NaN
  return Number.isFinite(cost) ? cost : 0
}

/** 从 Model.Cost 的松散形状提取四档价（容忍 cache 缺失）。 */
export function fromModelCost(cost: unknown): ModelPrice | undefined {
  if (typeof cost !== "object" || cost === null) return undefined
  const c = cost as {
    input?: unknown
    output?: unknown
    cache?: { read?: unknown; write?: unknown }
  }
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  if (typeof c.input !== "number" && typeof c.output !== "number") return undefined
  return {
    input: num(c.input),
    output: num(c.output),
    cacheRead: num(c.cache?.read),
    cacheWrite: num(c.cache?.write),
  }
}
