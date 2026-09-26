/**
 * 侧栏文案格式化（纯函数，脱离 OpenCode 单测）。
 *
 * 只负责"把已算好的数写成一行字"：不参与计费、不改聚合口径。
 * 每个函数对应 tui.tsx 里一条固定的 <text>——拆开是为了让每行的取值
 * 都发生在 JSX getter 内（Solid 只在 getter 里读信号才是响应式的），
 * 同时这些行函数可以脱离 TUI 直接断言。
 */

import { hitRate, successRate, type Bucket } from "./aggregate.ts"
import {
  subtreeBucketOf,
  subtreeIds,
  subtreeRecentOf,
  type SessionSnapshot,
  type Snapshot,
} from "./snapshot.ts"

/** 没有数据时统一显示的占位。 */
export const NO_DATA = "—"

/** 千分位分组（不用 toLocaleString，避免环境 locale 影响测试结果）。 */
function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/**
 * token 计数：大数走 K/M/G 缩写，小数千分位。
 * 进位跨档（999,950 → 1,000.0K）时改用上一档，绝不出现 "1000.0K"。
 */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return NO_DATA
  const abs = Math.abs(n)
  const units = [
    { div: 1e3, suffix: "K" },
    { div: 1e6, suffix: "M" },
    { div: 1e9, suffix: "G" },
  ]
  let idx = -1
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!
    if (abs >= u.div) idx = i
  }
  const sign = n < 0 ? "-" : ""
  while (idx >= 0) {
    const u = units[idx]!
    const scaled = abs / u.div
    const text = scaled.toFixed(scaled >= 100 ? 0 : 1)
    if (Number(text) < 1000 || idx === units.length - 1) return sign + text + u.suffix
    idx += 1 // 四舍五入跨过千位 → 换更大的单位重排
  }
  return groupDigits(Math.round(n))
}

/**
 * 比率（0~1）→ 百分比。
 *
 * `dp` 决定小数位：**缓存命中率用 2 位**——token 量动辄百万级，一位小数会把
 * 真实差异抹平（96.39% 与 96.44% 看着一样，实际差着几百次命中）；
 * 成功率等用默认 1 位。
 *
 * **整数值不带小数尾巴**（`100.00%` → `100%`、`0.00%` → `0%`），
 * 免得整数被写成 `97.00%` 这种噪音，也让"持平不显示符号"的判断继续成立。
 */
export function fmtPct(rate: number, dp = 1): string {
  if (!Number.isFinite(rate)) return NO_DATA
  const text = (rate * 100).toFixed(dp)
  const dot = text.indexOf(".")
  if (dot >= 0 && Number(text.slice(dot + 1)) === 0) return text.slice(0, dot) + "%"
  return text + "%"
}

/**
 * 计数类整数（请求数 / 步数）：千分位，不缩写——
 * "1,234 请求" 比 "1.2K 请求" 直观，token 计数才走 fmtCount。
 */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return NO_DATA
  return groupDigits(Math.round(n))
}

/**
 * 费用 + 自定义货币标签。金额按常规货币写法：1 以上两位小数（带千分位），
 * 1 以下逐级多留小数位，避免 ¥0.0001 被显示成 ¥0。
 * 计费口径见 shared/billing.ts；这里只做显示，不重新计价。
 */
export function fmtCost(cost: number, currency: string): string {
  if (!Number.isFinite(cost)) return NO_DATA
  const abs = Math.abs(cost)
  let text: string
  if (abs === 0) text = "0"
  else if (abs >= 1) text = groupDecimals(cost.toFixed(2))
  else if (abs >= 0.01) text = trimZeros(cost.toFixed(4))
  else if (abs >= 0.0001) text = trimZeros(cost.toFixed(6))
  else text = cost.toPrecision(3)
  return currency + text
}

/** "1234.50" → "1,234.50"：只给整数部分加千分位，小数原样保留。 */
function groupDecimals(text: string): string {
  if (text.includes("e")) return text // 超大值的 toFixed 会退回科学计数法
  const dot = text.indexOf(".")
  if (dot < 0) return groupDigits(Number(text))
  return `${groupDigits(Number(text.slice(0, dot)))}${text.slice(dot)}`
}

