/**
 * 服务端主插件（D9 / AGENTS.md 架构约束）：
 * 数据采集、计费、缓冲落盘、聚合全部在这里完成，覆盖 headless 场景，
 * 且服务端是唯一进程 → 单写者。TUI 侧只读快照，永不写数据文件。
 *
 * 数据链路：事件 → buildRow → 聚合（内存）+ JsonlStore（缓冲落盘）
 *                ↓
 *          .snapshot.json / ctx.storage  ←—— TUI 只读
 *
 * 依赖的事件与钩子字段名全部以安装的 @opencode/{client,plugin} 类型定义为准
 * （v2.0.18），不凭记忆编写。
 *
 * 运行时纪律（AGENTS.md）：
 *   - 任何数据链路失败只记日志，绝不抛到宿主；
 *   - 事件循环与 ticker 均可被 cleanup 取消；
 *   - 进程 exit 前尽力 flushSync。
 */

import { Plugin } from "@opencode/plugin"
import { parseConfig, effectiveCurrency } from "./shared/config.ts"
import { resolveBaseDir } from "./shared/paths.ts"
import { JsonlStore, readSince, pruneOldMonths, type SyncResult } from "./shared/store.ts"
import {
  emptyAggregates,
  record,
  snapshotOf,
  seedStepCounters,
  type Aggregates,
  type TokenSum,
} from "./shared/aggregate.ts"
import {
  readAggregate,
  writeAggregate,
  writeSnapshot,
  selectSessions,
  SNAPSHOT_SCHEMA,
  type Snapshot,
} from "./shared/snapshot.ts"
import {
  buildRow,
  pickModelCost,
  rowTokens,
  rowMonth,
  type ModelCostEntry,
} from "./shared/row.ts"
import { resolvePrice, type ModelPrice } from "./shared/billing.ts"
import { AuxTracker, type RawUsage } from "./shared/aux.ts"
import { toDate, toMonthDir, type Kind, type Status, type StepRow } from "./shared/schema.ts"

