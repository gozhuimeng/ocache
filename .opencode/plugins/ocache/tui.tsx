/**
 * TUI 侧栏统计面板（M4）。
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
 */
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { OcacheRpc } from "./rpc.ts"
import { emptySnapshot, isSnapshot, type Snapshot } from "./shared/snapshot.ts"
import {
  lineHeader,
  lineMonth,
  lineSessionCounts,
  lineSessionMissRead,
  lineSessionReasonCost,
  lineSessionRecent,
  lineSessionWriteOut,
  lineToday,
  lineTotal,
} from "./shared/format.ts"

/** 兜底轮询间隔：事件推送为主，轮询只补掉漏掉的事件。 */
const POLL_MS = 1000

/** 无数据时的分隔行；宽度按侧栏常见尺寸取，不随终端宽度变化。 */
const DIVIDER = "────────────────────"

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
          <text>{lineHeader(snap(), input.sessionID)}</text>
          <text>{lineSessionCounts(snap(), input.sessionID)}</text>
          <text>{lineSessionRecent(snap(), input.sessionID)}</text>
          <text>{lineSessionMissRead(snap(), input.sessionID)}</text>
          <text>{lineSessionWriteOut(snap(), input.sessionID)}</text>
          <text>{lineSessionReasonCost(snap(), input.sessionID)}</text>
          <text>{DIVIDER}</text>
          <text>{lineToday(snap())}</text>
          <text>{lineMonth(snap())}</text>
          <text>{lineTotal(snap())}</text>
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
