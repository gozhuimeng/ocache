/**
 * 辅助请求对账（D13 的落盘侧）。
 *
 * ## 为什么要对账
 *
 * title 与 compaction 请求**不产生** `session.step.*`，也不发
 * `session.usage.recorded`（实测，OpenCode v2.0.18）。它们的用量只体现在
 * `session.usage.updated` 里那条**累计**台账中——不单独处理的话，JSONL 会
 * 比 OpenCode 自己的 session 台账少一截（新会话的差额正是 title 那次请求）。
 *
 * ## 算法
 *
 * 台账是累计值，我们已记的量 = primary 桶 + aux 桶，两者都能从 JSONL 重建。
 * 两者之差就是还没记过的部分。差额 > 0 时先登记，延迟一拍再复算：
 *
 *   - 主步骤的 `session.step.ended` 比 `session.usage.updated` 早约 5ms 到达，
 *     复算时 primary 桶已经把账记掉 → 差额归零 → 什么都不做，天然不双计；
 *   - title / compaction 没有对应的 step 行 → 差额始终为正 → 落成
 *     `kind !== "primary"` 的行，写入但不计入面板口径。
 *
 * 逐项钳到 0：台账回退（重置、裁剪）不会算出负数噪声。
 *
 * ## 历史存量不落行
 *
 * 会话可能比插件先存在：此时台账与已记账量的差额是**安装前的历史**，
 * 没有可信的 ts / 模型 / 价格。首次观测到这种差额时把它记为内存基线，
 * 只参与对账、不产生行；新会话（还没有 primary 桶）首次观测到的差额
 * 才是 title 请求，照常落行。
 */

import type { Aggregates, TokenSum } from "./aggregate.ts"

/** `session.usage.updated` 里 tokens 的原始形态。 */
export interface RawUsage {
  readonly input?: number | undefined
  readonly output?: number | undefined
  readonly reasoning?: number | undefined
  readonly cache?: { readonly read?: number | undefined; readonly write?: number | undefined } | undefined
}

export function toTokenSum(u: RawUsage | undefined): TokenSum {
  return {
    input: u?.input ?? 0,
    cacheRead: u?.cache?.read ?? 0,
    cacheWrite: u?.cache?.write ?? 0,
    output: u?.output ?? 0,
    reasoning: u?.reasoning ?? 0,
  }
}

export function positive(t: TokenSum): boolean {
  return t.input > 0 || t.cacheRead > 0 || t.cacheWrite > 0 || t.output > 0 || t.reasoning > 0
}

/**
 * 台账里还没被我们记过的部分。
 * 聚合经由取值函数注入：index.ts 会在启动基线阶段整体替换 `agg`。
 */
export function excessOf(getAgg: () => Aggregates, sid: string, u: RawUsage | undefined): TokenSum {
  const agg = getAgg()
  const b = agg.sessions[sid]
  const a = agg.aux[sid]
  const cur = toTokenSum(u)
  return {
    input: Math.max(0, cur.input - (b?.input ?? 0) - (a?.input ?? 0)),
    cacheRead: Math.max(0, cur.cacheRead - (b?.cacheRead ?? 0) - (a?.cacheRead ?? 0)),
    cacheWrite: Math.max(0, cur.cacheWrite - (b?.cacheWrite ?? 0) - (a?.cacheWrite ?? 0)),
    output: Math.max(0, cur.output - (b?.output ?? 0) - (a?.output ?? 0)),
    reasoning: Math.max(0, cur.reasoning - (b?.reasoning ?? 0) - (a?.reasoning ?? 0)),
  }
}

/** 一条到期待落的辅助请求差额。 */
export interface AuxDue {
  readonly session_id: string
  readonly tokens: TokenSum
}

/**
 * 登记 `session.usage.updated`、按延迟窗口取回该落行的差额。
 * 纯内存、无 I/O——落行由调用方完成（需要 session 元信息与计价）。
 */
export class AuxTracker {
  private readonly cum = new Map<string, RawUsage>()
  private readonly pending = new Map<string, number>()
  /**
   * 观测起点前的历史存量：会话比插件先存在时，台账里那段没有我们的行。
   *
   * 只放内存——重启后基线会重算一次，结果一致。它**不落行**：
   * 这种差额没有可信的 ts / 模型 / 价格，写进 JSONL 只会污染外部统计。
   */
  private readonly basal = new Map<string, TokenSum>()
  /** 每个会话只做一次首次判定，避免历史存量被反复吞掉或反复落行。 */
  private readonly baselined = new Set<string>()

  private readonly getAgg: () => Aggregates
  private readonly delayMs: number

  // 注意：不用参数属性——Node 原生类型剥离不支持，见 AGENTS.md 运行时要求
  constructor(getAgg: () => Aggregates, delayMs: number) {
    this.getAgg = getAgg
    this.delayMs = delayMs
  }

  /** 扣掉已记账的行与历史基线后，台账里仍未记过的部分。 */
  private gap(sid: string, u: RawUsage | undefined): TokenSum {
    const g = excessOf(this.getAgg, sid, u)
    const b = this.basal.get(sid)
    if (!b) return g
    return {
      input: Math.max(0, g.input - b.input),
      cacheRead: Math.max(0, g.cacheRead - b.cacheRead),
      cacheWrite: Math.max(0, g.cacheWrite - b.cacheWrite),
      output: Math.max(0, g.output - b.output),
      reasoning: Math.max(0, g.reasoning - b.reasoning),
    }
  }

  /** 收到一条累计台账。`now` 用于延迟窗口计时。 */
  observe(sid: string, u: RawUsage | undefined, now: number): void {
    if (!u) return
    this.cum.set(sid, u)
    const first = !this.baselined.has(sid)
    if (first) this.baselined.add(sid)

    const gap = this.gap(sid, u)
    if (!positive(gap)) {
      this.pending.delete(sid)
      return
    }
    if (first && this.getAgg().sessions[sid]) {
      // 会话在我们开始观测前就有 primary 行 → 这段差额是历史存量
      //（插件未安装 / 未运行的时段）。记为基线，只对账不落行。
      this.basal.set(sid, gap)
      this.pending.delete(sid)
      return
    }
    // 新会话首次观测（差额正是 title 那次请求）或后续真实差额 → 等延迟窗口落行
    if (!this.pending.has(sid)) this.pending.set(sid, now)
  }

  /**
   * 取回到期的差额并清掉登记（每个 session 同时只有一条）。
   * `force` 用于卸载前：不等延迟窗口，已知差额一律取出。
   */
  due(now: number, force: boolean): AuxDue[] {
    const out: AuxDue[] = []
    for (const [sid, at] of this.pending) {
      if (!force && now - at < this.delayMs) continue
      this.pending.delete(sid)
      const tokens = this.gap(sid, this.cum.get(sid))
      if (positive(tokens)) out.push({ session_id: sid, tokens })
    }
    return out
  }

  get size(): number {
    return this.pending.size
  }
}
