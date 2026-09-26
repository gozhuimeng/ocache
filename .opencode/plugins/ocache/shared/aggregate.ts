/**
 * 聚合桶：今日 / 本月 / 全部 + 按会话分桶，共用一套累加逻辑。
 *
 * 聚合是**可丢弃的派生数据**（AGENTS.md）：任何时候都能从 JSONL 重建。
 * 派生指标（命中率、成功率）不在这里存，由调用方从本结构计算。
 */

import type { Kind, StepTokens } from "./schema.ts"

/**
 * 聚合桶。五档字段在此显式声明为可变（StepTokens 的字段是 readonly，
 * 直接继承会让累加赋值报错），结构上仍可赋给 StepTokens。
 */
export interface Bucket {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  steps: number
  ok: number
  error: number
  cost: number
}

/**
 * 一次**成功 primary 请求**的输入侧三档明细。
 *
 * 面板"本次命中率 + 环比"的唯一依据。只存输入侧：命中率的分母就是
 * `input + cacheRead + cacheWrite`，output / reasoning 不参与计算。
 * 存原始值而非比率——派生指标一律在查询端算（AGENTS.md）。
 */
export interface RecentEntry {
  /** 该请求落行的时刻，子树挑"最近两条"时按它排序。 */
  ts: number
  input: number
  cacheRead: number
  cacheWrite: number
}

/** 按会话分桶：面板"当前会话"块与子会话聚合的数据来源（D8）。 */
export interface SessionBucket extends Bucket {
  last_ts: number
  /**
   * 该会话**最近两条**成功 primary 请求，新→旧，至多 2 条。
   *
   * 为什么是 2 条：面板显示的是整棵会话子树的"本次 / 上一次"，而子树聚合
   * 时各会话只有自己的桶。取"各会话最近两条"并集后按 ts 排序取前二，恰好
   * 就是子树全局的前二——若某个会话占了全局前二中的两条，那必然是它自己
   * 最近的两条，已经在并集里了。2 条是这个口径的最小充分集。
   *
   * 只记成功的请求（失败那次的 token 明细不完整，会让环比无意义地暴跌），
   * 因此字段缺失或为空表示该会话还没有可用基线，显示时不带符号。
   */
  recent: RecentEntry[]
  parent_id: string | null
  title: string | null
  provider_id: string
  model_id: string
  model_name: string | null
  variant: string | null
  agent: string
  /**
   * 该会话已见的最大 step_index。
   * 存在这里是为了让插件热重载/进程重启后能续接编号——
   * 否则游标已覆盖全部行、增量同步读不到任何行，编号会从 1 重来。
   */
  step_index: number
}

/** 会话维度的归属信息（来自行本身或 session.get）。 */
export interface SessionInfoLite {
  readonly parent_id: string | null
  readonly title: string | null
  readonly provider_id: string
  readonly model_id: string
  readonly model_name: string | null
  readonly variant: string | null
  readonly agent: string
}

/**
 * 纯 token 累加和（没有 steps / cost 之类的计数字段）。
 * 字段可变：StepTokens 的字段是 readonly，不能直接累加。
 */
export interface TokenSum {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}

export interface Aggregates {
  totals: Bucket
  /** YYYY-MM-DD → Bucket */
  daily: Record<string, Bucket>
  /** YYYY-MM → Bucket */
  monthly: Record<string, Bucket>
  /** sessionID → SessionBucket */
  sessions: Record<string, SessionBucket>
  /**
   * sessionID → 该会话**非 primary** 请求（title / compaction / generate）的 token 和。
   *
   * 不进任何统计桶（面板与外部统计口径都是 primary），只用来和
   * `session.usage.updated` 上报的累计台账对账：差额就是漏记的辅助请求。
   * 重建自 JSONL，因此缓存丢了也能复原（派生数据的硬要求）。
   */
  aux: Record<string, TokenSum>
}

