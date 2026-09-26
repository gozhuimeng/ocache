/**
 * 插件选项解析（REQUIREMENTS §3.1）。
 *
 * 全部配置只来自 opencode.json(c) 的 plugins[].options，不做交互式编辑（D4/D5）。
 * 解析必须容错：字段类型不对就回落默认值，绝不因配置错误让插件挂掉。
 */

import type { BillingConfig } from "./billing.ts"
import type { Price } from "./schema.ts"

export interface PluginConfig extends BillingConfig {
  /** 是否写 JSONL 文件；false 时面板照常工作（只走内存聚合）。 */
  readonly record: boolean
  /** 缓冲静默多久后落盘（ms）。 */
  readonly flushAgeMs: number
  /** 缓冲行数上限。 */
  readonly flushRows: number
  /** 缓冲字节上限。 */
  readonly flushBytes: number
  /** 所有缓冲合计内存上限（字节）。 */
  readonly memoryCapBytes: number
  /** 聚合与快照的持久化周期（ms）。 */
  readonly persistMs: number
  /** TUI 快照刷新周期（ms）。 */
  readonly snapshotMs: number
  /** 老月份目录保留天数；0 = 不清理。 */
  readonly retentionDays: number
}

const PRICE_KEYS: ReadonlyArray<keyof Price> = ["input", "cacheRead", "cacheWrite", "output"]

export const DEFAULT_CONFIG: PluginConfig = {
  record: true,
  currency: "$",
  useModelPrice: false,
  prices: {},
  flushAgeMs: 30_000,
  flushRows: 100,
  flushBytes: 64 * 1024,
  memoryCapBytes: 5 * 1024 * 1024,
  persistMs: 30_000,
  snapshotMs: 1_000,
  retentionDays: 180,
}

function num(v: unknown, fallback: number, min = 0): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 && v.length <= 32 ? v : fallback
}

/** 解析 options 对象；任何异常路径都返回默认配置。 */
export function parseConfig(options: unknown): PluginConfig {
  const o = (typeof options === "object" && options !== null ? options : {}) as Record<string, unknown>
  const raw = typeof o.prices === "object" && o.prices !== null ? (o.prices as Record<string, unknown>) : {}
  const prices: Partial<Record<keyof Price, number | null>> = {}
  for (const key of PRICE_KEYS) {
    const v = raw[key]
    // null 显式表示"该项回落模型价"，与缺省同义，但保留显式语义
    if (v === null) prices[key] = null
    else if (typeof v === "number" && Number.isFinite(v) && v >= 0) prices[key] = v
  }
  return {
    record: bool(o.record, DEFAULT_CONFIG.record),
    currency: str(o.currency, DEFAULT_CONFIG.currency),
    useModelPrice: bool(o.useModelPrice, DEFAULT_CONFIG.useModelPrice),
    prices,
    flushAgeMs: num(o.flushAgeMs, DEFAULT_CONFIG.flushAgeMs, 1),
    flushRows: num(o.flushRows, DEFAULT_CONFIG.flushRows, 1),
    flushBytes: num(o.flushBytes, DEFAULT_CONFIG.flushBytes, 1),
    memoryCapBytes: num(o.memoryCapBytes, DEFAULT_CONFIG.memoryCapBytes, 1024),
    persistMs: num(o.persistMs, DEFAULT_CONFIG.persistMs, 1_000),
    snapshotMs: num(o.snapshotMs, DEFAULT_CONFIG.snapshotMs, 100),
    retentionDays: num(o.retentionDays, DEFAULT_CONFIG.retentionDays),
  }
}
