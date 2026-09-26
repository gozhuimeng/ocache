/**
 * 快照文件：服务端插件 → TUI 的单向通道（REQUIREMENTS §2）。
 *
 * 原子写：先写临时文件再 rename，读方永远不会看到半截 JSON。
 * 快照是可丢弃的派生数据，读失败一律返回 null，由调用方降级显示。
 */

import { readFile, rename, rm, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import type { Aggregates } from "./aggregate.ts"

/** 当前会话的实时块（服务端每步更新）。 */
export interface SessionSnapshot {
  readonly session_id: string
  readonly session_title: string | null
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
}

export interface Snapshot {
  readonly schema: number
  readonly updated: number
  readonly record: boolean
  readonly currency: string
  readonly session: SessionSnapshot | null
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
    return s as AggregateFile
  } catch {
    return null
  }
}
