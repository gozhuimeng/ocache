/**
 * 聚合桶：今日 / 本月 / 全部三个口径共用一套累加逻辑。
 *
 * 聚合是**可丢弃的派生数据**（AGENTS.md）：任何时候都能从 JSONL 重建。
 * 派生指标（命中率、成功率）不在这里存，由调用方从本结构计算。
 */

import type { Kind, StepTokens } from "./schema.ts"

export interface Bucket extends StepTokens {
  steps: number
  ok: number
  error: number
  cost: number
}

export interface Aggregates {
  totals: Bucket
  /** YYYY-MM-DD → Bucket */
  daily: Record<string, Bucket>
  /** YYYY-MM → Bucket */
  monthly: Record<string, Bucket>
}

export function emptyBucket(): Bucket {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    steps: 0,
    ok: 0,
    error: 0,
    cost: 0,
  }
}

export function emptyAggregates(): Aggregates {
  return { totals: emptyBucket(), daily: {}, monthly: {} }
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

/**
 * 计入一条 step 记录。
 * @param kind 只有 "primary" 计入（D13 默认口径）
 */
export function record(
  agg: Aggregates,
  input: { date: string; hour?: string; tokens: StepTokens; cost: number; ok: boolean; kind: Kind },
): boolean {
  if (input.kind !== "primary") return false
  addTo(agg.totals, input.tokens, input.cost, input.ok)
  const day = input.date
  const month = day.slice(0, 7)
  ;(agg.daily[day] ??= emptyBucket())
  ;(agg.monthly[month] ??= emptyBucket())
  addTo(agg.daily[day], input.tokens, input.cost, input.ok)
  addTo(agg.monthly[month], input.tokens, input.cost, input.ok)
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

/** 序列化给 TUI 快照（只保留展示需要的字段，控制体积）。 */
export function snapshotOf(agg: Aggregates, today: string, month: string) {
  return {
    totals: agg.totals,
    today: agg.daily[today] ?? emptyBucket(),
    month: agg.monthly[month] ?? emptyBucket(),
  }
}
