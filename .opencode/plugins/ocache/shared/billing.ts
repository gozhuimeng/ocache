/**
 * 按模型自定义计费：四档单价 + 固定汇率（REQUIREMENTS §3.1 / D28）。
 *
 * 每一档单价按下面的链逐档回落，三段产物都已折成 `currency` 单位：
 *   1. `modelPrices[providerID][modelID][档]` 是合法数字 → 用它
 *   2. 否则用 OpenCode 内部价 `Model.Cost`（美元）× `exchangeRate`
 *   3. 内部也没价 → 0
 *
 * providerID 与 modelID 分开传：同一个 modelID 在不同 provider 下是不同模型
 * （`opencode/mimo-v2.6-flash-free` 与 `Local/...` 不能共享一份价目）。
 *
 * 公式：cost = Σ(档位用量 × 该档单价) / 1_000_000
 *   output 档覆盖 output + reasoning。
 *
 * 单价在写入时整体快照进 `price` 字段（含换算后的结果），改配置只影响新数据，
 * 历史不重算。
 */

import type { Price, StepTokens } from "./schema.ts"

/** 模型自带价格（USD / 百万 token），来自 Model.Cost。 */
export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** 单个模型的四档自定义价（单位 = currency）；缺省的档走回落链第 2 段。 */
export type ModelPriceConfig = Partial<Record<keyof Price, number>>

/** `providerID` → `modelID` → 四档价。 */
export type ModelPrices = Readonly<Record<string, Readonly<Record<string, ModelPriceConfig>>>>

export interface BillingConfig {
  /** 货币标签，如 "¥"、"$"、"credits"；每行落盘的 currency 就是它。 */
  readonly currency: string
  /** 1 美元折合多少 currency 单位；内部美元价先乘它再计费。 */
  readonly exchangeRate: number
  /** 按模型的四档自定义价。 */
  readonly modelPrices: ModelPrices
}

export const DEFAULT_BILLING: BillingConfig = {
  currency: "$",
  exchangeRate: 1,
  modelPrices: {},
}

/** 兜底价：模型价拿不到时的占位，避免 NaN 污染数值列。 */
const FALLBACK: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * 解析本次请求实际生效的四档单价。
 * 落盘时必须把结果整体快照进 price 字段，价格改了历史不重算。
 *
 * `model` 是 OpenCode 报上来的内部价（美元）；没有它就当 0（"内部没有就按全 0"）。
 */
export function resolvePrice(
  config: BillingConfig,
  providerID: string,
  modelID: string,
  model: ModelPrice | undefined,
): Price {
  const custom = config.modelPrices[providerID]?.[modelID]
  const m = model ?? FALLBACK
  const rate = config.exchangeRate
  const pick = (key: keyof Price, internal: number): number => {
    const c = custom?.[key]
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c
    const v = internal * rate
    // 防御：rate 或内部价异常时不能让 price 快照变成 Infinity/NaN
    return Number.isFinite(v) ? v : 0
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

/** 从 Model.Cost 的松散形状提取四档价（容忍 cache 缺失）。单位：USD / 百万 token。 */
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
