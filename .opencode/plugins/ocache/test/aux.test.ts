import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { AuxTracker, excessOf, positive, toTokenSum, type RawUsage } from "../shared/aux.ts"
import { emptyAggregates, record, type Aggregates } from "../shared/aggregate.ts"

const DELAY = 1_000
const sid = "ses_a"

const session = {
  parent_id: null as string | null,
  title: null as string | null,
  provider_id: "p",
  model_id: "m",
  model_name: null as string | null,
  variant: null as string | null,
  agent: "default",
}

const sum = (input: number, cacheRead = 0, cacheWrite = 0, output = 0, reasoning = 0) => ({
  input,
  cacheRead,
  cacheWrite,
  output,
  reasoning,
})

/** 造一行并计入聚合：primary 进统计桶，其它只进 aux。 */
function add(agg: Aggregates, kind: "primary" | "title" | "compaction" | "generate", t: ReturnType<typeof sum>) {
  record(agg, {
    ts: 1,
    date: "2026-09-26",
    tokens: t,
    cost: 0,
    ok: true,
    kind,
    session_id: sid,
    step_index: 1,
    session,
  })
}

/** 模拟 `session.usage.updated` 的累计台账。 */
const cum = (input: number, cacheRead = 0, output = 0, reasoning = 0): RawUsage => ({
  input,
  output,
  reasoning,
  cache: { read: cacheRead, write: 0 },
})