export function emptyBucket(): Bucket {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, steps: 0, ok: 0, error: 0, cost: 0 }
}

export function emptyTokenSum(): TokenSum {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
}

export function emptyAggregates(): Aggregates {
  return { totals: emptyBucket(), daily: {}, monthly: {}, sessions: {}, aux: {} }
}

export function addToTokenSum(sum: TokenSum, t: StepTokens): void {
  sum.input += t.input
  sum.cacheRead += t.cacheRead
  sum.cacheWrite += t.cacheWrite
  sum.output += t.output
  sum.reasoning += t.reasoning
}

function addTo(bucket: Bucket, t: StepTokens, cost: number, ok: boolean): void {
  bucket.input += t.input
  bucket.cacheRead += t.cacheRead
  bucket.cacheWrite += t.cacheWrite
  bucket.output += t.output
  bucket.reasoning += t.reasoning
  bucket.steps += 1
  if (ok) bucket.ok += 1
  else bucket.error += 1
  bucket.cost += cost
}

export interface RecordInput {
  readonly ts: number
  readonly date: string
  readonly tokens: StepTokens
  readonly cost: number
  readonly ok: boolean
  /** 只有 "primary" 计入（D13 默认口径）。 */
  readonly kind: Kind
  readonly session_id?: string
  readonly session?: SessionInfoLite
  /** 本行在会话内的步号，用于续接编号；缺省则不动计数。 */
  readonly step_index?: number
}

/**
 * 计入一条记录。
 *
 * - `kind !== "primary"` 的行**不计入用量**（面板与外部统计同口径），
 *   但会话桶照建、step_index 照记：title / compaction 行也各占一个序号，
 *   否则只有辅助请求的会话在热重载后编号会归 1、与文件脱节。
 * - 归属信息只由 primary 行刷新：辅助请求发生时 session 的 model / title
 *   往往还没定，写进去会把好的归属覆盖成 "unknown"。
 */
export function record(agg: Aggregates, input: RecordInput): boolean {
  const id = input.session_id
  const s = input.session
  // 旧缓存没有 step_index 字段，比较前一律归一为 0（读取端容错）。
  const b =
    id && s
      ? (agg.sessions[id] ??= {
          ...emptyBucket(),
          last_ts: input.ts,
          recent: [],
          parent_id: s.parent_id,
          title: s.title,
          provider_id: s.provider_id,
          model_id: s.model_id,
          model_name: s.model_name,
          variant: s.variant,
          agent: s.agent,
          step_index: 0,
        })
      : undefined
  if (b) {
    if (input.step_index !== undefined && input.step_index > stepIndexOf(b)) b.step_index = input.step_index
    if (input.ts > b.last_ts) b.last_ts = input.ts
  }

  if (input.kind !== "primary") {
    // 辅助请求只累计到 aux（对账用），不进任何统计桶。
    if (id) addToTokenSum((agg.aux[id] ??= emptyTokenSum()), input.tokens)
    return false
  }
  addTo(agg.totals, input.tokens, input.cost, input.ok)
  const day = input.date
  const month = day.slice(0, 7)
  ;(agg.daily[day] ??= emptyBucket())
  ;(agg.monthly[month] ??= emptyBucket())
  addTo(agg.daily[day], input.tokens, input.cost, input.ok)
  addTo(agg.monthly[month], input.tokens, input.cost, input.ok)

  if (b && s) {
    addTo(b, input.tokens, input.cost, input.ok)
    // 本次命中率的基线：只记成功的 primary（失败行的 token 明细不完整）
    if (input.ok) {
      pushRecent(b, {
        ts: input.ts,
        input: input.tokens.input,
        cacheRead: input.tokens.cacheRead,
        cacheWrite: input.tokens.cacheWrite,
      })
    }
    // 归属信息取最新一条 primary 行的快照（rename / 换模型后不再停留在旧值）
    b.parent_id = s.parent_id
    b.title = s.title
    b.provider_id = s.provider_id
    b.model_id = s.model_id
    b.model_name = s.model_name
    b.variant = s.variant
    b.agent = s.agent
  }
  return true
}

