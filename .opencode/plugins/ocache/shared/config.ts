/**
 * 插件选项解析（REQUIREMENTS §3.1）。
 *
 * 全部配置只来自 opencode.json(c) 的 plugins[].options，不做交互式编辑（D4/D5）。
 * 解析必须容错：字段类型不对就回落默认值，绝不因配置错误让插件挂掉。
 */

import type { BillingConfig, ModelPriceConfig, ModelPrices } from "./billing.ts"
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
/** providerID / modelID 作为配置键的长度上限，防超长键污染配置对象。 */
const MAX_MODEL_KEY = 256
/** 每层键数量上限：配置是人手写的，超过这个数只可能是畸形输入。 */
const MAX_ENTRIES = 1024

export const DEFAULT_CONFIG: PluginConfig = {
  record: true,
  currency: "$",
  exchangeRate: 1,
  modelPrices: {},
  flushAgeMs: 30_000,
  flushRows: 100,
  flushBytes: 64 * 1024,
  memoryCapBytes: 5 * 1024 * 1024,
  persistMs: 30_000,
  snapshotMs: 250,
  /** 默认不清理：数据自主是本项目的价值主张，磁盘成本远低于历史被抹掉的代价。
   *  显式开启后，被删月份的行会从文件里消失，全量重建时历史合计会相应缩小。 */
  retentionDays: 0,
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

/** 一档价：非负有限数字才算合法，其余（含负数、字符串、null）一律丢弃。 */
function tier(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** 解析单个模型的四档价；一档都没有就返回 undefined（整个模型条目作废）。 */
function parseModelPrice(v: unknown): ModelPriceConfig | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined
  const raw = v as Record<string, unknown>
  const out: Record<string, number> = {}
  let any = false
  for (const key of PRICE_KEYS) {
    const n = tier(raw[key])
    if (n !== undefined) {
      out[key] = n
      any = true
    }
  }
  return any ? (out as ModelPriceConfig) : undefined
}

/**
 * 解析两层嵌套的 `modelPrices`：`{ providerID: { modelID: {四档} } }`。
 * providerID 与 modelID 分开是刻意的（D28）：同一 modelID 在不同 provider 下是不同模型。
 * 结构不对的分支直接跳过——配置错了只丢配置，不能让插件挂掉。
 */
function parseModelPrices(v: unknown): ModelPrices {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {}
  const out: Record<string, Record<string, ModelPriceConfig>> = {}
  let providers = 0
  for (const [pid, pv] of Object.entries(v as Record<string, unknown>)) {
    if (pid.length === 0 || pid.length > MAX_MODEL_KEY) continue
    if (typeof pv !== "object" || pv === null || Array.isArray(pv)) continue
    if (++providers > MAX_ENTRIES) break
    const models: Record<string, ModelPriceConfig> = {}
    let count = 0
    for (const [mid, mv] of Object.entries(pv as Record<string, unknown>)) {
      if (mid.length === 0 || mid.length > MAX_MODEL_KEY) continue
      if (++count > MAX_ENTRIES) break
      const price = parseModelPrice(mv)
      if (price) models[mid] = price
    }
    if (Object.keys(models).length > 0) out[pid] = models
  }
  return out
}

/**
 * 解析 options 对象；任何异常路径都返回默认配置。
 *
 * 计价链（D3 / D28）只有唯一一条，逐档独立回落：
 *   `modelPrices[provider][model][档]` → OpenCode 内部美元价 × `exchangeRate` → 0
 *
 * 已移除的旧配置项（D28）：`prices`（全局统一价）与 `useModelPrice`（三态开关）。
 * "默认读模型自带 cost"这条 D3 本意现在由回落链第 2 段自然承担。
 */
export function parseConfig(options: unknown): PluginConfig {
  const o = (typeof options === "object" && options !== null ? options : {}) as Record<string, unknown>
  return {
    record: bool(o.record, DEFAULT_CONFIG.record),
    currency: str(o.currency, DEFAULT_CONFIG.currency),
    // 必须为正有限数：0 会把所有内部价归零、负数会算出负账
    exchangeRate:
      typeof o.exchangeRate === "number" && Number.isFinite(o.exchangeRate) && o.exchangeRate > 0
        ? o.exchangeRate
        : DEFAULT_CONFIG.exchangeRate,
    modelPrices: parseModelPrices(o.modelPrices),
    flushAgeMs: num(o.flushAgeMs, DEFAULT_CONFIG.flushAgeMs, 1),
    flushRows: num(o.flushRows, DEFAULT_CONFIG.flushRows, 1),
    flushBytes: num(o.flushBytes, DEFAULT_CONFIG.flushBytes, 1),
    memoryCapBytes: num(o.memoryCapBytes, DEFAULT_CONFIG.memoryCapBytes, 1024),
    persistMs: num(o.persistMs, DEFAULT_CONFIG.persistMs, 1_000),
    snapshotMs: num(o.snapshotMs, DEFAULT_CONFIG.snapshotMs, 100),
    retentionDays: num(o.retentionDays, DEFAULT_CONFIG.retentionDays),
  }
}