describe("aux 对账", () => {
  test("RawUsage 归一成五档，缺省补 0", () => {
    assert.deepEqual(toTokenSum(undefined), sum(0))
    assert.deepEqual(toTokenSum({ input: 1, cache: { read: 2, write: 3 }, output: 4, reasoning: 5 }), sum(1, 2, 3, 4, 5))
    assert.deepEqual(toTokenSum({}), sum(0))
    assert.equal(positive(sum(0)), false)
    assert.equal(positive(sum(0, 1)), true)
  })

  test("差额 = 台账 - primary 桶 - aux 桶，逐项钳到 0", () => {
    const agg = emptyAggregates()
    const get = () => agg
    add(agg, "primary", sum(100, 50, 0, 10, 0))
    add(agg, "title", sum(14, 647, 0, 5, 78))

    const left = excessOf(get, sid, cum(114, 697, 15, 78))
    assert.deepEqual(left, sum(0))

    // 台账又多了 compaction 的量
    const ex = excessOf(get, sid, cum(1_114, 697, 115, 78))
    assert.deepEqual(ex, sum(1_000, 0, 0, 100, 0))

    // 台账回退（重置）不产生负数噪声
    assert.deepEqual(excessOf(get, sid, cum(0, 0, 0, 0)), sum(0))
    // 没见过的会话：台账即差额
    assert.deepEqual(excessOf(get, "ses_b", cum(7, 8, 9, 10)), sum(7, 8, 0, 9, 10))
  })

  test("title 差额：延迟窗口内不落，到期才取回", () => {
    const agg = emptyAggregates()
    const tracker = new AuxTracker(() => agg, DELAY)

    tracker.observe(sid, cum(14, 647, 5, 78), 1_000)
    assert.equal(tracker.size, 1)
    assert.deepEqual(tracker.due(1_000 + DELAY - 1, false), [])
    assert.equal(tracker.size, 1, "没到期不能取走")

    const due = tracker.due(1_000 + DELAY, false)
    assert.equal(due.length, 1)
    assert.equal(due[0]!.session_id, sid)
    assert.deepEqual(due[0]!.tokens, sum(14, 647, 0, 5, 78))
    assert.equal(tracker.size, 0, "取走即清")
  })

  test("主步骤的账先记掉 → 到期时差额归零，不落行（防双计）", () => {
    const agg = emptyAggregates()
    const tracker = new AuxTracker(() => agg, DELAY)

    // 台账先到（差额 = 整个主步骤）
    tracker.observe(sid, cum(7_431, 488, 2, 0), 1_000)
    assert.equal(tracker.size, 1)
    // 5ms 后 step.ended 把账记掉
    add(agg, "primary", sum(7_431, 488, 0, 2, 0))

    assert.deepEqual(tracker.due(1_000 + DELAY, false), [])
    assert.equal(tracker.size, 0)
    assert.equal(agg.totals.steps, 1)
  })

  test("aux 落行后再看同一台账不再重复", () => {
    const agg = emptyAggregates()
    const tracker = new AuxTracker(() => agg, DELAY)

    tracker.observe(sid, cum(14, 647, 5, 78), 1_000)
    const due = tracker.due(1_000 + DELAY, false)
    assert.equal(due.length, 1)
    add(agg, "title", due[0]!.tokens)

    // 同一条台账又推了一次（OpenCode 会重复推累计值）
    tracker.observe(sid, cum(14, 647, 5, 78), 5_000)
    assert.equal(tracker.size, 0, "已记账 → 不再登记")
    assert.deepEqual(tracker.due(5_000 + DELAY, false), [])
  })

  test("没差额、没见过、undefined 都不登记", () => {
    const agg = emptyAggregates()
    const tracker = new AuxTracker(() => agg, DELAY)
    add(agg, "primary", sum(100, 10, 0, 5, 0))

    tracker.observe(sid, cum(100, 10, 5, 0), 1_000)
    assert.equal(tracker.size, 0)

    tracker.observe(sid, undefined, 2_000)
    assert.equal(tracker.size, 0)
    assert.deepEqual(tracker.due(9_999, true), [])
  })

  test("force 不等延迟窗口，cleanup 用", () => {
    const agg = emptyAggregates()
    const tracker = new AuxTracker(() => agg, DELAY)
    tracker.observe(sid, cum(500, 0, 0, 0), 1_000)

    const due = tracker.due(1_001, true)
    assert.equal(due.length, 1)
    assert.deepEqual(due[0]!.tokens, sum(500))
  })

  test("台账回退不产生负数，也不被误判成差额", () => {
    const agg = emptyAggregates()
    const tracker = new AuxTracker(() => agg, DELAY)
    add(agg, "primary", sum(1_000))

    // 台账被重置成比已记账还小的值 → 差额钳 0 → 不登记
    tracker.observe(sid, cum(10), 1_000)
    assert.equal(tracker.size, 0)
    assert.deepEqual(tracker.due(9_999, true), [])

    // 台账继续走，超出已记账的部分照常登记
    tracker.observe(sid, cum(1_500), 2_000)
    assert.equal(tracker.size, 1)
    assert.deepEqual(tracker.due(9_999, true)[0]!.tokens, sum(500))
  })

  test("新会话（还没有 primary 桶）首次差额照常落行——那正是 title", () => {
    const agg = emptyAggregates()
    const tracker = new AuxTracker(() => agg, DELAY)
    assert.equal(agg.sessions[sid], undefined)

    tracker.observe(sid, cum(14, 647, 5, 78), 1_000)
    assert.equal(tracker.size, 1)
    assert.deepEqual(tracker.due(1_000 + DELAY, false)[0]!.tokens, sum(14, 647, 0, 5, 78))
  })

  test("观测前就存在的会话：首次差额是历史存量，记基线不落行", () => {
    const agg = emptyAggregates()
    add(agg, "primary", sum(669_013, 16_490_816, 0, 40_556, 90_115))
    const tracker = new AuxTracker(() => agg, DELAY)

    // 台账里还有一段插件安装前的历史（真实线上会话的数值）
    const ledger = cum(1_215_665, 39_428_672, 152_899, 201_047)
    tracker.observe(sid, ledger, 1_000)
    assert.equal(tracker.size, 0, "历史存量不落行")
    assert.deepEqual(tracker.due(9_999, true), [])

    // 同值台账再推一次也不反悔
    tracker.observe(sid, ledger, 2_000)
    assert.deepEqual(tracker.due(9_999, true), [])
    assert.equal(agg.sessions[sid]!.steps, 1, "统计桶不受影响")
  })

  test("基线建立之后，新的辅助请求照常落行", () => {
    const agg = emptyAggregates()
    add(agg, "primary", sum(1_000))
    const tracker = new AuxTracker(() => agg, DELAY)

    tracker.observe(sid, cum(5_000), 1_000) // 4_000 是历史存量 → 基线
    assert.equal(tracker.size, 0)

    tracker.observe(sid, cum(5_400), 2_000) // 一次 compaction
    assert.equal(tracker.size, 1)
    assert.deepEqual(tracker.due(2_000 + DELAY, false)[0]!.tokens, sum(400))

    // 落行后把账记掉 → 不再重复
    add(agg, "compaction", sum(400))
    tracker.observe(sid, cum(5_400), 4_000)
    assert.equal(tracker.size, 0)
  })

  test("聚合整体被替换后取到新对象（注入取值函数而非引用）", () => {
    let agg = emptyAggregates()
    const tracker = new AuxTracker(() => agg, DELAY)
    tracker.observe(sid, cum(500, 0, 0, 0), 1_000)
    assert.equal(tracker.size, 1)

    // 模拟启动基线阶段的 `agg = saved.aggregates` 重赋值，且新对象已含这笔账
    agg = emptyAggregates()
    add(agg, "primary", sum(500))
    assert.deepEqual(tracker.due(1_000 + DELAY, false), [])
  })
})