/** 去掉小数尾随零（"1.50"→"1.5"）；整数不带小数点，原样返回。 */
function trimZeros(text: string): string {
  if (!text.includes(".")) return text
  return text.replace(/0+$/, "").replace(/\.$/, "")
}

/** 当前会话及其子会话的合计桶；会话不在快照里时返回空桶。 */
export function sessionBucket(s: Snapshot, sid: string): Bucket {
  return subtreeBucketOf(s.sessions, sid)
}

/**
 * 第 1 行：面板标题 + 聚合范围 + 记录状态。
 *
 * 标题用插件名 `ocache`——与插件 id、仓库、数据目录同名，便于一眼认出
 * 这份数据的来源（改名前写作"Token 用量"，与 OpenCode 内置统计容易混淆）。
 * 不重复显示会话标题：侧栏顶部本来就有，且侧栏窄、中文标题按格截断后
 * 常常只剩半句。只在存在子会话时补一句聚合范围，说明"下面的数字把
 * 子代理也算进来了"。
 *
 * 记录状态必须常驻：`record` 关闭时 JSONL 一个字节都不写，数据只活在
 * 内存里、重启即失。不说清楚的话，用户会以为历史已经存下来了。
 * 首帧快照还没到（updated=0）时不显示状态，免得闪一句"仅内存"误导人。
 */
export function lineHeader(s: Snapshot, sid: string): string {
  const kids = Math.max(0, subtreeIds(s.sessions, sid).length - 1)
  const scope = kids > 0 ? ` +${kids} 子会话` : ""
  const state = s.updated === 0 ? "" : s.record ? " · ● 记录中" : " · ○ 仅内存"
  return `ocache${scope}${state}`
}

/** 第 2 行：请求数 · 请求成功率 · 缓存命中率（当前会话含子会话）。 */
export function lineSessionCounts(s: Snapshot, sid: string): string {
  const own = s.sessions[sid]
  if (!own) return NO_DATA
  const b = sessionBucket(s, sid)
  return `请求 ${fmtInt(b.steps)} · 成功 ${fmtPct(successRate(b))} · 命中 ${fmtPct(hitRate(b), 2)}`
}

/**
 * 第 3 行：本次请求命中率 + 相对上一次请求的环比。
 *
 * 与第 2 行的"命中"不同：那行是会话树**累计**的命中率，这行只看最近一次
 * 成功的 primary 请求，能立刻反映"这一轮到底缓存住没住"。
 *
 * - 环比用 `+` / `-` 而不是箭头：箭头在部分字体里字宽不齐、还得靠字形猜
 *   方向，`+1.9%` 直白得多。
 * - 首条请求没有基线、或与上次持平（一位小数舍入后为 0）时不带符号，
 *   避免 `+0%` 这种噪音，两者都显示成纯命中率。
 * - 失败请求与 title / compaction / generate 不进基线（口径同 kind 过滤），
 *   所以"本次"可能停在上一次成功的请求上。
 */
export function lineSessionRecent(s: Snapshot, sid: string): string {
  if (!s.sessions[sid]) return NO_DATA
  const [cur, prev] = subtreeRecentOf(s.sessions, sid)
  if (!cur) return NO_DATA
  const base = hitRate(cur)
  // 命中率与环比都取两位小数：单次请求的命中差异常在零点几内，
  // 一位小数会把 "+0.05%" 抹成 "0%"、让有效信息被当成持平吞掉。
  let line = `本次 ${fmtPct(base, 2)}`
  if (prev) {
    const delta = base - hitRate(prev)
    const text = fmtPct(Math.abs(delta), 2)
    if (text !== "0%") line += ` ${delta > 0 ? "+" : "-"}${text}`
  }
  return line
}

