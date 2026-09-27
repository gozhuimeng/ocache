/**
 * TUI 侧栏统计面板（M4 立骨架，M6 上观感）。
 *
 * 架构约束（AGENTS.md）：TUI 只读展示，**永不**读写 ocache 的数据文件。
 * 这里的每一条数字都来自服务端插件发布的快照，通道见 `rpc.ts`：
 * 事件 `updated` 推送为主、1s 轮询兜底，保证"当前会话"块 1 秒内刷新。
 *
 * 响应式写法：所有取值都必须写在 JSX getter 里。Solid 只在 getter 被
 * 读取时才订阅信号——把 `snap()` 提到组件顶层的 const 会让整块面板
 * 永久停在第一次渲染的值上。因此每行都是写死的 <text> 元素（不用
 * .map 动态生成，那会每秒重建整棵子树、在终端里闪），行函数从
 * `shared/format.ts` 引入，可脱离 OpenCode 单测。
 *
 * **行数随布局变（M6）**：三档布局显示 14 / 10 / 2 行。空的 `<text>` 实测
 * 会占一整行，所以"不显示"是**不挂节点**——每行外面套一层
 * `show(layout(), 行名)` 守卫。行数只跟布局走、跟数据无关，节点结构
 * 仅在切换布局那一瞬变一次，不构成上面说的"每秒重建"。
 * 十四行的书写顺序必须与 `FULL_ORDER` 一致，反查测试会逐条比对。
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
  isPanelLayout,
  lineDivider,
  lineHeader,
  lineMonth,
  lineMonthDetail,
  lineRuleBottom,
  lineRuleTop,
  lineSessionCost,
  lineSessionHit,
  lineSessionMissRead,
  lineSessionRecent,
  lineSessionSuccess,
  lineSessionWriteOut,
  lineToday,
  lineTodayDetail,
  lineTotal,
  lineTotalDetail,
  NEXT_LAYOUT,
  show,
  type PanelLayout,
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

    /** UI 侧的失败只记日志，绝不抛向宿主（同服务端插件的约定）。 */
    const log = (err: unknown, where: string): void => {
      console.error(`[ocache-tui] ${where}:`, err)
    }

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

    /**
     * 面板密度：`opencode.json` 的 `options.layout` 给默认值，
     * 命令面板里的切换在本次 TUI 会话内覆盖它。
     *
     * 用 `storage.memory` 而不是 `store`：它跨热重载存活（改完配置重载插件
     * 不会把手动切过的档冲掉）、TUI 退出即消失，而且**不产生任何文件**——
     * TUI 侧永不写数据是 AGENTS.md 的硬约束，连"配置状态"也不落盘。
     *
     * `seed` 记下当初的配置值：配置一旦改过，下次重载就以配置为准，
     * 免得出现"改了 opencode.json 却不生效"这种最难查的怪事。
     */
    const cfgLayout: PanelLayout = isPanelLayout(context.options?.layout)
      ? context.options.layout
      : "full"
    const [panel, setPanel] = context.storage.memory("ocache.panel", {
      initial: { layout: cfgLayout as string, seed: cfgLayout as string },
    })
    if (panel.seed !== cfgLayout) {
      setPanel((d) => {
        d.layout = cfgLayout
        d.seed = cfgLayout
      })
    }
    const layout = (): PanelLayout =>
      isPanelLayout(panel.layout) ? panel.layout : cfgLayout

    /** 三档的人话标签，切完用 toast 报一声，免得用户以为按了没反应。 */
    const LAYOUT_LABEL: Record<PanelLayout, string> = {
      full: "展开",
      compact: "紧凑",
      collapsed: "折叠",
    }

    /**
     * 面板密度切换命令：**只进命令面板**，不绑快捷键、不注册斜杠命令。
     *
     * - 不绑键：抢键位表里的键会静默吃掉宿主的默认行为，而这份插件是要
     *   装进别人全局配置的，撞键的代价不该由使用者承担。
     * - 不带斜杠：D5 约定"不提供任何命令、配置只走 opencode.json"。
     *   这里给的是运行时开关（配置仍是默认值），所以刻意留在 `slash` 之外。
     *
     * **为什么写在 slot 的 render 里、而不是 setup**：`keymap.layer` 要求
     * 调用点处在 `Keymap.Provider` 的组件树中，`setup` 阶段还没有这棵树，
     * 直接调会抛 `Keymap.Provider is missing` 并**连带把整个插件 setup
     * 打挂**（M6 实测：面板直接退回上一代代码）。官方文档里命令示例也是
     * 写在 slot 的 render 里的，照它来。
     */
    const releaseKeys = context.ui.slot({
      append: "app",
      render: () => {
        try {
          context.keymap.layer(() => ({
            mode: "global",
            priority: 10,
            commands: [
              {
                id: "ocache.layout.cycle",
                title: "切换 ocache 面板密度",
                description: "展开 / 紧凑 / 折叠 三档循环",
                group: "ocache",
                palette: true,
                suggested: true,
                enabled: () => true,
                run: () => {
                  const next = NEXT_LAYOUT[layout()]
                  setPanel((d) => {
                    d.layout = next
                  })
                  context.ui.toast.show({
                    message: `ocache 面板：${LAYOUT_LABEL[next]}`,
                    variant: "info",
                  })
                },
              },
            ],
            bindings: ["ocache.layout.cycle"],
          }))
        } catch (err) {
          // 命令拿不到只是少一个运行时开关，面板本身照常
          log(err, "keymap")
        }
        return null
      },
    })

    /**
     * 用 `prepend` 而不是 `append`：面板要排在侧栏**最前**——紧跟会话标题、
     * 压在用户那个老插件 `opencode-visual-cache`（占 21 行）之上。
     *
     * 这不只是好看：侧栏总高是固定的（实测 44 行），`append` 会把我们排到
     * 末尾、正好卡在 Context/MCP 之后，14 行的展开态只露得出 11 行，
     * `累计` 那两行直接被切掉。同一锚点上多条 claim 按插件启用顺序排，
     * 我们 `prepend` 之后至少保证自己在最前面，不会被别的面板挤出屏幕。
     */
    const release = context.ui.slot({
      prepend: "sidebar.content",
      render: (input) => (
        <box flexDirection="column">
          {/* 十六行的顺序 = FULL_ORDER；每行外面的守卫决定它在当前档出不出场 */}
          {show(layout(), "lineRuleTop") && (
            <text fg={color("rule")}>{paint(lineRuleTop())}</text>
          )}
          {show(layout(), "lineHeader") && (
            <text fg={color("title")}>{paint(lineHeader(snap(), input.sessionID))}</text>
          )}
          {show(layout(), "lineSessionHit") && (
            <text fg={color("value")}>{paint(lineSessionHit(snap(), input.sessionID))}</text>
          )}
          {show(layout(), "lineSessionSuccess") && (
            <text fg={color("value")}>{paint(lineSessionSuccess(snap(), input.sessionID))}</text>
          )}
          {show(layout(), "lineSessionRecent") && (
            <text fg={color("value")}>{paint(lineSessionRecent(snap(), input.sessionID))}</text>
          )}
          {show(layout(), "lineSessionMissRead") && (
            <text fg={color("value")}>{paint(lineSessionMissRead(snap(), input.sessionID))}</text>
          )}
          {show(layout(), "lineSessionWriteOut") && (
            <text fg={color("value")}>{paint(lineSessionWriteOut(snap(), input.sessionID))}</text>
          )}
          {show(layout(), "lineSessionCost") && (
            <text fg={color("value")}>{paint(lineSessionCost(snap(), input.sessionID))}</text>
          )}
          {show(layout(), "lineDivider") && <text fg={color("rule")}>{paint(lineDivider())}</text>}
          {show(layout(), "lineToday") && (
            <text fg={color("value")}>{paint(lineToday(snap(), layout()))}</text>
          )}
          {show(layout(), "lineTodayDetail") && (
            <text fg={color("value")}>{paint(lineTodayDetail(snap()))}</text>
          )}
          {show(layout(), "lineMonth") && (
            <text fg={color("value")}>{paint(lineMonth(snap(), layout()))}</text>
          )}
          {show(layout(), "lineMonthDetail") && (
            <text fg={color("value")}>{paint(lineMonthDetail(snap()))}</text>
          )}
          {show(layout(), "lineTotal") && (
            <text fg={color("value")}>{paint(lineTotal(snap(), layout()))}</text>
          )}
          {show(layout(), "lineTotalDetail") && (
            <text fg={color("value")}>{paint(lineTotalDetail(snap()))}</text>
          )}
          {show(layout(), "lineRuleBottom") && (
            <text fg={color("rule")}>{paint(lineRuleBottom())}</text>
          )}
        </box>
      ),
    })

    return () => {
      release()
      releaseKeys()
      try {
        stopNotify?.()
      } catch {
        /* 订阅已随连接关闭 */
      }
      clearInterval(timer)
    }
  },
})
