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
 * 版式三条原则（M6 定标签列，2026-09-27 改版定数值列，改动前先想清楚）：
 * 1. **标签列固定宽度**：所有行的标签补到 `LABEL_W` 格，数值从同一列起跳，
 *    于是四笔金额（费用/今日/本月/累计）竖成一列，扫一眼就能比大小。
 * 2. **数值列也固定宽度**：一行里"第一个数值"补到 `VALUE_W` 格，后面的
 *    `·` 与第二个标签因此落在**同一列**——一行两段的行（`请求 · 成功`、
 *    `输入 · 输出`…）横着看是两组数，竖着看是两列数。
 *    靠手插空格排不出这效果：数值位数一变，后面的段就整体错位
 *    （用户 2026-09-27 反馈"单独使用空格会出现错位展示"）。
 * 3. **弱化标签、放亮数值**：字段名和分隔符一律 `label`，只有数值才是
 *    `value`，金额再单独给 `money`——一屏里眼睛只会往亮处走。
 *
 * **宽度是硬约束、纵向不是**：侧栏可用宽不归我们定（170 格终端实测约 35 格，
 * 由侧栏整体布局给），超宽会被终端折行、把面板撑高；但行数不受限制
 * （用户 2026-09-27 确认纵向空间充裕）。所以改版规则是：
 * **一行装不下就拆两行，绝不折行**——`PanelLayout` 三档就是这条规则的产物。
 * 每次改版都先按 `width()` 量一遍最坏情况（最大千分位、`100%`、六位数请求数）。
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
 * 左侧标签列宽（格）= 5 = 最长标签 2 字（4 格）+ 1 格间隙。
 *
 * 1 格是**最小可用间隙**——再窄标签就贴上数值了。标签一律 2 字（请求 / 命中 /
 * 输入 / 输出 / 缓读 / 缓写 / 推理 / 费用 / 今日 / 本月 / 累计），竖着扫下来
 * 每行同一个节奏；数值从第 6 格起跳，"列"靠**对齐**认，不靠空档撑。
 *
 * 2026-09-27 从 7 收到 5（用户："左侧的数值和文本距离近一点"）：标签早已全是
 * 2 字，那 3 格空档纯属白给——收紧后每条主行窄 2 格，历史明细行的缩进（连带
 * `1,160 请求` 整段）也整体左移 2 格。再宽就会挤爆侧栏（见文件头的宽度约束）。
 *
 * 导出是为了让测试能自己算出行首，而不是把 5 这个魔数抄进断言——
 * 将来加长标签只要改这里。
 */
export const LABEL_W = 5

/**
 * 第一列数值的列宽（格）= 最长常见数值 "96.39% / 987.7M"（6 格）。
 *
 * **一行两段的排版全靠它**：第一个数值补到这个宽度，` · ` 的 `·` 才会钉在
 * 固定的**第 15 格**、第二个标签从第 17 格起跳、第二个数值落在第 22 格，
 * 四行"请求 / 命中 / 输入 / 缓读"横平竖直地对上（列位一律按 1-based 的"第 N 格"说）。
 *
 * 6 是**上限而不是估值**：命中率取两位小数最多 `99.99%`（6 格），fmtCount
 * 缩写最多 `987.7M`（6 格）。比它长的只有 `fmtInt` 的请求数（`987,654` =
 * 7 格）——那种量级（单会话近百万次请求）现实中到不了，即便到了也只是
 * 该行整体右移一格，宽度守卫测试仍然卡得住 35 格上限。
 */
export const VALUE_W = 6

/**
 * 金额列宽（格）= `¥123,456.77` 这种"六位数金额"的长度。
 *
 * 只在**金额后面还跟着东西**时补（紧凑档的历史行 `¥1.23 · 99.1% 成功`），
 * 让三行的 `· 成功` 竖在同一列；展开档金额是行尾，补了也看不见，
 * 所以那档根本不走这条路径。
 *
 * 取 11 是为了罩住测试里最胖的 `¥123,456.77`——超过它的金额仍会把该行的
 * `·` 顶右一格，但整行宽度（7 + 11 + 3 + 5 + 1 + 4 = 31）离 35 还有余量。
 */
export const MONEY_W = 11

