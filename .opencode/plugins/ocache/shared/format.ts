/**
 * 侧栏文案格式化（纯函数，脱离 OpenCode 单测）。
 *
 * 只负责"把已算好的数写成一行字"：不参与计费、不改聚合口径。
 * 每个函数对应 tui.tsx 里一条固定的 <text>——拆开是为了让每行的取值
 * 都发生在 JSX getter 内（Solid 只在 getter 里读信号才是响应式的），
 * 同时这些行函数可以脱离 TUI 直接断言。
 *
 * **M6 外观**：行不再返回整串，而是返回分段 `Seg[]`——每段带一个语义角色
 * `Tone`，由 tui.tsx 映射成主题色。这样"写了什么"和"怎么强调"都留在
 * 纯函数里，两者都能被测试钉死；颜色本身归 tui.tsx（要主题对象），
 * 拼回整串用 `plain()`。
 *
 * 版式两条原则（M6 定的，改动前先想清楚）：
 * 1. **标签列固定宽度**：所有行的标签补到 `LABEL_W` 格，数值从同一列起跳，
 *    于是四笔金额（费用/今日/本月/累计）竖成一列，扫一眼就能比大小。
 * 2. **弱化标签、放亮数值**：字段名和分隔符一律 `label`，只有数值才是
 *    `value`，金额再单独给 `money`——一屏里眼睛只会往亮处走。
 *
 * **宽度是硬约束**：侧栏可用宽不归我们定（170 格终端实测约 35 格，
 * 由侧栏整体布局给）。加标签列等于每行吃掉 2~3 格，就得从内容里还回去，
 * 否则行会折行、面板被撑高。所以第 2 行的请求数挪到了第 6 行与费用作伴，
 * 累计行与今日/本月统一成"金额 · 成功率"的同形三行。任何时候改版都先量宽。
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

/**
 * 分段的视觉角色。format 只给语义，具体取哪个色由 tui.tsx 查主题决定——
 * 换主题、换配色都不必动这里，也不会影响任何文案断言。
 */
export type Tone =
  | "title" // 面板名 ocache：主题强调色
  | "label" // 字段名与分隔符：弱化，把注意力让给数值
  | "value" // 普通数值
  | "money" // 金额：本面板的主看点
  | "up" // 环比上升（缓存命中率涨 = 好事）
  | "down" // 环比下降
  | "on" // 正在写 JSONL
  | "off" // 仅内存、没落盘——得让人一眼注意到
  | "rule" // 分隔线

/** 一行里的一段：文字 + 角色。 */
export interface Seg {
  readonly text: string
  readonly tone: Tone
}

/** 造一段（带类型收窄，避免手写字面量漏字段）。 */
function seg(text: string, tone: Tone): Seg {
  return { text, tone }
}

/** 分段拼回整串。单测、日志、任何"就要一整行"的场合用它。 */
export function plain(segs: readonly Seg[]): string {
  let out = ""
  for (const s of segs) out += s.text
  return out
}

/**
 * 终端显示宽度（占几格）：中日韩与全角字符算 2 格，其余算 1 格。
 *
 * 标签列必须按格对齐——用 `.length` 会把"未命中"数成 3、把列全排歪。
 * 只覆盖面板实际会用到的区间（CJK、全角标点、常见表情）；
 * 罕见宽字符排版仍不准，但那种字本面板也不会出现。
 */
