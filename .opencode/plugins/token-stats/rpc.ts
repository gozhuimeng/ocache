/**
 * 服务端 ↔ TUI 的 RPC 契约（M4 / 验证点 V3）。
 *
 * 为什么不用 storage：服务端 `ctx.storage.set()` 落在 `opencode.db` 的 kv 表
 * （键形如 `plugin:<plugin id hex>:snapshot`），而 TUI 侧
 * `context.storage.store()` 读的是另一套命名空间——实测读到的永远是
 * `initial`，写进去的服务端也看不到（V3 结论：两侧不互通）。
 *
 * 因此快照改走 OpenCode 插件 RPC：服务端在 setup 里 register，
 * TUI 用 `context.client.rpc(TokenStatsRpc)` 拉取并订阅 `updated` 推送。
 * 这条通道只返回内存聚合，`record=false` 时不产生任何文件也能正常显示面板。
 *
 * 契约只声明"是个对象"，字段结构由 shared/snapshot.ts 的 Snapshot 保证：
 * JSON Schema 描述 30 个字段得不偿失，破坏性变更靠 Snapshot.schema 版本号。
 */
import { Rpc } from "@opencode/plugin/rpc"

export const TokenStatsRpc = Rpc.define({
  id: "token-stats",
  methods: {
    /**
     * 取当前内存快照；服务端插件未加载时会返回 rpc.method_not_found。
     * `input` 用空 schema：类型上 `Method.input` 必填（与文档"可省略"不一致），
     * 空 schema 匹配任意值，调用方零参数调用也不会被判 invalid_input。
     */
    snapshot: {
      input: {},
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {
    /** 快照已更新。负载刻意留空：TUI 收到后重新 snapshot()，避免重复描述结构。 */
    updated: {
      schema: { type: "object", additionalProperties: false },
    },
  },
})