/** 第 4 行：输入未命中 · 缓存读。 */
export function lineSessionMissRead(s: Snapshot, sid: string): string {
  const own = s.sessions[sid]
  if (!own) return NO_DATA
  const b = sessionBucket(s, sid)
  return `未命中 ${fmtCount(b.input)} · 缓存读 ${fmtCount(b.cacheRead)}`
}

/** 第 5 行：缓存写 · 输出。 */
export function lineSessionWriteOut(s: Snapshot, sid: string): string {
  const own = s.sessions[sid]
  if (!own) return NO_DATA
  const b = sessionBucket(s, sid)
  return `缓存写 ${fmtCount(b.cacheWrite)} · 输出 ${fmtCount(b.output)}`
}

/** 第 6 行：推理 · 费用。 */
export function lineSessionReasonCost(s: Snapshot, sid: string): string {
  const own = s.sessions[sid]
  if (!own) return NO_DATA
  const b = sessionBucket(s, sid)
  return `推理 ${fmtCount(b.reasoning)} · 费用 ${fmtCost(b.cost, s.currency)}`
}

/** 第 8 行：今日。 */
export function lineToday(s: Snapshot): string {
  const b = s.agg?.today
  if (!b) return NO_DATA
  return `今日 ${fmtCost(b.cost, s.currency)} · ${fmtPct(successRate(b))} 成功`
}

/** 第 9 行：本月。 */
export function lineMonth(s: Snapshot): string {
  const b = s.agg?.month
  if (!b) return NO_DATA
  return `本月 ${fmtCost(b.cost, s.currency)} · ${fmtPct(successRate(b))} 成功`
}

/** 第 10 行：历史累计（请求数 + 成功率）。 */
export function lineTotal(s: Snapshot): string {
  const b = s.agg?.totals
  if (!b) return NO_DATA
  return `累计 ${fmtCost(b.cost, s.currency)} · ${fmtInt(b.steps)} 请求 · ${fmtPct(successRate(b))} 成功`
}

/**
 * 无数据时的分隔行；宽度按侧栏常见尺寸取，不随终端宽度变化。
 * 放在 format 而不是 tui.tsx：整块面板的行序由 `renderPanel` 统一持有，
 * 才能让测试拿它和真实渲染逐行对齐。
 */
export const DIVIDER = "────────────────────"

/** 面板一行的渲染结果：`name` 与 tui.tsx 里调用的标识符一一对应。 */
export interface PanelLine {
  readonly name: string
  readonly text: string
}

/**
 * 整块面板的全部行（顺序即 tui.tsx 里固定 `<text>` 的顺序）。
 *
 * 存在的意义是**给测试一个能整块断言的对象**：单行函数的断言只能保证
 * "这一行没写错"，保证不了"这十行拼起来还是那块面板"。把行序收在一处，
 * 测试既能整串快照，又能反查 tui.tsx 的渲染顺序有没有被人改乱。
 *
 * 注意 tui.tsx **仍然**用十条固定的 `<text>` 而不是 `.map` 本函数——
 * `.map` 每秒重建整棵子树、终端里会闪（REQUIREMENTS §4 实现约束）。
 * 这里只是它的等价描述，不参与实际渲染。
 */
export function renderPanel(s: Snapshot, sid: string): PanelLine[] {
  return [
    { name: "lineHeader", text: lineHeader(s, sid) },
    { name: "lineSessionCounts", text: lineSessionCounts(s, sid) },
    { name: "lineSessionRecent", text: lineSessionRecent(s, sid) },
    { name: "lineSessionMissRead", text: lineSessionMissRead(s, sid) },
    { name: "lineSessionWriteOut", text: lineSessionWriteOut(s, sid) },
    { name: "lineSessionReasonCost", text: lineSessionReasonCost(s, sid) },
    { name: "DIVIDER", text: DIVIDER },
    { name: "lineToday", text: lineToday(s) },
    { name: "lineMonth", text: lineMonth(s) },
    { name: "lineTotal", text: lineTotal(s) },
  ]
}

/** 供 tui.tsx 引用的类型，避免它直接依赖聚合层细节。 */
export type { SessionSnapshot }