/**
 * 按时间倒序插入一条成功请求，只留最近 2 条。
 *
 * 不假设行是按 ts 顺序到达的：全量重建时跨文件的行可能乱序，
 * 排序保证"最近两条"始终是时间意义上的最近两条。
 */
function pushRecent(b: SessionBucket, e: RecentEntry): void {
  b.recent.push(e)
  b.recent.sort((x, y) => y.ts - x.ts)
  if (b.recent.length > 2) b.recent.length = 2
}

/** 会话桶的已见最大步号；旧缓存缺字段时归一为 0。 */
function stepIndexOf(b: SessionBucket): number {
  return typeof b.step_index === "number" && Number.isFinite(b.step_index) ? b.step_index : 0
}

/**
 * 从聚合缓存派生各会话"已见最大步号"，供插件热重载 / 进程重启后续接
 * step_index（AGENTS.md：纯逻辑可脱离 OpenCode 单测）。
 * 旧缓存可能没有 step_index 字段，容忍为 0。
 */
export function seedStepCounters(agg: Aggregates): Map<string, number> {
  const out = new Map<string, number>()
  for (const [id, b] of Object.entries(agg.sessions)) {
    const v = stepIndexOf(b)
    if (v > 0) out.set(id, v)
  }
  return out
}

/**
 * 命中率 = cacheRead / (input + cacheRead + cacheWrite)；无输入时为 0。
 *
 * 入参放宽到只读三档：累计桶（Bucket）与单条请求明细（RecentEntry）
 * 都能直接算，避免为了复用把明细摊成完整 StepTokens。
 */
export function hitRate(t: Pick<StepTokens, "input" | "cacheRead" | "cacheWrite">): number {
  const denom = t.input + t.cacheRead + t.cacheWrite
  return denom > 0 ? t.cacheRead / denom : 0
}

/** 成功率 = ok / (ok + error)；无请求时为 0。 */
export function successRate(b: Bucket): number {
  const denom = b.ok + b.error
  return denom > 0 ? b.ok / denom : 0
}

/** 两个桶求和，结果写入 target（不新建对象）。 */
export function mergeInto(target: Bucket, b: Bucket): void {
  target.input += b.input
  target.cacheRead += b.cacheRead
  target.cacheWrite += b.cacheWrite
  target.output += b.output
  target.reasoning += b.reasoning
  target.steps += b.steps
  target.ok += b.ok
  target.error += b.error
  target.cost += b.cost
}

/**
 * 当前会话及其整棵子树的合计（D8：子会话聚合到父会话）。
 * parent_id 关系只在会话行都已落盘/已见时可靠；行本身带 parent_id，
 * 所以跨重启的历史子会话在重建聚合后同样会被纳入。
 */
export function subtreeBucket(agg: Aggregates, rootID: string): Bucket {
  const out = emptyBucket()
  if (!agg.sessions[rootID]) return out
  // 反复扫描 parent_id 直到不再增长（会话数小，O(n·d) 可接受）
  const ids = new Set<string>([rootID])
  let grew = true
  while (grew) {
    grew = false
    for (const [id, b] of Object.entries(agg.sessions)) {
      if (ids.has(id)) continue
      if (b.parent_id !== null && ids.has(b.parent_id)) {
        ids.add(id)
        grew = true
      }
    }
  }
  for (const id of ids) {
    const b = agg.sessions[id]
    if (b) mergeInto(out, b)
  }
  return out
}

/** 序列化给 TUI 快照（只保留展示需要的字段，控制体积）。 */
export function snapshotOf(agg: Aggregates, today: string, month: string) {
  return {
    totals: agg.totals,
    today: agg.daily[today] ?? emptyBucket(),
    month: agg.monthly[month] ?? emptyBucket(),
  }
}
