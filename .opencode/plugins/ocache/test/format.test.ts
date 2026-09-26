import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  fmtCount,
  fmtInt,
  fmtCost,
  fmtPct,
  NO_DATA,
  lineHeader,
  lineSessionCounts,
  lineSessionMissRead,
  lineSessionWriteOut,
  lineSessionReasonCost,
  lineToday,
  lineMonth,
  lineTotal,
} from "../shared/format.ts"
import {
  emptySnapshot,
  isSnapshot,
  subtreeBucketOf,
  subtreeIds,
  SNAPSHOT_SCHEMA,
  type SessionSnapshot,
  type Snapshot,
} from "../shared/snapshot.ts"

function sess(over: Partial<SessionSnapshot> & { session_id: string }): SessionSnapshot {
  return {
    session_title: null,
    parent_id: null,
    last_ts: 1,
    steps: 0,
    ok: 0,
    error: 0,
    input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    currency: "¥",
    provider_id: null,
    model_id: null,
    model_name: null,
    variant: null,
    agent: null,
    ...over,
  }
}

function snap(over: Partial<Snapshot>): Snapshot {
  return { ...emptySnapshot("¥"), ...over }
}

describe("fmtCount", () => {
  test("小数走 K，999 以内原样", () => {
    assert.equal(fmtCount(0), "0")
    assert.equal(fmtCount(999), "999")
    assert.equal(fmtCount(1000), "1.0K")
    assert.equal(fmtCount(-1234), "-1.2K")
    assert.equal(fmtCount(123456), "123K")
  })

  test("大数走 K/M/G", () => {
    assert.equal(fmtCount(10000), "10.0K")
    assert.equal(fmtCount(100000), "100K")
    assert.equal(fmtCount(1234567), "1.2M")
    assert.equal(fmtCount(2.5e9), "2.5G")
  })

  test("进位跨档不出 1000.0K", () => {
    assert.equal(fmtCount(999400), "999K")
    assert.equal(fmtCount(999949), "1.0M")
    assert.equal(fmtCount(999950), "1.0M")
    assert.equal(fmtCount(999999), "1.0M")
  })

  test("非法值退占位", () => {
    assert.equal(fmtCount(Number.NaN), NO_DATA)
    assert.equal(fmtCount(Number.POSITIVE_INFINITY), NO_DATA)
  })
})

describe("fmtInt", () => {
  test("请求数千分位，不缩写", () => {
    assert.equal(fmtInt(0), "0")
    assert.equal(fmtInt(5), "5")
    assert.equal(fmtInt(1234), "1,234")
    assert.equal(fmtInt(1234.6), "1,235")
    assert.equal(fmtInt(Number.NaN), NO_DATA)
  })
})

describe("fmtPct", () => {
  test("一位小数并去掉 .0", () => {
    assert.equal(fmtPct(0), "0%")
    assert.equal(fmtPct(1), "100%")
    assert.equal(fmtPct(0.917), "91.7%")
    assert.equal(fmtPct(0.5), "50%")
    assert.equal(fmtPct(0.9999), "100%")
    assert.equal(fmtPct(0.123456), "12.3%")
  })
})

describe("fmtCost", () => {
  test("按量级取小数位 + 自定义货币标签", () => {
    assert.equal(fmtCost(0, "¥"), "¥0")
    assert.equal(fmtCost(12.3456, "¥"), "¥12.35")
    assert.equal(fmtCost(1.5, "¥"), "¥1.50")
    assert.equal(fmtCost(0.0234, "¥"), "¥0.0234")
    assert.equal(fmtCost(0.045, "credits"), "credits0.045")
    assert.equal(fmtCost(1234.5, "$"), "$1,234.50")
  })

  test("极小额不被抹成 0", () => {
    assert.equal(fmtCost(0.0001234, "¥"), "¥0.000123")
    assert.notEqual(fmtCost(0.0001234, "¥"), fmtCost(0, "¥"))
  })

  test("非法值退占位", () => {
    assert.equal(fmtCost(Number.NaN, "¥"), NO_DATA)
  })
})

describe("会话子树（M5：子会话聚合到父会话）", () => {
  const sessions = {
    root: sess({ session_id: "root", steps: 2, ok: 2, input: 100, cache_read: 900 }),
    child: sess({ session_id: "child", parent_id: "root", steps: 1, error: 1, input: 50 }),
    grand: sess({
      session_id: "grand",
      parent_id: "child",
      steps: 1,
      ok: 1,
      output: 40,
      reasoning: 10,
      cost: 0.5,
    }),
    lone: sess({ session_id: "lone", steps: 9 }),
  }

  test("ids 含自身与全部后代", () => {
    assert.deepEqual(subtreeIds(sessions, "root").sort(), ["child", "grand", "root"])
    assert.deepEqual(subtreeIds(sessions, "child").sort(), ["child", "grand"])
    assert.deepEqual(subtreeIds(sessions, "grand"), ["grand"])
    assert.deepEqual(subtreeIds(sessions, "lone"), ["lone"])
  })

  test("不在快照里的会话返回空列表与空桶", () => {
    assert.deepEqual(subtreeIds(sessions, "nope"), [])
    assert.deepEqual(subtreeBucketOf(sessions, "nope"), {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      steps: 0,
      ok: 0,
      error: 0,
      cost: 0,
    })
  })

  test("合计 = 自身 + 子 + 孙，且不含旁系", () => {
    const b = subtreeBucketOf(sessions, "root")
    assert.equal(b.steps, 4)
    assert.equal(b.ok, 3)
    assert.equal(b.error, 1)
    assert.equal(b.input, 150)
    assert.equal(b.cacheRead, 900)
    assert.equal(b.output, 40)
    assert.equal(b.reasoning, 10)
    assert.equal(b.cost, 0.5)
    assert.equal(b.input + b.output + b.reasoning + b.cacheRead + b.cacheWrite, 1100)
    // 旁系会话不能被算进来
    assert.notEqual(subtreeBucketOf(sessions, "lone").steps, b.steps)
  })

  test("缓存读写字段名从快照的 snake_case 归一", () => {
    const s = { a: sess({ session_id: "a", cache_read: 7, cache_write: 3 }) }
    const b = subtreeBucketOf(s, "a")
    assert.equal(b.cacheRead, 7)
    assert.equal(b.cacheWrite, 3)
  })
})