/** Model.Ref 的形状（@opencode/schema）。 */
interface ModelRefLike {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

/** 一次模型请求的归属信息，来自 session.step.started。 */
interface StepInfo {
  readonly model: ModelRefLike
  readonly agent: string
  /** 记录时刻，用于 step.ended 迟迟不来时的兜底清理。 */
  readonly at: number
}

/** http.response 钩子入队的一条请求记录（D13 打标依据）。 */
interface KindEntry {
  readonly kind: Kind
  readonly model: string // providerID/modelID
  readonly agent: string
  readonly at: number
}

/** 会话元数据缓存（session.get 结果 + rename 后的更新）。 */
interface CachedMeta {
  session_id: string
  session_title: string | null
  parent_id: string | null
  project: string | null
  model: ModelRefLike | undefined
  agent: string | undefined
}

interface ModelEntry {
  readonly name: string
  readonly price: ModelPrice | undefined
}

/** step.ended / step.failed 的公共字段（两事件的交集，便于统一处理）。 */
interface StepEndData {
  readonly sessionID: string
  readonly assistantMessageID: string
  readonly created: number
  readonly finish?: string | undefined
  readonly tokens?:
    | { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    | undefined
  readonly error?: { type: string; message: string; status?: number | undefined } | undefined
}

/** kind 条目的消费窗口：超出即视为陈旧，宁可回退 primary 也不误标。 */
const KIND_WINDOW_MS = 15_000
/** stepInfo 泄漏保护：step.ended 迟迟不来时的兜底清理。 */
const STEP_INFO_TTL_MS = 300_000
const MODEL_TTL_MS = 300_000
/** 每 session 的 kind 队列长度上限，防极端情况内存膨胀。 */
const KIND_QUEUE_MAX = 8
/**
 * 辅助请求落行前的等待时间。
 * `session.usage.updated` 比 `session.step.ended` 晚约 5ms，
 * 等一拍再复算差额，主步骤的账就能先记掉，天然避免双计。
 */
const AUX_DELAY_MS = 1_000
/** kind 兜底判定的时间窗：kindQ 取不到时用事件时序猜。 */
const KIND_FALLBACK_MS = 30_000
/** 快照写入的存储键（与 TUI 插件同 id → 同命名空间，M0 验证点 V3）。 */
const SNAPSHOT_KEY = "snapshot"

export default Plugin.define({
  id: "token-stats",
  async setup(ctx) {
    const cfg = parseConfig(ctx.options)
    const baseDir = resolveBaseDir()
    const currency = effectiveCurrency(cfg)

    /** 数据链路失败只记日志，绝不抛向宿主。 */
    const log = (err: unknown, where: string): void => {
      console.error(`[token-stats] ${where}:`, err)
    }

    /**
     * storage.set 只接受纯 JSON（Schema.Json）。
     * 序列化一遍即可去掉品牌类型、undefined 与循环引用，比手工构造便宜。
     */
    type JsonValue = Parameters<typeof ctx.storage.set>[1]
    const toJsonValue = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue

    // ── 内存状态 ────────────────────────────────────────────────
    let agg: Aggregates = emptyAggregates()
    /** 文件键 → 已计入聚合的字节偏移（绝对大小，见 store.onAppend）。 */
    let cursors: Record<string, number> = {}
    let lastSessionID: string | null = null
    let disposed = false
    /** 数据版本号：只在真正变化时写快照，避免空转 I/O。 */
    let dataVersion = 0
    let writtenVersion = -1
    let lastSnapshotAt = 0

    const stepInfo = new Map<string, StepInfo>()
    const metaCache = new Map<string, CachedMeta>()
    const stepCounter = new Map<string, number>()
    const kindQ = new Map<string, KindEntry[]>()
    /** 辅助请求对账：title / compaction 只发累计台账，见 shared/aux.ts。 */
    const aux = new AuxTracker(() => agg, AUX_DELAY_MS)
    const compactionAt = new Map<string, number>()
    const renamedAt = new Map<string, number>()
    let modelMap: Map<string, ModelEntry> | null = null
    let modelAt = 0

    // ── 落盘（record=false 时 store 完全不产生文件）──────────────
    const store = new JsonlStore({
      baseDir,
      record: cfg.record,
      flushAgeMs: cfg.flushAgeMs,
      flushRows: cfg.flushRows,
      flushBytes: cfg.flushBytes,
      memoryCapBytes: cfg.memoryCapBytes,
      currency,
      onError: (err, where) => log(err, where),
      // 追加成功 → 用文件绝对大小回填游标，保证 persist 的 cursors
      // 与"已计入聚合的行"严格对应（崩溃后重启不重复计数）。
      onAppend: (fileKey, sizeAfter) => {
        cursors[fileKey] = sizeAfter
      },
    })

    function ingestRow(row: StepRow): void {
      record(agg, {
        ts: row.ts,
        date: row.date,
        tokens: rowTokens(row),
        cost: row.cost,
        ok: row.status === "ok",
        kind: row.kind,
        session_id: row.session_id,
        step_index: row.step_index,
        session: {
          parent_id: row.parent_id,
          title: row.session_title,
          provider_id: row.provider_id,
          model_id: row.model_id,
          model_name: row.model_name,
          variant: row.variant,
          agent: row.agent,
        },
      })
      // 重启后续接 step_index：取历史最大值，避免从 1 重新计数
      const cur = stepCounter.get(row.session_id) ?? 0
      if (row.step_index > cur) stepCounter.set(row.session_id, row.step_index)
      dataVersion += 1
    }

    // ── 启动基线：聚合缓存 + 字节游标增量同步（D7）────────────────
    if (cfg.record) {
      pruneOldMonths(baseDir, cfg.retentionDays, Date.now(), log)
      try {
        let rebuild = false
        const saved = await readAggregate(baseDir)
        if (saved) {
          // 老版本缓存没有 step_index 字段 → 与文件不再严格对应，
          // 宁可全量重扫一次自愈，也不能让编号与文件脱节。
          const legacy = Object.values(saved.aggregates.sessions).some(
            (b) => typeof b.step_index !== "number",
          )
          if (legacy) rebuild = true
          else {
            agg = saved.aggregates
            cursors = saved.cursors
          }
        }

        let sync: SyncResult = { rows: [], cursors, sessionDirs: {}, rebuilt: [] }
        if (!rebuild) sync = await readSince(baseDir, cursors, log)
        if (sync.rebuilt.length > 0 || rebuild) {
          if (sync.rebuilt.length > 0) {
            console.error(`[token-stats] files rebuilt: ${sync.rebuilt.join(", ")}`)
          } else {
            console.error("[token-stats] legacy aggregate cache; full rescan")
          }
          agg = emptyAggregates()
          cursors = {}
          sync = await readSince(baseDir, {}, log)
        }

        for (const row of sync.rows) ingestRow(row)
        cursors = sync.cursors
        // 归档目录种子：重启后同一 session 仍写回原文件
        for (const [sid, month] of Object.entries(sync.sessionDirs)) store.rememberDir(sid, month)
      } catch (err) {
        log(err, "baseline")
      }
      // 续接每会话的 step_index：必须在 readSince 之外单独做，
      // 因为游标已覆盖全部行时 readSince 不返回任何行，编号会从 1 重来。
      for (const [sid, n] of seedStepCounters(agg)) {
        if (n > (stepCounter.get(sid) ?? 0)) stepCounter.set(sid, n)
      }
    }

    // ── 快照发布（storage 主通道 + record 时的文件兜底通道）────────
    function buildSnapshot(now: number): Snapshot {
      const sessions = selectSessions(agg.sessions, currency)
      const active =
        lastSessionID && agg.sessions[lastSessionID]
          ? lastSessionID
          : (Object.entries(agg.sessions).sort((a, b) => b[1].last_ts - a[1].last_ts)[0]?.[0] ??
            null)
      return {
        schema: SNAPSHOT_SCHEMA,
        updated: now,
        record: cfg.record,
        currency,
        last_session_id: active,
        sessions,
        agg: snapshotOf(agg, toDate(now), toMonthDir(now)),
      }
    }

    async function refreshSnapshot(force = false): Promise<void> {
      if (disposed && !force) return
      const now = Date.now()
      if (!force) {
        if (dataVersion === writtenVersion) return
        if (now - lastSnapshotAt < cfg.snapshotMs) return
      }
      lastSnapshotAt = now
      writtenVersion = dataVersion
      const snap = buildSnapshot(now)
      // 通道一：ctx.storage（不产生本插件的任何文件 → 满足 record=false 的验收）
      try {
        await ctx.storage.set(SNAPSHOT_KEY, toJsonValue(snap))
      } catch (err) {
        log(err, "snapshot:storage")
      }
      // 通道二：快照文件（record 开启时的兜底与调试通道）
      if (cfg.record) await writeSnapshot(baseDir, snap, (err) => log(err, "snapshot:file"))
    }

    async function persist(): Promise<void> {
      if (!cfg.record) return
      try {
        // 先把缓冲全部落盘，再连同游标一起持久化——
        // 保证 .aggregate.json 里的"聚合内容"与"游标覆盖的字节"严格一致。
        await store.flushAll()
        await writeAggregate(
          baseDir,
          { schema: 1, aggregates: agg, cursors, sessionDirs: store.dirsSnapshot() },
          (err) => log(err, "persist:file"),
        )
      } catch (err) {
        log(err, "persist")
      }
    }

    // ── 事件处理 ────────────────────────────────────────────────
    async function ensureMeta(sid: string): Promise<CachedMeta> {
      const hit = metaCache.get(sid)
      if (hit) return hit
      let m: CachedMeta
      try {
        const info = await ctx.session.get({ sessionID: sid })
        m = {
          session_id: sid,
          session_title: info.title ?? null,
          parent_id: info.parentID ?? null,
          project: info.location?.directory ?? ctx.location.project?.directory ?? null,
          model: info.model ?? undefined,
          agent: info.agent ?? undefined,
        }
      } catch (err) {
        log(err, `session.get:${sid}`)
        m = {
          session_id: sid,
          session_title: null,
          parent_id: null,
          project: null,
          model: undefined,
          agent: undefined,
        }
      }
      metaCache.set(sid, m)
      return m
    }

    async function ensureModels(): Promise<Map<string, ModelEntry>> {
      if (modelMap && Date.now() - modelAt < MODEL_TTL_MS) return modelMap
      try {
        const res = (await ctx.model.list()) as unknown
        const data = Array.isArray(res) ? res : ((res as { data?: unknown[] })?.data ?? [])
        const next = new Map<string, ModelEntry>()
        for (const raw of data) {
          const m = raw as {
            providerID?: unknown
            id?: unknown
            modelID?: unknown
            name?: unknown
            cost?: unknown
          }
          if (typeof m.providerID !== "string" || m.providerID === "") continue
          const entry: ModelEntry = {
            name:
              typeof m.name === "string" && m.name !== ""
                ? m.name
                : typeof m.modelID === "string"
                  ? m.modelID
                  : "",
            price: pickModelCost(Array.isArray(m.cost) ? (m.cost as ModelCostEntry[]) : undefined),
          }
          // 逻辑 id 与上游 modelID 都登记：step 事件里的 Model.Ref.id 用哪个都能命中
          if (typeof m.id === "string" && m.id !== "") next.set(`${m.providerID}/${m.id}`, entry)
          if (typeof m.modelID === "string" && m.modelID !== "")
            next.set(`${m.providerID}/${m.modelID}`, entry)
        }
        modelMap = next
        modelAt = Date.now()
        return next
      } catch (err) {
        log(err, "model.list")
        return modelMap ?? new Map()
      }
    }

    /**
     * 取本步的请求性质（D13）。
     *
     * http.response 与 step.ended 的先后不保证一一对应（重试、title 请求
     * 可能不产生 step 事件），因此用"取最近一条与本步 model+agent 匹配的
     * 记录，并丢弃它之前的全部条目"：既容忍并发的 title 请求排在前面，
     * 又不会把上一步的残留带进下一步。拿不准时回退 "primary"。
     */
    function takeKind(sid: string, providerID: string, modelID: string, agent: string): Kind {
      const q = kindQ.get(sid)
      if (!q || q.length === 0) return "primary"
      const now = Date.now()
      const fresh = q.filter((e) => now - e.at <= KIND_WINDOW_MS)
      if (fresh.length === 0) {
        kindQ.delete(sid)
        return "primary"
      }
      const want = `${providerID}/${modelID}`
      let idx = -1
      for (let i = fresh.length - 1; i >= 0; i--) {
        const e = fresh[i]!
        if (e.model === want && e.agent === agent) {
          idx = i
          break
        }
      }
      if (idx < 0) idx = fresh.length - 1 // 无精确匹配时取最近一条
      const chosen = fresh[idx]!
      kindQ.set(sid, fresh.slice(idx + 1))
      return chosen.kind
    }

    /**
     * 取出队列里最近一条指定 kind 的请求记录（title / compaction 专用）。
     * `session.usage.recorded` 只带 sessionID + source + tokens，
     * 模型与 agent 只能从 http.response 钩子的记录里拿。
     * 取不到就返回 null，由调用方回落 session 元信息。
     */
    function takeKindInfo(sid: string, kind: Kind): { model: string; agent: string } | null {
      const q = kindQ.get(sid)
      if (!q || q.length === 0) return null
      const now = Date.now()
      const fresh = q.filter((e) => now - e.at <= KIND_WINDOW_MS)
      if (fresh.length === 0) {
        kindQ.delete(sid)
        return null
      }
      let idx = -1
      for (let i = fresh.length - 1; i >= 0; i--) {
        if (fresh[i]!.kind === kind) {
          idx = i
          break
        }
      }
      if (idx < 0) return null
      const chosen = fresh[idx]!
      kindQ.set(sid, fresh.slice(idx + 1))
      return { model: chosen.model, agent: chosen.agent }
    }

    function normalizeTs(created: number): number {
      if (Number.isFinite(created) && created > 1e12) return created
      if (Number.isFinite(created) && created > 1e9) return created * 1000
      return Date.now()
    }

    async function finishStep(data: StepEndData, status: Status): Promise<void> {
      const sid = data.sessionID
      const info = stepInfo.get(data.assistantMessageID)
      stepInfo.delete(data.assistantMessageID)
      const meta = await ensureMeta(sid)
      const modelRef = info?.model ?? meta.model
      const agent = info?.agent ?? meta.agent ?? "default"
      const providerID = modelRef?.providerID ?? "unknown"
      const modelID = modelRef?.id ?? "unknown"
      const kind = takeKind(sid, providerID, modelID, agent)
      const models = await ensureModels()
      const entry = models.get(`${providerID}/${modelID}`)
      const price = resolvePrice(cfg, entry?.price)
      const idx = (stepCounter.get(sid) ?? 0) + 1
      stepCounter.set(sid, idx)

      const row = buildRow({
        ts: normalizeTs(data.created),
        session: meta,
        step_index: idx,
        provider_id: providerID,
        model_id: modelID,
        model_name: entry?.name ?? null,
        variant: modelRef?.variant ?? null,
        agent,
        kind,
        finish: data.finish ?? (status === "error" ? "error" : null),
        status,
        error_type: status === "error" ? (data.error?.type ?? null) : null,
        error_status: status === "error" ? (data.error?.status ?? null) : null,
        tokens: data.tokens
          ? {
              input: data.tokens.input,
              cacheRead: data.tokens.cache.read,
              cacheWrite: data.tokens.cache.write,
              output: data.tokens.output,
              reasoning: data.tokens.reasoning,
            }
          : undefined,
        currency,
        price,
      })

      ingestRow(row)
      lastSessionID = sid
      if (cfg.record) store.push(sid, rowMonth(row), JSON.stringify(row))
      await refreshSnapshot()
    }

    /** `"provider/modelID"` → `[provider, modelID]`；形态不对返回 null。 */
    function splitRef(ref: string | undefined): [string, string] | null {
      if (!ref) return null
      const i = ref.indexOf("/")
      if (i <= 0 || i === ref.length - 1) return null
      return [ref.slice(0, i), ref.slice(i + 1)]
    }

    /**
     * `session.usage.updated`：每个请求结束后 OpenCode 都推一次**累计**台账
     * （主步骤、title、compaction 一视同仁）。这里只登记差额，
     * 落行交给 ticker 延迟复算——算法与理由见 shared/aux.ts。
     */
    function onUsage(sid: string, u: RawUsage | undefined): void {
      aux.observe(sid, u, Date.now())
    }

    /** 判定辅助请求的 kind 与模型归属：优先 http.response 钩子，其次事件时序。 */
    function pickAuxKind(sid: string, now: number): { kind: Kind; model?: string; agent?: string } {
      const c = takeKindInfo(sid, "compaction")
      if (c) return { kind: "compaction", ...c }
      const t = takeKindInfo(sid, "title")
      if (t) return { kind: "title", ...t }
      const lastC = compactionAt.get(sid)
      if (lastC !== undefined && now - lastC <= KIND_FALLBACK_MS) return { kind: "compaction" }
      const lastR = renamedAt.get(sid)
      if (lastR !== undefined && now - lastR <= KIND_FALLBACK_MS) return { kind: "title" }
      return { kind: "generate" }
    }

    /**
     * 把已登记的差额落成一行辅助请求（D13：写入但不计入面板口径）。
     * title 行的 `session_title` 可能是 null——正是这次请求在生成标题。
     */
    async function recordAux(sid: string, tokens: TokenSum, now: number): Promise<void> {
      const picked = pickAuxKind(sid, now)
      const meta = await ensureMeta(sid)
      const ref = splitRef(picked.model)
      const providerID = ref?.[0] ?? meta.model?.providerID ?? "unknown"
      const modelID = ref?.[1] ?? meta.model?.id ?? "unknown"
      const agent = picked.agent ?? meta.agent ?? "default"
      const models = await ensureModels()
      const entry = models.get(`${providerID}/${modelID}`)
      const price = resolvePrice(cfg, entry?.price)
      const idx = (stepCounter.get(sid) ?? 0) + 1
      stepCounter.set(sid, idx)

      const row = buildRow({
        ts: now,
        session: meta,
        step_index: idx,
        provider_id: providerID,
        model_id: modelID,
        model_name: entry?.name ?? null,
        variant: meta.model?.variant ?? null,
        agent,
        kind: picked.kind,
        finish: null,
        status: "ok",
        error_type: null,
        error_status: null,
        tokens,
        currency,
        price,
      })

      ingestRow(row)
      if (cfg.record) store.push(sid, rowMonth(row), JSON.stringify(row))
      await refreshSnapshot()
    }

    /**
     * 取回到期差额并落行（每条独立兜错）。
     * `force` 给 cleanup 用——宁可少等 1s 也不把已知差额丢在内存里。
     */
    async function reconcileAux(now: number, force: boolean): Promise<void> {
      for (const { session_id, tokens } of aux.due(now, force)) {
        try {
          await recordAux(session_id, tokens, now)
        } catch (err) {
          log(err, "aux")
        }
      }
    }

    async function onEvent(ev: { type: string; data?: unknown }): Promise<void> {
      const d = ev.data as Record<string, unknown> | undefined
      if (!d) return
      switch (ev.type) {
        case "session.step.started": {
          const model = d.model as ModelRefLike | undefined
          if (model && typeof d.assistantMessageID === "string") {
            stepInfo.set(d.assistantMessageID, {
              model,
              agent: typeof d.agent === "string" ? d.agent : "default",
              at: Date.now(),
            })
          }
          break
        }
        case "session.step.ended":
          await finishStep(d as unknown as StepEndData, "ok")
          break
        case "session.step.failed":
          await finishStep(d as unknown as StepEndData, "error")
          break
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          // 回合结束 → 立即落盘（D12 四触发之一）
          if (cfg.record && typeof d.sessionID === "string") {
            try {
              await store.flush(d.sessionID)
            } catch (err) {
              log(err, "flush:execution")
            }
          }
          break
        case "session.renamed": {
          const sid = d.sessionID
          if (typeof sid !== "string" || typeof d.title !== "string") break
          renamedAt.set(sid, Date.now())
          const m = metaCache.get(sid)
          if (m) m.session_title = d.title
          const b = agg.sessions[sid]
          if (b) b.title = d.title
          dataVersion += 1
          await refreshSnapshot()
          break
        }
        case "session.compaction.started":
          if (typeof d.sessionID === "string") compactionAt.set(d.sessionID, Date.now())
          break
        case "session.usage.updated":
          // 主步骤 / title / compaction 全部汇到这里，靠差额区分（见 onUsage）
          if (typeof d.sessionID === "string") onUsage(d.sessionID, d.tokens as RawUsage | undefined)
          break
        case "model.updated":
        case "provider.updated":
          modelMap = null // 计价依据变化，下次取价前重建
          break
      }
    }

    // ── 订阅事件流 ──────────────────────────────────────────────
    const ac = new AbortController()
    const disposers: Array<() => Promise<void>> = []
    const loop = (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
          if (disposed) break
          try {
            await onEvent(ev as unknown as { type: string; data?: unknown })
          } catch (err) {
            log(err, `event:${(ev as { type?: string }).type}`)
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) log(err, "event:stream")
      }
    })()

    // ── D13：http.response 打标 ─────────────────────────────────
    try {
      const reg = await ctx.session.hook("http.response", (e) => {
        try {
          const arr = kindQ.get(e.sessionID) ?? []
          arr.push({
            kind: e.kind as Kind,
            model: `${e.model.providerID}/${e.model.id}`,
            agent: String(e.agent),
            at: Date.now(),
          })
          if (arr.length > KIND_QUEUE_MAX) arr.splice(0, arr.length - KIND_QUEUE_MAX)
          kindQ.set(e.sessionID, arr)
        } catch (err) {
          log(err, "http.response")
        }
      })
      disposers.push(reg.dispose)
    } catch (err) {
      log(err, "hook:http.response") // 钩子拿不到时所有行按 primary 计，功能不中断
    }

    // ── Ticker：flush 触发扫描 + 聚合持久化 + 快照发布 ───────────
    let lastPersistAt = Date.now()
    const timer = setInterval(() => {
      void tick()
    }, 500)
    timer.unref?.()

    function cleanupStale(): void {
      const now = Date.now()
      for (const [sid, arr] of kindQ) {
        const alive = arr.filter((e) => now - e.at <= KIND_WINDOW_MS)
        if (alive.length === 0) kindQ.delete(sid)
        else if (alive.length !== arr.length) kindQ.set(sid, alive)
      }
      for (const [key, info] of stepInfo) {
        if (now - info.at > STEP_INFO_TTL_MS) stepInfo.delete(key)
      }
    }

    async function tick(): Promise<void> {
      if (disposed) return
      // 先落辅助请求：这一步会 push 新行，随后的 flush / persist 才能一并覆盖
      try {
        await reconcileAux(Date.now(), false)
      } catch (err) {
        log(err, "reconcileAux")
      }
      try {
        await store.flushDue()
      } catch (err) {
        log(err, "flushDue")
      }
      cleanupStale()
      const now = Date.now()
      if (cfg.record && now - lastPersistAt >= cfg.persistMs) {
        lastPersistAt = now
        await persist()
      }
      await refreshSnapshot()
    }

    // ── 进程退出兜底：同步 flush，尽力不丢最后一个 flush 周期 ──────
    const onExit = (): void => {
      try {
        store.flushSync()
      } catch (err) {
        log(err, "flushSync")
      }
    }
    process.once("exit", onExit)

    // 启动即发布一次，TUI 一打开就有数据
    await refreshSnapshot(true)

    return async () => {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      process.removeListener("exit", onExit)
      ac.abort()
      for (const d of disposers) {
        try {
          await d()
        } catch (err) {
          log(err, "dispose")
        }
      }
      // 等事件循环退出，避免清理后仍有行写入
      await Promise.race([
        loop,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000)
          t.unref?.()
        }),
      ])
      // 已登记但还没到复算时间的差额，卸载前强制落掉（限时，防止 ctx 已不可用时卡住）
      try {
        await Promise.race([
          reconcileAux(Date.now(), true),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1500)
            t.unref?.()
          }),
        ])
      } catch (err) {
        log(err, "aux:cleanup")
      }
      await persist()
      await refreshSnapshot(true)
    }
  },
})
