/**
 * 数据 schema 定义 —— JSONL 主表一行 = 一次模型请求（一步）。
 *
 * 写入端规则（AGENTS.md）：
 *   - 字段只增不改不删；破坏性变更提升 SCHEMA_VERSION。
 *   - 数值一律 number，不用字符串。
 *   - 会影响历史数值的配置（price/currency）随行落盘。
 *
 * 读取端规则：
 *   - 忽略未知字段（向前兼容）、跳过无法解析的行。
 */

/** 当前写入的 schema 版本。首次实现即为 1。 */
export const SCHEMA_VERSION = 1

/** meta 头行的 type 值（每个文件首行一条）。 */
export const META_TYPE = "meta" as const

/** 数据行的 type 值。将来追加行类型（如 "tool"）在此扩展。 */
export const STEP_TYPE = "step" as const

/**
 * 请求性质，来自 http.response 钩子的 event.kind。
 * 统计默认只纳入 "primary"，其余照常落盘由查询端决定。
 */
export type Kind = "primary" | "compaction" | "title" | "generate"

/** 请求成败，来自 session.step.ended（ok）/ session.step.failed（error）。 */
export type Status = "ok" | "error"

/**
 * 四档单价的键名。
 * 单位 = 每百万 token；output 档覆盖 output + reasoning。
 */
export interface Price {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

/**
 * 五档用量（精确值，来源 session.step.ended.tokens）。
 * 注意：status=error 的行来自 step.failed，其源字段为 optional，
 *       落盘时缺省一律写 0，保证数值列可直接 SUM。
 */
export interface StepTokens {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
}

/** 五档之和，冗余存盘便于外部直接 sum。 */
export function totalTokens(t: StepTokens): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output + t.reasoning
}

/**
 * 主表数据行。
 * 全部筛选维度平铺顶层（price 快照除外，duckdb 可用 price->>'input' 取）。
 */
export interface StepRow {
  readonly type: typeof STEP_TYPE
  readonly schema: number

  // ── 时间 ──
  readonly ts: number
  readonly date: string
  readonly hour: string

  // ── 会话维度 ──
  readonly session_id: string
  readonly session_title: string | null
  readonly parent_id: string | null
  readonly project: string | null
  readonly step_index: number

  // ── 模型维度 ──
  readonly provider_id: string
  readonly model_id: string
  readonly model_name: string | null
  readonly variant: string | null
  readonly agent: string

  // ── 请求性质 ──
  readonly kind: Kind
  readonly finish: string | null

  // ── 请求成功率 ──
  readonly status: Status
  readonly error_type: string | null
  readonly error_status: number | null

  // ── 用量（五档精确值）──
  readonly input: number
  readonly cache_read: number
  readonly cache_write: number
  readonly output: number
  readonly reasoning: number
  readonly tokens_total: number

  // ── 计费 ──
  readonly currency: string
  readonly price: Price
  readonly cost: number

  // ── 预留扩展 ──
  readonly dist: unknown
}

/** 每个 jsonl 文件的首行。 */
export interface MetaRow {
  readonly type: typeof META_TYPE
  readonly schema: number
  readonly record: boolean
  readonly price_tag: string
  readonly created: number
}

export type Row = MetaRow | StepRow

export function isStepRow(v: unknown): v is StepRow {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: unknown }).type === STEP_TYPE &&
    typeof (v as { ts?: unknown }).ts === "number" &&
    typeof (v as { session_id?: unknown }).session_id === "string"
  )
}

/** 本地日期 YYYY-MM-DD（时区敏感，用于 GROUP BY）。 */
export function toDate(ts: number, tzOffsetMinutes = -new Date(ts).getTimezoneOffset()): string {
  return new Date(ts + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

/** 小时粒度 YYYY-MM-DDTHH。 */
export function toHour(ts: number, tzOffsetMinutes = -new Date(ts).getTimezoneOffset()): string {
  return new Date(ts + tzOffsetMinutes * 60_000).toISOString().slice(0, 13)
}

/** 归档目录名 YYYY-MM（按 ts）。 */
export function toMonthDir(ts: number, tzOffsetMinutes = -new Date(ts).getTimezoneOffset()): string {
  return new Date(ts + tzOffsetMinutes * 60_000).toISOString().slice(0, 7)
}
