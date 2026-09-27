/**
 * TUI 侧栏统计面板（M4 立骨架，M6 上观感）。
 *
 * 架构约束（AGENTS.md）：TUI 只读展示，**永不**读写 ocache 的数据文件。
 * 这里的每一条数字都来自服务端插件发布的快照，通道见 `rpc.ts`：
 * 事件 `updated` 推送为主、1s 轮询兜底，保证"当前会话"块 1 秒内刷新。
 *
 * 响应式写法：所有取值都必须写在 JSX getter 里。Solid 只在 getter 被
 * 读取时才订阅信号——把 `snap()` 提到组件顶层的 const 会让整块面板
 * 永久停在第一次渲染的值上。因此每行都是固定的 <text> 元素（不用
 * .map 动态生成，那会每秒重建整棵子树、在终端里闪），行函数从
 * `shared/format.ts` 引入，可脱离 OpenCode 单测。
 *
 * **配色（M6）**：`shared/format.ts` 只产出"这段字是什么角色"（Tone），
 * 颜色在这里按主题翻译成色值——换主题、改配色都不用动文案与测试。
 * 每行的 `<text fg>` 是**兜底**：万一 `<span style>` 没生效，整行至少还
 * 有标题色 / 正文色 / 分隔线色，而不是全变默认色。
 */
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { OcacheRpc } from "./rpc.ts"
import { emptySnapshot, isSnapshot, type Snapshot } from "./shared/snapshot.ts"
import {
  lineDivider,
  lineHeader,
  lineMonth,
  lineSessionCost,
  lineSessionHit,
  lineSessionMissRead,
  lineSessionRecent,
  lineSessionWriteOut,
  lineToday,
  lineTotal,
  type Seg,
  type Tone,
} from "./shared/format.ts"

/** 兜底轮询间隔：事件推送为主，轮询只补掉漏掉的事件。 */
const POLL_MS = 1000

export default Plugin.define({
  id: "ocache-tui",
  setup(context) {
    const [snap, setSnap] = createSignal<Snapshot>(emptySnapshot())
    const rpc = context.client.rpc(OcacheRpc)
    /**
     * RPC 是按 location 注册的：不带 location 调用会得到 rpc.unavailable
     * （官方 client 文档的示例也是显式传的）。宿主没给 location 时退回 cwd。
     */
    const directory = context.location?.directory ?? process.cwd()
    let pulling = false

    /**
     * 角色 → 主题色。
     *
     * 只用语义令牌（text.base / text.muted / text.action.* / text.feedback.*），
     * 不写死任何色号：亮暗主题、用户自定义主题都会跟着走，
     * 也不会在换主题后出现"某段字看不见"。
     *
     * 每一条都带兜底——主题结构哪天改了，最多是这一段退回正文色，
     * 绝不能让一次取色把整块侧栏掀翻（AGENTS.md：绝不抛出到宿主）。
     *
     * - `title` 与 `money` 同用强调色：面板名在左上角、金额在右侧对齐列，
     *   两处不打架，反而把"这个面板是什么"和"花了多少钱"连成一条语言。
     * - `off`（仅内存）用警示色：没落盘是需要用户反应的状态，
     *   必须与"记录中"的绿色区分开。
     */
    function color(tone: Tone) {
      const text = context.theme?.text
      const base = text?.base
      switch (tone) {
        case "title":
        case "money":
          // 强调色。不走 action.primary.base：未聚焦的按钮色就是正文色，等于没强调；
          // focused 是给"聚焦时反白"用的黑，暗色主题下会看不见。
          // 先取主题里保证可读的文字令牌（暗色主题=accent[200] 的亮青），
          // 再退到 accent 刻度，最后退回正文色——换主题也不会变成看不见的颜色。
          return (
            text?.feedback?.info?.base ??
            context.theme?.hue?.accent?.[200] ??
            base
          )
        case "label":
        case "rule":
          return text?.muted ?? base
        case "up":
        case "on":
          return text?.feedback?.success?.base ?? base
        case "down":
          return text?.feedback?.error?.base ?? base
        case "off":
          return text?.feedback?.warning?.base ?? base
        case "value":
          return base
      }
    }

    /**
     * 一行分段 → 带色的 <span>。
     * 放在 JSX getter 内调用，才会随快照重算；元素本身由 Solid 复用。
     */
    function paint(segs: readonly Seg[]) {
      return segs.map((s) => <span style={{ fg: color(s.tone) }}>{s.text}</span>)
    }

    /** 拉一次快照；失败（服务端未就绪 / 正在热重载）静默等下一轮。 */
    async function pull(): Promise<void> {
      if (pulling) return
      pulling = true
      try {
        // 入参是空对象而不是 undefined：undefined 不是 JSON 值，会被判 invalid_input
        const next: unknown = await rpc.snapshot({}, { location: { directory } })
        if (!isSnapshot(next)) return
        // updated 是服务端"数据最后变化"的时刻，相同就不用重绘
        if (next.updated === snap().updated) return
        setSnap(next)
      } catch {
        // 服务端插件尚未加载或正在重载：保留上一次的数据
      } finally {
        pulling = false
      }
    }

    void pull()
    let stopNotify: (() => void) | null = null
    try {
      stopNotify = rpc.events.on("updated", () => {
        void pull()
      })
    } catch {
      // 订阅不可用时只剩轮询，不影响展示
    }
    const timer = setInterval(() => {
      void pull()
    }, POLL_MS)

    const release = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <box flexDirection="column">
          <text fg={color("title")}>{paint(lineHeader(snap(), input.sessionID))}</text>
          <text fg={color("value")}>{paint(lineSessionHit(snap(), input.sessionID))}</text>
          <text fg={color("value")}>{paint(lineSessionRecent(snap(), input.sessionID))}</text>
          <text fg={color("value")}>{paint(lineSessionMissRead(snap(), input.sessionID))}</text>
          <text fg={color("value")}>{paint(lineSessionWriteOut(snap(), input.sessionID))}</text>
          <text fg={color("value")}>{paint(lineSessionCost(snap(), input.sessionID))}</text>
          <text fg={color("rule")}>{paint(lineDivider())}</text>
          <text fg={color("value")}>{paint(lineToday(snap()))}</text>
          <text fg={color("value")}>{paint(lineMonth(snap()))}</text>
          <text fg={color("value")}>{paint(lineTotal(snap()))}</text>
        </box>
      ),
    })

    return () => {
      release()
      try {
        stopNotify?.()
      } catch {
        /* 订阅已随连接关闭 */
      }
      clearInterval(timer)
    }
  },
})
