/**
 * 快照文件：服务端插件 → TUI 的单向通道（REQUIREMENTS §2）。
 *
 * 原子写：先写临时文件再 rename，读方永远不会看到半截 JSON。
 * 快照是可丢弃的派生数据，读失败一律返回 null，由调用方降级显示。
 */

import { readFile, rename, rm, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { emptyBucket, type Aggregates, type Bucket, type RecentEntry } from "./aggregate.ts"

/** 会话实时块（服务端每步更新；含子会话行以便展示期聚合）。 */
export interface SessionSnapshot {
  readonly session_id: string
  readonly session_title: string | null
  readonly parent_id: string | null
  /** 最近一次写入的时间戳，供 TUI 判定"当前会话"与排序。 */
  readonly last_ts: number
  readonly steps: number
  readonly ok: number
  readonly error: number
  readonly input: number
  readonly cache_read: number
  readonly cache_write: number
  readonly output: number
  readonly reasoning: number
  readonly cost: number
  readonly currency: string
  readonly provider_id: string | null
  readonly model_id: string | null
  readonly model_name: string | null
  readonly variant: string | null
  readonly agent: string | null
  /**
   * 该会话最近两条成功 primary 请求（新→旧），供 TUI 算"本次命中率 + 环比"。
   * 读取端容缺（旧快照没有这个字段），消费方一律 `?? []`。
   */
  readonly recent: readonly RecentEntry[]
}

/** 快照里保留的会话块数量上限（按 last_ts 倒序），控制快照体积。 */
export const SESSIONS_IN_SNAPSHOT = 50

export interface Snapshot {
  readonly schema: number
  readonly updated: number
  readonly record: boolean
  readonly currency: string
  /** 最近活跃的 sessionID；TUI 拿不到自身会话时用它兜底。 */
  readonly last_session_id: string | null
  /** sessionID → 会话块，按最近活跃保留前 N 个。 */
  readonly sessions: Record<string, SessionSnapshot>
  /** 聚合三口径（今日/本月/全部），由 snapshotOf() 产出。 */
  readonly agg: ReturnType<typeof import("./aggregate.ts").snapshotOf> | null
}

export const SNAPSHOT_SCHEMA = 1

export function snapshotPath(baseDir: string): string {
  return path.join(baseDir, ".snapshot.json")
}

/**
 * 原子写快照。失败只记日志（快照是派生数据，丢了能重建），绝不向上抛。
 */
export async function writeSnapshot(
  baseDir: string,
  snap: Snapshot,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  const target = snapshotPath(baseDir)
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await mkdir(baseDir, { recursive: true })
    await writeFile(tmp, JSON.stringify(snap), "utf8")
    await rename(tmp, target)
    return true
  } catch (err) {
    onError?.(err)
    await rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

/** 读快照：任何异常都返回 null（TUI 侧降级为占位显示）。 */
export async function readSnapshot(baseDir: string): Promise<Snapshot | null> {
  try {
    const v: unknown = JSON.parse(await readFile(snapshotPath(baseDir), "utf8"))
    if (typeof v !== "object" || v === null) return null
    const s = v as Partial<Snapshot>
    if (typeof s.updated !== "number") return null
    return s as Snapshot
  } catch {
    return null
  }
}

/** 聚合缓存持久化（D7 的基线），同样是原子写 + 读失败降级。 */
export function aggregatePath(baseDir: string): string {
  return path.join(baseDir, ".aggregate.json")
}

export interface AggregateFile {
  readonly schema: number
  readonly aggregates: Aggregates
  readonly cursors: Record<string, number>
  readonly sessionDirs: Record<string, string>
}

export async function writeAggregate(
  baseDir: string,
  data: AggregateFile,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  const target = aggregatePath(baseDir)
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await mkdir(baseDir, { recursive: true })
    await writeFile(tmp, JSON.stringify(data), "utf8")
    await rename(tmp, target)
    return true
  } catch (err) {
    onError?.(err)
    await rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

export async function readAggregate(baseDir: string): Promise<AggregateFile | null> {
  try {
    const v: unknown = JSON.parse(await readFile(aggregatePath(baseDir), "utf8"))
    if (typeof v !== "object" || v === null) return null
    const s = v as Partial<AggregateFile>
    if (!s.aggregates || typeof s.cursors !== "object") return null
    if (s.schema !== undefined && s.schema !== 1) return null // 版本不符：丢弃重建
    // 读取端容错：旧版缓存没有 aux 字段，补空对象而不是让它 undefined 炸掉对账
    if (!s.aggregates.aux || typeof s.aggregates.aux !== "object") s.aggregates.aux = {}
    if (!s.aggregates.sessions) s.aggregates.sessions = {}
    // 旧缓存没有 recent：补空数组，"本次"退化为无基线（不显示符号），不值得为此全量重建
    for (const b of Object.values(s.aggregates.sessions)) {
      if (!Array.isArray(b.recent)) b.recent = []
    }
    return s as AggregateFile
  } catch {
    return null
  }
}

/**
 * 从聚合桶挑出会话块并截断到上限（按 last_ts 倒序）。
 * 抽成纯函数是为了让"选哪些会话进快照"可脱离 OpenCode 单测。
 */
export function selectSessions(
  sessions: Record<string, import("./aggregate.ts").SessionBucket>,
  currency: string,
  limit: number = SESSIONS_IN_SNAPSHOT,
): Record<string, SessionSnapshot> {
  const out: Record<string, SessionSnapshot> = {}
  const entries = Object.entries(sessions)
    .sort((a, b) => b[1].last_ts - a[1].last_ts || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
  for (const [id, b] of entries) {
    out[id] = {
      session_id: id,
      session_title: b.title,
      parent_id: b.parent_id,
      last_ts: b.last_ts,
      steps: b.steps,
      ok: b.ok,
      error: b.error,
      input: b.input,
      cache_read: b.cacheRead,
      cache_write: b.cacheWrite,
      output: b.output,
      reasoning: b.reasoning,
      cost: b.cost,
      currency,
      provider_id: b.provider_id || null,
      model_id: b.model_id || null,
      model_name: b.model_name,
      variant: b.variant,
      agent: b.agent || null,
      recent: b.recent ?? [],
    }
  }
  return out
}

/**
 * 快照里以 rootID 为根的会话子树（含自身）的 id 列表。
 *
 * 与 `aggregate.subtreeBucket` 同口径（parent_id 反复闭包），但输入是
 * 快照的会话块：TUI 手里只有快照，没有完整 Aggregates（M5）。
 * 找不到 rootID 返回空数组——新建会话还没写过行时的正常状态。
 */
export function subtreeIds(
  sessions: Record<string, SessionSnapshot>,
  rootID: string,
): string[] {
  if (!sessions[rootID]) return []
  const ids = new Set<string>([rootID])
  let grew = true
  while (grew) {
    grew = false
    for (const [id, b] of Object.entries(sessions)) {
      if (ids.has(id)) continue
      if (b.parent_id !== null && ids.has(b.parent_id)) {
        ids.add(id)
        grew = true
      }
    }
  }
  return [...ids]
}

/** 快照侧子树合计：当前会话块显示的就是它（自身 + 全部后代子会话）。 */
export function subtreeBucketOf(
  sessions: Record<string, SessionSnapshot>,
  rootID: string,
): Bucket {
  const out = emptyBucket()
  for (const id of subtreeIds(sessions, rootID)) {
    const b = sessions[id]
    if (!b) continue
    out.input += b.input
    out.cacheRead += b.cache_read
    out.cacheWrite += b.cache_write
    out.output += b.output
    out.reasoning += b.reasoning
    out.steps += b.steps
    out.ok += b.ok
    out.error += b.error
    out.cost += b.cost
  }
  return out
}

/**
 * 快照侧子树"最近两条成功请求"，新→旧。
 *
 * 各会话只留得下自己的最近两条，但子树全局的前二必然落在这个并集里：
 * 若某会话独占全局前二中的两条，那正是它自己最近的两条，已在并集内。
 * 因此取并集按 ts 排序取前二，等价于把子树所有请求排一遍。
 */
export function subtreeRecentOf(
  sessions: Record<string, SessionSnapshot>,
  rootID: string,
): readonly RecentEntry[] {
  const all: RecentEntry[] = []
  for (const id of subtreeIds(sessions, rootID)) {
    const recent = sessions[id]?.recent
    if (recent) all.push(...recent)
  }
  all.sort((a, b) => b.ts - a.ts)
  return all.slice(0, 2)
}

/** 服务端还没发布过快照时的占位（TUI 初始值），字段齐全避免到处判空。 */
export function emptySnapshot(currency = ""): Snapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    updated: 0,
    record: false,
    currency,
    last_session_id: null,
    sessions: {},
    agg: null,
  }
}

/**
 * 读取端容错：RPC 回包只校验顶层结构，字段不对就当没数据。
 * 拒绝一个畸形对象比在渲染 getter 里抛异常安全得多（面板降级成占位）。
 */
export function isSnapshot(v: unknown): v is Snapshot {
  if (typeof v !== "object" || v === null) return false
  const s = v as Partial<Snapshot>
  if (typeof s.updated !== "number") return false
  if (typeof s.currency !== "string") return false
  if (typeof s.sessions !== "object" || s.sessions === null) return false
  if (s.agg !== null && s.agg !== undefined && typeof s.agg !== "object") return false
  return true
}
