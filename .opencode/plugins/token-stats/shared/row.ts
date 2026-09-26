/**
 * 事件 → 主表行的纯构造逻辑（REQUIREMENTS §5.2）。
 *
 * 不依赖 OpenCode 运行时：入参是已核实的事件字段（见 node_modules 内类型定义），
 * 出参是可直接 JSON.stringify 的 StepRow。
 */

import {
  SCHEMA_VERSION,
  STEP_TYPE,
  totalTokens,
  toDate,
  toHour,
  toMonthDir,
  type Kind,
  type Price,
  type Status,
  type StepRow,
  type StepTokens,
} from "./schema.ts"
import { computeCost, type ModelPrice } from "./billing.ts"

/** Model.Cost 数组元素（@opencode/schema：cost 是数组，每项可带 context tier）。 */
export interface ModelCostEntry extends ModelPrice {
  readonly tier?: { readonly type: "context"; readonly size: number }
}

/**
 * 从 Model.Cost 数组挑一档。
 * 优先无 tier 的基础价；只有分档价时取第一档。
 * tier 依赖会话上下文长度，此处不做推断——需要精确值请用 options.prices 覆盖（D3）。
 */
export function pickModelCost(costs: readonly ModelCostEntry[] | undefined): ModelCostEntry | undefined {
  if (!Array.isArray(costs) || costs.length === 0) return undefined
  const base = costs.find((c) => c.tier === undefined)
  return base ?? costs[0]
}

export interface SessionMeta {
  readonly session_id: string
  readonly session_title: string | null
  readonly parent_id: string | null
  readonly project: string | null
}

export interface StepInput {
  readonly ts: number
  readonly session: SessionMeta
  readonly step_index: number
  readonly provider_id: string
  readonly model_id: string
  readonly model_name: string | null
  readonly variant: string | null
  readonly agent: string
  readonly kind: Kind
  readonly finish: string | null
  readonly status: Status
  readonly error_type: string | null
  readonly error_status: number | null
  /** 源字段可缺省（step.failed 的 tokens/cost 为 optional），缺省按 0 处理。 */
  readonly tokens?: StepTokens | undefined
  readonly currency: string
  readonly price: Price
}

/**
 * 构造一行。约定：
 * - 数值列永远是有限 number（缺省 0），保证外部 SUM 不会变 NaN。
 * - `dist` 恒为 null，等分布估算模块上线（D14）。
 */
export function buildRow(input: StepInput): StepRow {
  const t: StepTokens = {
    input: input.tokens?.input ?? 0,
    cacheRead: input.tokens?.cacheRead ?? 0,
    cacheWrite: input.tokens?.cacheWrite ?? 0,
    output: input.tokens?.output ?? 0,
    reasoning: input.tokens?.reasoning ?? 0,
  }
  const clean = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
  const tokens: StepTokens = {
    input: clean(t.input),
    cacheRead: clean(t.cacheRead),
    cacheWrite: clean(t.cacheWrite),
    output: clean(t.output),
    reasoning: clean(t.reasoning),
  }
  return {
    type: STEP_TYPE,
    schema: SCHEMA_VERSION,
    ts: input.ts,
    date: toDate(input.ts),
    hour: toHour(input.ts),
    session_id: input.session.session_id,
    session_title: input.session.session_title,
    parent_id: input.session.parent_id,
    project: input.session.project,
    step_index: input.step_index,
    provider_id: input.provider_id,
    model_id: input.model_id,
    model_name: input.model_name,
    variant: input.variant,
    agent: input.agent,
    kind: input.kind,
    finish: input.finish,
    status: input.status,
    error_type: input.error_type,
    error_status: input.error_status,
    input: tokens.input,
    cache_read: tokens.cacheRead,
    cache_write: tokens.cacheWrite,
    output: tokens.output,
    reasoning: tokens.reasoning,
    tokens_total: totalTokens(tokens),
    currency: input.currency,
    price: input.price,
    cost: computeCost(tokens, input.price),
    dist: null,
  }
}

/** 行 → 聚合入参所需的用量五档。 */
export function rowTokens(row: StepRow): StepTokens {
  return {
    input: row.input,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    output: row.output,
    reasoning: row.reasoning,
  }
}

/** 行的归档月份（首次写入时固定，见 §5.1）。 */
export function rowMonth(row: StepRow): string {
  return toMonthDir(row.ts)
}
