/**
 * JSONL 落盘与增量读取（REQUIREMENTS §5.1 / §5.3 / §7）。
 *
 * 写侧：按 session 缓冲，四触发 flush（驻留时间 / 行数 / 字节 / 调用方信号），
 *       同一文件的写入串行化，单次原子追加（整批行拼成一个字符串）。
 * 读侧：字节游标增量同步——JSONL 只追加，游标必落在行边界；
 *       只读新增片段，首次或异常（size < cursor）才全量重读。
 *
 * 本模块不依赖 OpenCode，可单独测试。
 */

import { appendFileSync, createReadStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { appendFile, mkdir, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { META_TYPE, SCHEMA_VERSION, isStepRow, type StepRow } from "./schema.ts"

export interface StoreOptions {
  readonly baseDir: string
  /** false = 完全不落盘（面板仍走内存聚合）。 */
  readonly record: boolean
  readonly flushRows?: number
  readonly flushBytes?: number
  readonly flushAgeMs?: number
  /** 所有缓冲合计上限，超出按最老优先强制 flush。 */
  readonly memoryCapBytes?: number
  readonly currency?: string
  /** 注入时钟，便于测试驻留时间触发。 */
  readonly now?: () => number
  readonly onError?: (err: unknown, where: string) => void
  /**
   * 追加成功后回调该文件的**绝对大小**（字节）。
   * 调用方据此回填读游标——用 stat 而非"上次游标 + 本次字节"，
   * 是为了容忍崩溃留下的半行：那些字节已进文件但不属任何完整行，
   * 以绝对大小为准才不会让下次同步重复读到已计入的行。
   */
  readonly onAppend?: (fileKey: string, sizeAfter: number) => void
}

interface Buf {
  sessionID: string
  monthDir: string
  lines: string[]
  bytes: number
  firstAt: number
  attempts: number
}

const DEFAULTS = {
  flushRows: 100,
  flushBytes: 64 * 1024,
  flushAgeMs: 30_000,
  memoryCapBytes: 5 * 1024 * 1024,
  currency: "$",
}

/** 单个 session 写失败后的重试次数，超过即放弃并上报（不阻塞宿主）。 */
const MAX_ATTEMPTS = 3

export class JsonlStore {
  private readonly baseDir: string
  private readonly record: boolean
  private readonly flushRows: number
  private readonly flushBytes: number
  private readonly flushAgeMs: number
  private readonly memoryCapBytes: number
  private readonly currency: string
  private readonly now: () => number
  private readonly onError: (err: unknown, where: string) => void
  private readonly onAppend: ((fileKey: string, sizeAfter: number) => void) | undefined

  private readonly bufs = new Map<string, Buf>()
  /** session → 归档目录：首次写入固定，跨月/跨重启不变（种子见 readSince）。 */
  private readonly dirs = new Map<string, string>()
  /** file → 进行中的写链，保证同文件串行追加。 */
  private readonly chains = new Map<string, Promise<void>>()
  /** 已确认非空的文件（跳过重复的 meta 探测）。 */
  private readonly known = new Set<string>()
  private readonly active = new Set<Promise<void>>()
  private totalBytes = 0

  constructor(opts: StoreOptions) {
    this.baseDir = opts.baseDir
    this.record = opts.record
    this.flushRows = opts.flushRows ?? DEFAULTS.flushRows
    this.flushBytes = opts.flushBytes ?? DEFAULTS.flushBytes
    this.flushAgeMs = opts.flushAgeMs ?? DEFAULTS.flushAgeMs
    this.memoryCapBytes = opts.memoryCapBytes ?? DEFAULTS.memoryCapBytes
    this.currency = opts.currency ?? DEFAULTS.currency
    this.now = opts.now ?? Date.now
    this.onError = opts.onError ?? (() => {})
    this.onAppend = opts.onAppend
  }

  /** 由 readSince 的结果喂入，让重启后同一 session 仍写回原文件。 */
  rememberDir(sessionID: string, monthDir: string): void {
    if (!this.dirs.has(sessionID)) this.dirs.set(sessionID, monthDir)
  }

  /** 当前进程已知的 session → 归档目录，随聚合缓存一起持久化。 */
  dirsSnapshot(): Record<string, string> {
    return Object.fromEntries(this.dirs)
  }

  /** 追加一行（传入已序列化的 JSON，不含换行）。 */
  push(sessionID: string, monthDir: string, json: string): void {
    if (!this.record) return
    this.rememberDir(sessionID, monthDir)
    const dir = this.dirs.get(sessionID) as string
    let b = this.bufs.get(sessionID)
    if (!b) {
      b = { sessionID, monthDir: dir, lines: [], bytes: 0, firstAt: this.now(), attempts: 0 }
      this.bufs.set(sessionID, b)
    }
    const line = json.endsWith("\n") ? json : `${json}\n`
    const n = Buffer.byteLength(line, "utf8")
    b.lines.push(line)
    b.bytes += n
    this.totalBytes += n
    if (this.totalBytes > this.memoryCapBytes) this.forceOldest()
  }

  /** 该 session 是否已满足 flush 触发条件。 */
  isDue(sessionID: string): boolean {
    const b = this.bufs.get(sessionID)
    if (!b) return false
    return (
      this.now() - b.firstAt >= this.flushAgeMs ||
      b.lines.length >= this.flushRows ||
      b.bytes >= this.flushBytes
    )
  }

  dueSessions(): string[] {
    return [...this.bufs.keys()].filter((id) => this.isDue(id))
  }

  /** 由调用方 ticker 驱动（如每秒一次）。 */
  async flushDue(): Promise<void> {
    await Promise.all(this.dueSessions().map((id) => this.flush(id)))
  }

  /** 未缓冲的全部落盘（unload / 进程退出）。 */
  async flushAll(): Promise<void> {
    await Promise.all([...this.bufs.keys()].map((id) => this.flush(id)))
    await Promise.all([...this.active])
  }

  pending(): { sessions: number; rows: number; bytes: number } {
    let rows = 0
    for (const b of this.bufs.values()) rows += b.lines.length
    return { sessions: this.bufs.size, rows, bytes: this.totalBytes }
  }

  /**
   * 立即落盘该 session 的缓冲。同文件写入串行，不同文件并行。
   * 失败只记日志并按次数回缓冲，绝不向上抛。
   */
  flush(sessionID: string): Promise<void> {
    const b = this.bufs.get(sessionID)
    if (!b) return Promise.resolve()
    this.bufs.delete(sessionID)
    this.totalBytes -= b.bytes
    if (b.lines.length === 0) return Promise.resolve()

    const file = path.join(this.baseDir, b.monthDir, `${sessionID}.jsonl`)
    const fileKey = `${b.monthDir}/${sessionID}.jsonl`
    const prev = this.chains.get(file) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(async () => {
      try {
        await mkdir(path.dirname(file), { recursive: true })
        let payload = b.lines.join("")
        if (!this.known.has(file) && (await needMeta(file))) payload = `${this.meta()}\n${payload}`
        await appendFile(file, payload, "utf8")
        this.known.add(file)
        this.reportAppend(file, fileKey)
      } catch (err) {
        this.restore(b, err)
      }
    })
    this.chains.set(file, next)
    const tracked = next.finally(() => {
      if (this.chains.get(file) === next) this.chains.delete(file)
    })
    this.track(tracked)
    return tracked
  }

  private meta(): string {
    return JSON.stringify({
      type: META_TYPE,
      schema: SCHEMA_VERSION,
      record: true,
      price_tag: this.currency,
      created: this.now(),
    })
  }

  /** stat 失败只记日志：游标晚一拍不要紧，下次同步会用 size<cursor 判断补正。 */
  private reportAppend(file: string, fileKey: string): void {
    if (!this.onAppend) return
    try {
      this.onAppend(fileKey, statSync(file).size)
    } catch (err) {
      this.onError(err, `stat:${fileKey}`)
    }
  }

  /**
   * 进程 `exit` 钩子专用：同步落盘所有缓冲。
   * 异步通道在此不可用，失败直接记日志放弃（尽力而为，不抛）。
   */
  flushSync(): void {
    if (!this.record) return
    for (const b of [...this.bufs.values()]) {
      if (b.lines.length === 0) continue
      const file = path.join(this.baseDir, b.monthDir, `${b.sessionID}.jsonl`)
      const fileKey = `${b.monthDir}/${b.sessionID}.jsonl`
      try {
        mkdirSync(path.dirname(file), { recursive: true })
        let payload = b.lines.join("")
        if (!this.known.has(file) && !fileNonEmpty(file)) payload = `${this.meta()}\n${payload}`
        appendFileSync(file, payload, "utf8")
        this.known.add(file)
        this.bufs.delete(b.sessionID)
        this.totalBytes -= b.bytes
        this.reportAppend(file, fileKey)
      } catch (err) {
        // 同步路径无法重试，直接上报并丢弃该批（避免 exit 时无限循环）
        this.bufs.delete(b.sessionID)
        this.totalBytes -= b.bytes
        this.onError(err, `flushSync:${b.sessionID}`)
      }
    }
  }

  private track(p: Promise<void>): void {
    this.active.add(p)
    void p.finally(() => this.active.delete(p))
  }

  private forceOldest(): void {
    const sorted = [...this.bufs.values()].sort(
      (a, b) => a.firstAt - b.firstAt || (a.sessionID < b.sessionID ? -1 : 1),
    )
    for (const b of sorted) {
      if (this.totalBytes <= this.memoryCapBytes) break
      this.track(this.flush(b.sessionID))
    }
  }

  private restore(b: Buf, err: unknown): void {
    b.attempts += 1
    this.onError(err, `flush:${b.sessionID}`)
    if (b.attempts >= MAX_ATTEMPTS) return // 放弃，避免无限重试占内存
    const cur = this.bufs.get(b.sessionID)
    if (cur) {
      // 失败批次比新缓冲更老，前插保持行序
      cur.lines = [...b.lines, ...cur.lines]
      cur.bytes += b.bytes
      cur.firstAt = Math.min(cur.firstAt, b.firstAt)
      cur.attempts = b.attempts
    } else {
      this.bufs.set(b.sessionID, b)
    }
    this.totalBytes += b.bytes
  }
}

/** 文件不存在或为空才需要 meta 头；其他错误上抛由调用方回缓冲。 */
async function needMeta(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size === 0
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true
    throw err
  }
}

/** needMeta 的同步版，仅供 flushSync 使用。 */
function fileNonEmpty(file: string): boolean {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}

const DAY_MS = 86_400_000

/**
 * 删除超出保留期的月份目录（REQUIREMENTS §5.1 可选项）。
 * 默认 retentionDays=0 即不清理——数据自主是本项目的价值主张。
 * 开启后，被删月份的行不再存在于文件中，全量重建时历史合计会相应缩小。
 * 同步实现，只在进程启动时调用一次；删除失败仅记日志。
 */
export function pruneOldMonths(
  baseDir: string,
  retentionDays: number,
  now: number = Date.now(),
  onError?: (err: unknown, where: string) => void,
): string[] {
  if (retentionDays <= 0) return []
  const cutoff = now - retentionDays * DAY_MS
  const removed: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(baseDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") onError?.(err, "prune:readdir")
    return removed
  }
  for (const name of entries) {
    if (!MONTH_DIR.test(name)) continue
    const dir = path.join(baseDir, name)
    try {
      // 目录 mtime 取其中最新文件的修改时间，避免刚写入的旧归档被误删
      const newest = Math.max(
        0,
        ...readdirSync(dir).map((f) => statSync(path.join(dir, f)).mtimeMs),
      )
      if (newest >= cutoff) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(name)
    } catch (err) {
      onError?.(err, `prune:${name}`)
    }
  }
  return removed
}

export interface SyncResult {
  /** 新增/变更文件里的数据行（已跳过 meta 与坏行）。 */
  readonly rows: StepRow[]
  /** 全量游标（含未变动文件），可直接整体持久化。 */
  readonly cursors: Record<string, number>
  /** sessionID → 归档目录，用于重启后写回原文件。 */
  readonly sessionDirs: Record<string, string>
  /** 游标大于文件体积（被截断/重建）而全量重读的文件。 */
  readonly rebuilt: string[]
}

const MONTH_DIR = /^\d{4}-\d{2}$/

/**
 * 增量同步：只读 `cursors` 之后的新增字节。
 * 返回的 cursors 永远停在最后一个完整行的行尾——崩溃留下的半行下次再读，
 * 不会因为游标越过它而永久丢失。
 */
export async function readSince(
  baseDir: string,
  cursors: Record<string, number> = {},
  onError?: (err: unknown, where: string) => void,
): Promise<SyncResult> {
  const outCursors: Record<string, number> = {}
  const sessionDirs: Record<string, string> = {}
  const rebuilt: string[] = []
  const rows: StepRow[] = []

  let months: string[] = []
  try {
    months = (await readdir(baseDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && MONTH_DIR.test(d.name))
      .map((d) => d.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") onError?.(err, "readdir")
    return { rows: [], cursors: {}, sessionDirs: {}, rebuilt: [] }
  }

  for (const month of months.sort()) {
    let files: string[] = []
    try {
      files = (await readdir(path.join(baseDir, month)))
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
    } catch (err) {
      onError?.(err, `readdir:${month}`)
      continue
    }
    for (const name of files) {
      const key = `${month}/${name}`
      const file = path.join(baseDir, month, name)
      sessionDirs[name.slice(0, -".jsonl".length)] = month
      let cursor = cursors[key]
      try {
        const size = (await stat(file)).size
        let start = 0
        if (cursor !== undefined) {
          if (cursor > size) {
            rebuilt.push(key)
            cursor = 0
          }
          start = cursor
        }
        if (start < size) {
          const { text, complete } = await readFrom(file, start)
          for (const line of text.split("\n")) {
            if (line === "") continue
            try {
              const v: unknown = JSON.parse(line)
              if (isStepRow(v)) rows.push(v)
            } catch {
              // 坏行跳过：游标按字节推进，不因个别损坏行卡死
            }
          }
          outCursors[key] = start + complete
        } else {
          outCursors[key] = size
        }
      } catch (err) {
        onError?.(err, `sync:${key}`)
        if (cursor !== undefined) outCursors[key] = cursor // 保留旧游标，下次重试
      }
    }
  }

  // 注意：outCursors 只含真实存在的文件，被删除文件的陈旧游标自然被剔除
  return { rows, cursors: outCursors, sessionDirs, rebuilt }
}

/** 读 `start` 起的字节，只返回到最后一个换行为止（完整行）。 */
async function readFrom(file: string, start: number): Promise<{ text: string; complete: number }> {
  const chunks: string[] = []
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(file, { start, encoding: "utf8" })
    rs.on("data", (c: string) => chunks.push(c))
    rs.on("end", resolve)
    rs.on("error", reject)
  })
  const data = chunks.join("")
  const nl = data.lastIndexOf("\n")
  if (nl < 0) return { text: "", complete: 0 }
  const text = data.slice(0, nl + 1)
  return { text, complete: Buffer.byteLength(text, "utf8") }
}