/**
 * 历史明细行"请求数"的列宽（格），**与会话块的 `VALUE_W` 分开定**，
 * 因为两边的量级差着三个数量级：单会话顶多几百次请求（6 格够用），
 * 而历史累计是几十万——`fmtInt` 出来的 `116,000` 就是 7 格，套 6 格会让
 * `· 成功` 右移一格，三条明细竖着一看就是歪的（改版时实测踩到过）。
 *
 * **取 7 而不是 9**：请求理论不会超过 `1,000,000`（用户原话），日常封顶
 * `999,999` 正好 7 格，而 9 格会让 `· 成功` 平白右移两格——截图里
 * `请求 1,040       · 成功 98.9%` 的大空档就是这么来的。真撞上 `1,000,000`
 * 也只把该行的 `· 成功` 顶右 2 格，整行 `5 + 9 + 8 + 5 = 27` 离 35 还远。
 */
export const DETAIL_W = 7

/** 带标签的行首：补到 `LABEL_W` 宽，角色是 `label`（弱化）。 */
function head(label: string): Seg {
  return seg(pad(label, LABEL_W), "label")
}

/**
 * 第一个数值：补到 `VALUE_W` 宽，让后面的 ` · ` 与第二个标签落在固定列。
 *
 * **行尾的数值不要走它**——补出来的空格虽然看不见，却会变成测试里
 * 永远对不上的尾随空白。谁后面还有段落，谁才补。
 */