describe("面板行", () => {
  const sessions = {
    s1: sess({
      session_id: "s1",
      session_title: "GGG",
      agent: "build",
      model_name: "mimo-v2.6-flash-free",
      steps: 4,
      ok: 3,
      error: 1,
      input: 1234,
      cache_read: 56789,
      cache_write: 890,
      output: 1456,
      reasoning: 900,
      cost: 0.0234,
    }),
    sub: sess({ session_id: "sub", parent_id: "s1", steps: 1, ok: 1 }),
  }
  const s = snap({ sessions })

  test("标题行：面板名 + 聚合范围 + 记录状态", () => {
    // 快照未到（updated=0）时不显示状态，避免闪一句"仅内存"
    assert.equal(lineHeader(emptySnapshot("¥"), "x"), "Token 用量")
    const solo = snap({ updated: 1, record: true, sessions: { x: sess({ session_id: "x" }) } })
    assert.equal(lineHeader(solo, "x"), "Token 用量 · ● 记录中")
    // s 是首帧之前的快照（updated=0），补上更新时间才会有状态尾巴
    assert.equal(lineHeader({ ...s, updated: 1 }, "s1"), "Token 用量 +1 子会话 · ○ 仅内存")
    // 会话还没数据时同样只报聚合范围，具体行各自退 "—"
    assert.equal(
      lineHeader(snap({ updated: 1, record: true }), "未见过"),
      "Token 用量 · ● 记录中",
    )
  })

  test("无数据的会话每行给占位而不是一串 0", () => {
    assert.equal(lineSessionCounts(s, "未见过"), NO_DATA)
    assert.equal(lineSessionMissRead(s, "未见过"), NO_DATA)
    assert.equal(lineSessionWriteOut(s, "未见过"), NO_DATA)
    assert.equal(lineSessionReasonCost(s, "未见过"), NO_DATA)
  })

  test("行文案包含四档用量、命中率、成功率与费用", () => {
    assert.equal(lineSessionCounts(s, "s1"), "请求 5 · 成功 80% · 命中 96.4%")
    assert.equal(lineSessionMissRead(s, "s1"), "未命中 1.2K · 缓存读 56.8K")
    assert.equal(lineSessionWriteOut(s, "s1"), "缓存写 890 · 输出 1.5K")
    assert.equal(lineSessionReasonCost(s, "s1"), "推理 900 · 费用 ¥0.0234")
  })

  test("历史三口径按 agg 缺失降级", () => {
    const withAgg = snap({
      agg: {
        totals: {
          input: 1,
          cacheRead: 2,
          cacheWrite: 3,
          output: 4,
          reasoning: 5,
          steps: 1234,
          ok: 1230,
          error: 4,
          cost: 5.67,
        },
        today: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          steps: 12,
          ok: 12,
          error: 0,
          cost: 0.045,
        },
        month: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          steps: 340,
          ok: 337,
          error: 3,
          cost: 1.23,
        },
      },
    })
    assert.equal(lineToday(withAgg), "今日 ¥0.045 · 100% 成功")
    assert.equal(lineMonth(withAgg), "本月 ¥1.23 · 99.1% 成功")
    assert.equal(lineTotal(withAgg), "累计 ¥5.67 · 1,234 请求 · 99.7% 成功")

    const empty = snap({ agg: null })
    assert.equal(lineToday(empty), NO_DATA)
    assert.equal(lineMonth(empty), NO_DATA)
    assert.equal(lineTotal(empty), NO_DATA)
  })
})

describe("快照读取端容错", () => {
  test("emptySnapshot 字段齐全、可被 isSnapshot 接受", () => {
    const e = emptySnapshot("¥")
    assert.equal(e.schema, SNAPSHOT_SCHEMA)
    assert.equal(e.updated, 0)
    assert.equal(e.agg, null)
    assert.deepEqual(e.sessions, {})
    assert.ok(isSnapshot(e))
    assert.ok(isSnapshot({ updated: 1, currency: "$", sessions: {}, agg: null }))
    // agg 允许缺省（旧版快照），由行函数降级
    assert.ok(isSnapshot({ updated: 1, currency: "$", sessions: {} }))
  })

  test("畸形回包一律拒绝", () => {
    assert.equal(isSnapshot(null), false)
    assert.equal(isSnapshot("x"), false)
    assert.equal(isSnapshot({}), false)
    assert.equal(isSnapshot({ updated: 1, currency: "$" }), false)
    assert.equal(isSnapshot({ updated: "1", currency: "$", sessions: {} }), false)
    assert.equal(isSnapshot({ updated: 1, currency: "$", sessions: {}, agg: 3 }), false)
  })
})