export function width(s: string): number {
  let w = 0
  for (const ch of s) w += isWide(ch.codePointAt(0)!) ? 2 : 1
  return w
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** 补空格到指定显示宽度；本来够宽就原样返回（绝不动已有内容）。 */
function pad(s: string, w: number): string {
  const gap = w - width(s)
  return gap > 0 ? s + " ".repeat(gap) : s
}

/**
 * 左侧标签列宽（格）= 最长标签"未命中 / 缓存写"（6 格）+ 1 格间隙。
 *
 * 1 格是最小可用间隙：3 字标签与数值紧邻时仍有分隔；而 2 字标签
 * （请求 / 本次 / 费用 / 今日 / 本月 / 累计）会拿到 3 格空档，
 * 这段空档就是肉眼认出来的"列"。再宽就会挤爆侧栏（见文件头的宽度约束）。
 *
 * 导出是为了让测试能自己算出行首，而不是把 7 这个魔数抄进断言——
 * 将来加长标签只要改这里。
 */
export const LABEL_W = 7

/** 带标签的行首：补到 `LABEL_W` 宽，角色是 `label`（弱化）。 */
function head(label: string): Seg {
  return seg(pad(label, LABEL_W), "label")
}

/**
 * 整行无数据时的占位。
 * 放在标签列**之后**而不是行首：占位也落在数值列上，列的节奏不被打断。
 */
function emptyCell(): Seg {
  return seg(" ".repeat(LABEL_W) + NO_DATA, "label")
}

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
 *
 * 三个角色在这里分得最清楚：标题 `title`（强调色）、范围 `label`（弱化）、
 * 状态点 `on` / `off`——**没落盘**这件事用 `off` 的警示色单独拎出来。
 */
export function lineHeader(s: Snapshot, sid: string): Seg[] {
  const kids = Math.max(0, subtreeIds(s.sessions, sid).length - 1)
  const out: Seg[] = [seg("ocache", "title")]
  if (kids > 0) out.push(seg(` +${kids} 子会话`, "label"))
  if (s.updated === 0) return out
  out.push(seg(" · ", "label"))
  if (s.record) {
    out.push(seg("●", "on"))
    out.push(seg(" 记录中", "label"))
  } else {
    out.push(seg("○", "off"))
    out.push(seg(" 仅内存", "label"))
  }
  return out
}

/**
 * 第 2 行：请求数 · 缓存命中率（当前会话含子会话）。
 *
 * 这行**只放两样**。M6 实测过放三样的后果：`请求 · 成功 · 命中` 连标签列一起
 * 要 39 格，侧栏只有 35 格，行会折行、把整块 10 行的面板撑成 11 行。
 * 让位的是**会话级成功率**——今日/本月/累计三行本来就各自带成功率，
 * 它在面板上出现四次是冗余；命中率是这个插件的主角，一次都不能少。
 */
export function lineSessionHit(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [
    head("请求"),
    seg(fmtInt(b.steps), "value"),
    seg(" · 命中 ", "label"),
    seg(fmtPct(hitRate(b), 2), "value"),
  ]
}

/**
 * 第 3 行：本次请求命中率 + 相对上一次请求的环比。
 *
 * 与第 2 行的"命中"不同：那行是会话树**累计**的命中率，这行只看最近一次
 * 成功的 primary 请求，能立刻反映"这一轮到底缓存住没住"。
 *
 * - 环比用 `+` / `-` 而不是箭头：箭头在部分字体里字宽不齐、还得靠字形猜
 *   方向，`+1.9%` 直白得多。符号本身仍要靠颜色补足可扫性——
 *   升 `up`、降 `down`，不用读字就知道方向。
 * - 首条请求没有基线、或与上次持平（一位小数舍入后为 0）时不带符号，
 *   避免 `+0%` 这种噪音，两者都显示成纯命中率。
 * - 失败请求与 title / compaction / generate 不进基线（口径同 kind 过滤），
 *   所以"本次"可能停在上一次成功的请求上。
 */
export function lineSessionRecent(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const [cur, prev] = subtreeRecentOf(s.sessions, sid)
  if (!cur) return [emptyCell()]
  const base = hitRate(cur)
  const out: Seg[] = [head("本次"), seg(fmtPct(base, 2), "value")]
  if (prev) {
    const delta = base - hitRate(prev)
    // 命中率与环比都取两位小数：单次请求的命中差异常在零点几内，
    // 一位小数会把 "+0.05%" 抹成 "0%"、让有效信息被当成持平吞掉。
    const text = fmtPct(Math.abs(delta), 2)
    if (text !== "0%") {
      out.push(seg(` ${delta > 0 ? "+" : "-"}${text}`, delta > 0 ? "up" : "down"))
    }
  }
  return out
}

/** 第 4 行：输入未命中 · 缓存读。 */
export function lineSessionMissRead(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [
    head("未命中"),
    seg(fmtCount(b.input), "value"),
    seg(" · 缓存读 ", "label"),
    seg(fmtCount(b.cacheRead), "value"),
  ]
}

/**
 * 第 5 行：缓存写 · 输出。
 *
 * 只放两档：三档（缓存写 / 输出 / 推理）连标签列要 36 格，超侧栏 35 格的
 * 上限——实测 `缓存写 54.3K · 输出 988K · 推理 656K` 就会折行。
 * 推理挪去第 6 行与费用作伴：五个口径里它按输出计费、单价最高，最能解释
 * "钱"是怎么烧掉的。
 */
export function lineSessionWriteOut(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [
    head("缓存写"),
    seg(fmtCount(b.cacheWrite), "value"),
    seg(" · 输出 ", "label"),
    seg(fmtCount(b.output), "value"),
  ]
}

/**
 * 第 6 行：本次会话花了多少钱 · 花在哪档 token 上。
 *
 * 独占一行而不是塞在 token 行尾：钱是本会话最该被看见的数字，而且要和
 * 下面的今日/本月/累计对齐成同一列——四笔金额都从 `LABEL_W` 起跳，
 * 竖着一扫就能比大小。推理跟在后面，是"钱"最好的注脚。
 */
export function lineSessionCost(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [
    head("费用"),
    seg(fmtCost(b.cost, s.currency), "money"),
    seg(" · 推理 ", "label"),
    seg(fmtCount(b.reasoning), "value"),
  ]
}

/**
 * 第 7 行：分隔"当前会话"与"历史三口径"。
 * 固定宽度、不随终端变化——它标记的是语义边界，不是排版辅助线。
 */
export const DIVIDER = "────────────────────"

export function lineDivider(): Seg[] {
  return [seg(DIVIDER, "rule")]
}

/**
 * 今日 / 本月 / 累计三行的共同形状：标签 + 金额 + 成功率。
 *
 * 同形是刻意的——三行竖着排，形状一致才会读成"一列金额 + 一列质量"，
 * 而不是三段互不相干的话。累计行原来还挂请求数，M6 去掉了：
 * 会话请求数已经在第 6 行，历史请求数与本月口径高度重合，
 * 换来的宽度正好让这三行保持同形。
 */
function historyLine(label: string, s: Snapshot, b: Bucket): Seg[] {
  return [
    head(label),
    seg(fmtCost(b.cost, s.currency), "money"),
    seg(" · ", "label"),
    seg(fmtPct(successRate(b)), "value"),
    seg(" 成功", "label"),
  ]
}

/** 第 8 行：今日。 */
export function lineToday(s: Snapshot): Seg[] {
  const b = s.agg?.today
  if (!b) return [emptyCell()]
  return historyLine("今日", s, b)
}

/** 第 9 行：本月。 */
export function lineMonth(s: Snapshot): Seg[] {
  const b = s.agg?.month
  if (!b) return [emptyCell()]
  return historyLine("本月", s, b)
}

/** 第 10 行：历史累计。 */
export function lineTotal(s: Snapshot): Seg[] {
  const b = s.agg?.totals
  if (!b) return [emptyCell()]
  return historyLine("累计", s, b)
}

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
    { name: "lineHeader", text: plain(lineHeader(s, sid)) },
    { name: "lineSessionHit", text: plain(lineSessionHit(s, sid)) },
    { name: "lineSessionRecent", text: plain(lineSessionRecent(s, sid)) },
    { name: "lineSessionMissRead", text: plain(lineSessionMissRead(s, sid)) },
    { name: "lineSessionWriteOut", text: plain(lineSessionWriteOut(s, sid)) },
    { name: "lineSessionCost", text: plain(lineSessionCost(s, sid)) },
    { name: "lineDivider", text: plain(lineDivider()) },
    { name: "lineToday", text: plain(lineToday(s)) },
    { name: "lineMonth", text: plain(lineMonth(s)) },
    { name: "lineTotal", text: plain(lineTotal(s)) },
  ]
}

/** 供 tui.tsx 引用的类型，避免它直接依赖聚合层细节。 */
export type { SessionSnapshot }
