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

/** 按会话分桶：面板"当前会话"块与子会话聚合的数据来源（D8）。 */
export interface SessionBucket extends Bucket {
  last_ts: number
  parent_id: string | null
  title: string | null
  provider_id: string
  model_id: string
  model_name: string | null
  variant: string | null
  agent: string
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

export interface Aggregates {
  totals: Bucket
  /** YYYY-MM-DD → Bucket */
  daily: Record<string, Bucket>
  /** YYYY-MM → Bucket */
  monthly: Record<string, Bucket>
  /** sessionID → SessionBucket */
  sessions: Record<string, SessionBucket>
}

export function emptyBucket(): Bucket {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, steps: 0, ok: 0, error: 0, cost: 0 }
}

export function emptyAggregates(): Aggregates {
  return { totals: emptyBucket(), daily: {}, monthly: {}, sessions: {} }
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
}

/**
 * 计入一条 step 记录。
 * 非 primary 的请求连同会话桶一并跳过，保证面板与外部统计同口径。
 */
export function record(agg: Aggregates, input: RecordInput): boolean {
  if (input.kind !== "primary") return false
  addTo(agg.totals, input.tokens, input.cost, input.ok)
  const day = input.date
  const month = day.slice(0, 7)
  ;(agg.daily[day] ??= emptyBucket())
  ;(agg.monthly[month] ??= emptyBucket())
  addTo(agg.daily[day], input.tokens, input.cost, input.ok)
  addTo(agg.monthly[month], input.tokens, input.cost, input.ok)

  const id = input.session_id
  const s = input.session
  if (id && s) {
    const b = (agg.sessions[id] ??= {
      ...emptyBucket(),
      last_ts: input.ts,
      parent_id: s.parent_id,
      title: s.title,
      provider_id: s.provider_id,
      model_id: s.model_id,
      model_name: s.model_name,
      variant: s.variant,
      agent: s.agent,
    })
    addTo(b, input.tokens, input.cost, input.ok)
    if (input.ts > b.last_ts) b.last_ts = input.ts
    // 归属信息取最新一步的快照（rename / 换模型后不再停留在旧值）
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

/** 命中率 = cacheRead / (input + cacheRead + cacheWrite)；无输入时为 0。 */
export function hitRate(t: StepTokens): number {
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