function val(text: string): Seg {
  return seg(pad(text, VALUE_W), "value")
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
 * 第 1 行：请求数 · 成功率（当前会话含子会话）。
 *
 * 这行**只放两样**。M6 实测过放三样的后果：`请求 · 成功 · 命中` 连标签列一起
 * 要 39 格，侧栏只有 35 格，行会折行、把面板撑高。命中率因此在下一行自成
 * 一段（`lineSessionHit`）——横向换纵向，两样都不丢。
 *
 * 2026-09-27 改版把成功率从"独占一行"并到这行行尾：请求数与成功率本来就是
 * 同一件事的两面（打了多少次、成没成），分成两行各占一个标签列反而浪费；
 * 并起来之后，紧凑档砍掉历史明细行也不至于让请求数在面板上彻底消失。
 */
export function lineSessionReq(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [
    head("请求"),
    val(fmtInt(b.steps)),
    seg(" · 成功 ", "label"),
    seg(fmtPct(successRate(b)), "value"),
  ]
}

/**
 * 第 2 行：缓存命中率（会话树累计）· 本次命中率 + 环比。
 *
 * 命中率是这个插件的主角，一次都不能少；"本次"则是它最锋利的那一面——
 * 累计值被一长串旧请求稀释，只有最近一次请求能立刻反映"这一轮到底缓存住没住"。
 *
 * - 累计与本次**不是一个口径**：前者是整棵会话子树，后者只看最近一条成功的
 *   primary 请求，所以"本次"可能停在上一次成功的请求上。
 * - 环比用 `+` / `-` 而不是箭头：箭头在部分字体里字宽不齐、还得靠字形猜
 *   方向，`+1.9%` 直白得多。符号本身仍要靠颜色补足可扫性——
 *   升 `up`、降 `down`，不用读字就知道方向。
 * - 首条请求没有基线、或与上次持平（两位小数舍入后为 0）时不带符号，
 *   避免 `+0%` 这种噪音，只留纯命中率。
 * - 会话没有 `recent`（旧数据快照）时**只退成本行前半段，不整行占位**：
 *   累计值就摆在桶里，白给的信息没道理扣着不显示。
 *
 * **这是面板上最长的一行**：`命中(5) + 96.39%(6) + " · 本次 "(8) +
 * 99.30%(6) + " +2.00%"(7)` = 32，最坏 `+99.99%` 正好 33 格封顶。
 * 改这行之前先把这两个数算一遍，超了就得砍别的段——35 是硬上限（文件头）。
 */
export function lineSessionHit(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const cum = hitRate(sessionBucket(s, sid))
  const [cur, prev] = subtreeRecentOf(s.sessions, sid)
  if (!cur) return [head("命中"), seg(fmtPct(cum, 2), "value")]

  const base = hitRate(cur)
  const delta = prev ? base - hitRate(prev) : 0
  // 命中率与环比都取两位小数：单次请求的命中差异常在零点几内，
  // 一位小数会把 "+0.05%" 抹成 "0%"、让有效信息被当成持平吞掉。
  const text = fmtPct(Math.abs(delta), 2)
  const up = text !== "0%"
  return [
    head("命中"),
    val(fmtPct(cum, 2)),
    seg(" · 本次 ", "label"),
    // 有环比才补空格：把 "±" 顶到固定列，同时不给行尾留一截看不见的空白
    seg(up ? pad(fmtPct(base, 2), VALUE_W) : fmtPct(base, 2), "value"),
    ...(up ? [seg(` ${delta > 0 ? "+" : "-"}${text}`, delta > 0 ? "up" : "down")] : []),
  ]
}

/**
 * 第 3 行：输入 · 输出。
 *
 * 2026-09-27 改版：`未命中` 改叫 `输入`，并与 `输出` 并到同一行。
 * 这两个才是真正"进出模型"的 token，缓存那两档是它们的旁支，于是分组改按
 * **语义**走——未缓存的进与出一行、缓存的读与写下一行（旧版是按"数大"横切，
 * `未命中 · 缓存读` / `缓存写 · 输出`，四档各归各家，扫的时候要来回对）。
 *
 * 标签从"未命中"改成"输入"还顺手把三字压成了两字——`LABEL_W` 是按 2 字定的，
 * 三字会顶破它直接贴上数值，两字才留得出 1 格间隙。
 */
export function lineSessionInOut(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [
    head("输入"),
    val(fmtCount(b.input)),
    seg(" · 输出 ", "label"),
    seg(fmtCount(b.output), "value"),
  ]
}

/**
 * 第 4 行：缓读 · 缓写（= 缓存读 · 缓存写）。
 *
 * 2026-09-27 改版让两档缓存独占一行，正是用户点名的"缓存写和读放在一行"；
 * 同日再把两者**对调**（缓存读在前）并**缩成两字**，两条理由：
 *
 * 1. **缓存读才是主角**：量级在千万到亿、直接决定费用；缓存写对多数端点
 *    恒为 0（端点不报写入量，见 §4 已知取舍）。常在前、罕在后。
 * 2. **两字标签才对得齐**：三字 `缓存读` 占 6 格，会把这行第二个数值顶到
 *    第 24 格，比其余行（成功 / 本次 / 输出，4 格 → 第 22 格）右移 2 格。
 *    把别处垫到 6 格也能让它齐，但那是把余量一次花光：最长的命中行会顶到
 *    35 格、**一格不剩**；缩标签则让四行天然齐、还净赚 2 格。
 *
 * 这里只改**显示名**：字段仍是 `cacheRead`/`cacheWrite`，四档单价与命中率
 * 分母（输入 + 缓存读 + 缓存写 = prompt 总输入）都不受影响。
 */
export function lineSessionCache(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [
    head("缓读"),
    val(fmtCount(b.cacheRead)),
    seg(" · 缓写 ", "label"),
    seg(fmtCount(b.cacheWrite), "value"),
  ]
}

/**
 * 第 5 行：推理 token。
 *
 * 2026-09-27 改版从费用行里拆出来单独一行（用户："推理消耗的 token 不要和
 * 费用写在一起，看着有点奇怪，可以上移作为独立的一行"）。拆开之后五个
 * token 口径在面板上是**四行两列**的整齐矩阵，费用行也只剩一个金额，
 * 不再因为推理位数不同而忽长忽短。
 *
 * 推理按输出计费、单价最高，单独一行也正好是"钱花在哪档 token 上"的注脚。
 */
export function lineSessionReasoning(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [head("推理"), seg(fmtCount(b.reasoning), "value")]
}

/**
 * 第 6 行：本次会话花了多少钱。
 *
 * 独占一行而不是塞在 token 行尾：钱是本会话最该被看见的数字，而且要和
 * 下面的今日/本月/累计对齐成同一列——四笔金额都从 `LABEL_W` 起跳，
 * 竖着一扫就能比大小。
 *
 * 2026-09-27 改版把行尾的 `· 推理 xxx` 拿掉（推理升到上一行独立成行）。
 * 从此这行只有一个金额，与今日/本月/累计**行形完全一致**，
 * 也不会再因为推理位数不同而忽长忽短。
 */
export function lineSessionCost(s: Snapshot, sid: string): Seg[] {
  if (!s.sessions[sid]) return [emptyCell()]
  const b = sessionBucket(s, sid)
  return [head("费用"), seg(fmtCost(b.cost, s.currency), "money")]
}

/**
 * 分隔线宽度：**正好铺满侧栏可用宽**。
 *
 * 早先是 20 格，比正文（最长 30 格）短出一截，看着像没画完
 * （用户 2026-09-27 看图反馈"分隔符可以长一些"）。上下沿与中缝现在
 * 一律铺满——它不是文字而是**版面边界**，短了就起不到
 * "这块归 ocache"的分隔作用。
 *
 * **35 是硬上限**，不是可调的美观数字：终端把超宽的行折行、把整块面板
 * 撑高（§4）。所以这里用 `repeat(35)` 而不是肉眼数出来的横杠条数——
 * 数字一改，测试里的宽度守卫会立刻卡住它。
 */
export const DIVIDER_WIDTH = 35
export const DIVIDER = "─".repeat(DIVIDER_WIDTH)

export function lineDivider(): Seg[] {
  return [seg(DIVIDER, "rule")]
}

/**
 * 面板**上沿**的分隔线，与中间那条同宽同色。
 *
 * 加它是因为面板现在是侧栏的第一块内容：上面紧挨会话标题，下面挨着别的
 * 插件，十几行数字没有边界就会和别人的文案黏成一片。三条线（上、中、下）
 * 一起把面板框成一张"卡片"，眼睛一扫就知道哪儿是我们的地盘。
 *
 * **折叠档刻意不画**——折叠态是用户明选的"标题 + 费用两行"，再垫两行
 * 装饰等于把折叠后一半的面积花在边框上，本末倒置。
 */
export function lineRuleTop(): Seg[] {
  return [seg(DIVIDER, "rule")]
}

/** 面板**下沿**的分隔线，与上沿成对。见 `lineRuleTop`。 */
export function lineRuleBottom(): Seg[] {
  return [seg(DIVIDER, "rule")]
}

/**
 * 面板密度三档，决定显示哪些行、以及历史行要不要拆成两行。
 *
 * - `full`（默认）：16 行。35 格装不下的内容拆到第二行
 *   （历史三行各带一条明细），纵向空间换横向宽度。
 * - `compact`：13 行 = 展开档去掉三条历史明细行。**会话块一行不动**——
 *   改版后那六行各管一件事（请求/命中/输入/缓存/推理/费用），
 *   摘掉哪行都是真丢信息；而历史明细里唯一的重复量（成功率）
 *   本来就已经并进历史第一行了，紧缩档省下来的只有"请求数"。
 * - `collapsed`：只剩标题与费用，2 行。
 *
 * 三档共用同一套行函数和同一个标签列，所以切换只是"显示/隐藏某些行"，
 * 不存在"折叠后口径变了"这种事——同一格数字在三档里算法完全一致。
 */
export type PanelLayout = "full" | "compact" | "collapsed"

/** 合法取值，供配置解析与测试遍历。 */
export const PANEL_LAYOUTS = ["full", "compact", "collapsed"] as const

/** 配置可能被手写成别的值，读到就退回默认档。 */
export function isPanelLayout(v: unknown): v is PanelLayout {
  return typeof v === "string" && (PANEL_LAYOUTS as readonly string[]).includes(v)
}

/**
 * 今日 / 本月 / 累计的第一行：标签 + 金额（+ 紧凑态的成功率）。
 *
 * `compact` 只有一行可用来承接这个口径，所以成功率直接跟在金额后面；
 * `full` 把成功率与请求数交给第二行，这里只留金额——于是会话费用、
 * 今日、本月、累计**四笔金额竖在同一列**，一扫就能比大小。
 *
 * 紧凑态的金额要补到 `MONEY_W`：三行的金额长短不一（`¥1.23` 与
 * `¥1,234.50`），不补的话后面的 `· 成功` 各起各的列，竖着一看就是错位
 * （同 `VALUE_W` 的由来，见文件头第 2 条原则）。
 *
 * `成功` 提到百分比**前面**（2026-09-27，与展开档的明细行一起换，用户点名
 * "成功也和数值的位置互换"）：全面板从此只有标签在前、数值在后一种读法，
 * 两种布局不再读反。附带好处是百分比落到行尾、后面没人跟着，压根不用管
 * `100%` 与 `99.5%` 差的那一格——`成功` 因此钉死在第 `LABEL_W + MONEY_W + 3` 格，
 * 三行必然对齐。
 */
function historyLine(
  label: string,
  s: Snapshot,
  b: Bucket,
  layout: PanelLayout,
): Seg[] {
  const money = fmtCost(b.cost, s.currency)
  if (layout !== "compact") return [head(label), seg(money, "money")]
  return [
    head(label),
    seg(pad(money, MONEY_W), "money"),
    seg(" · 成功 ", "label"),
    seg(fmtPct(successRate(b)), "value"),
  ]
}

/**
 * 仅展开态：历史口径的第二行，承接紧凑态塞不下的请求数与成功率。
 *
 * 2026-09-27 两次改法叠在一起，都是用户点的名：
 *
 * 1. 两段对调：`成功率 · 请求数` → `请求数 · 成功率`——与会话块第 1 行
 *    （`请求 N · 成功 P%`）同一个读法，先说打了多少次、再说成没成。
 * 2. **标签提到数值前面、行首不再缩进**（用户："请求二字和 `今日` 对齐"、
 *    "成功也和数值的位置互换"）：原先是 `       1,160     请求 · 99.5% 成功`，
 *    数值先于标签、标签浮在半空，与全面板"标签在左、数值在右"的读法拧着。
 *    改成 `请求 1,160    · 成功 99.5%` 之后，`请求` 与上一行的 `今日` 同起点，
 *    数值仍落在 `LABEL_W` 之后（与上一行的金额同列），两行才读成一组。
 *
 * 请求数补到 `DETAIL_W`（不是会话块的 `VALUE_W`——累计请求是几十万的量级，
 * `116,000` 就要 7 格），三条明细的 `· 成功` 才竖在同一列。
 */
function historyDetail(s: Snapshot, b: Bucket): Seg[] {
  return [
    head("请求"),
    seg(pad(fmtInt(b.steps), DETAIL_W), "value"),
    seg(" · 成功 ", "label"),
    // 行尾的百分比不补宽（后面没人跟着）：补出来的尾随空格看不见、
    // 却会污染断言，而 100% 与 99.1% 本来也不必等长
    seg(fmtPct(successRate(b)), "value"),
  ]
}

/** 今日（第一行）。 */
export function lineToday(s: Snapshot, layout: PanelLayout = "compact"): Seg[] {
  const b = s.agg?.today
  if (!b) return [emptyCell()]
  return historyLine("今日", s, b, layout)
}

/** 今日的明细行（仅展开态）。 */
export function lineTodayDetail(s: Snapshot): Seg[] {
  const b = s.agg?.today
  if (!b) return [emptyCell()]
  return historyDetail(s, b)
}

/** 本月（第一行）。 */
export function lineMonth(s: Snapshot, layout: PanelLayout = "compact"): Seg[] {
  const b = s.agg?.month
  if (!b) return [emptyCell()]
  return historyLine("本月", s, b, layout)
}

/** 本月的明细行（仅展开态）。 */
export function lineMonthDetail(s: Snapshot): Seg[] {
  const b = s.agg?.month
  if (!b) return [emptyCell()]
  return historyDetail(s, b)
}

/** 历史累计（第一行）。 */
export function lineTotal(s: Snapshot, layout: PanelLayout = "compact"): Seg[] {
  const b = s.agg?.totals
  if (!b) return [emptyCell()]
  return historyLine("累计", s, b, layout)
}

/** 历史累计的明细行（仅展开态）。 */
export function lineTotalDetail(s: Snapshot): Seg[] {
  const b = s.agg?.totals
  if (!b) return [emptyCell()]
  return historyDetail(s, b)
}

/** 面板一行的渲染结果：`name` 与 tui.tsx 里调用的标识符一一对应。 */
export interface PanelLine {
  readonly name: string
  readonly text: string
}

/**
 * 展开态的完整行序。**tui.tsx 里 `<text>` 的书写顺序必须与此逐条一致**，
 * 反查测试会把 tui.tsx 的标识符序列抽出来与它比对（A2）。
 *
 * 放在一处而不是散在 tui.tsx 里，是因为紧凑态/折叠态都要从这个序列里
 * 各取一个子集——顺序只在这里定义一次，三档就不会各排各的。
 *
 * 首尾两条 `lineRule*` 是面板的上下沿，把整块内容框成一张卡片。
 */
export const FULL_ORDER = [
  "lineRuleTop",
  "lineHeader",
  "lineSessionReq",
  "lineSessionHit",
  "lineSessionInOut",
  "lineSessionCache",
  "lineSessionReasoning",
  "lineSessionCost",
  "lineDivider",
  "lineToday",
  "lineTodayDetail",
  "lineMonth",
  "lineMonthDetail",
  "lineTotal",
  "lineTotalDetail",
  "lineRuleBottom",
] as const

/**
 * 三档各显示哪些行，顺序一律取自 `FULL_ORDER`。
 *
 * 因此折叠态显示"标题 → 费用"是**过滤**出来的结果，不是另排的顺序：
 * 中间那几行被摘掉后，标题后面紧跟的就是费用。顺序定义只有一处。
 *
 * 折叠态还要额外滤掉首尾两条边框线——它只留两行内容，不该再花两行画框。
 *
 * 紧凑档只滤历史明细：改版（2026-09-27）把会话块压成"六行各管一件事"，
 * 没有哪行是可有可无的；唯一的冗余在历史区——明细行里的成功率早已经
 * 并进历史第一行，被滤掉的其实只有"请求数"这一个数。
 */
export const LAYOUT_LINES: Record<PanelLayout, readonly string[]> = {
  full: FULL_ORDER,
  compact: FULL_ORDER.filter((name) => !name.endsWith("Detail")),
  collapsed: FULL_ORDER.filter(
    (name) => name === "lineHeader" || name === "lineSessionCost",
  ),
}

/** 命令面板里的循环顺序：展开 → 紧凑 → 折叠 → 展开。 */
export const NEXT_LAYOUT: Record<PanelLayout, PanelLayout> = {
  full: "compact",
  compact: "collapsed",
  collapsed: "full",
}

/**
 * 这一行在当前布局下要不要挂 `<text>`。
 *
 * tui.tsx 用它逐行守卫，因为**空的 `<text>` 会占一整行**（M6 实测：
 * 往面板头加三个空 `<text>`，标题被整整顶下去 3 行）。所以"不显示"必须
 * 是不挂节点，而不能是渲染空串。行数只随布局变、不随数据变，于是
 * 节点结构仅在切换布局那一瞬变化，不满足 §4 担心的"每秒重建子树"。
 */
export function show(layout: PanelLayout, name: string): boolean {
  return LAYOUT_LINES[layout].includes(name)
}

/** 把一行的标识符映射到它的行内容；`layout` 只影响历史行是否带成功率。 */
function allLines(
  s: Snapshot,
  sid: string,
  layout: PanelLayout,
): Record<string, Seg[]> {
  return {
    lineHeader: lineHeader(s, sid),
    lineSessionReq: lineSessionReq(s, sid),
    lineSessionHit: lineSessionHit(s, sid),
    lineSessionInOut: lineSessionInOut(s, sid),
    lineSessionCache: lineSessionCache(s, sid),
    lineSessionReasoning: lineSessionReasoning(s, sid),
    lineSessionCost: lineSessionCost(s, sid),
    lineDivider: lineDivider(),
    lineRuleTop: lineRuleTop(),
    lineRuleBottom: lineRuleBottom(),
    lineToday: lineToday(s, layout),
    lineTodayDetail: lineTodayDetail(s),
    lineMonth: lineMonth(s, layout),
    lineMonthDetail: lineMonthDetail(s),
    lineTotal: lineTotal(s, layout),
    lineTotalDetail: lineTotalDetail(s),
  }
}

/**
 * 整块面板在指定布局下的全部行（顺序即 tui.tsx 里 `<text>` 的顺序）。
 *
 * 存在的意义是**给测试一个能整块断言的对象**：单行函数的断言只能保证
 * "这一行没写错"，保证不了"这十几行拼起来还是那块面板"。把行序收在一处，
 * 测试既能整串快照，又能反查 tui.tsx 的渲染顺序有没有被人改乱。
 *
 * 注意 tui.tsx **仍然**用固定数量的 `<text>` 而不是 `.map` 本函数——
 * `.map` 每秒重建整棵子树、终端里会闪（REQUIREMENTS §4 实现约束）。
 * 这里只是它的等价描述，不参与实际渲染。
 */
export function renderPanel(
  s: Snapshot,
  sid: string,
  layout: PanelLayout = "full",
): PanelLine[] {
  const all = allLines(s, sid, layout)
  const out: PanelLine[] = []
  for (const name of LAYOUT_LINES[layout]) {
    out.push({ name, text: plain(all[name] ?? []) })
  }
  return out
}

/** 供 tui.tsx 引用的类型，避免它直接依赖聚合层细节。 */
export type { SessionSnapshot }
