import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  fmtCount,
  fmtInt,
  fmtCost,
  fmtPct,
  NO_DATA,
  DIVIDER,
  lineHeader,
  lineSessionCounts,
  lineSessionRecent,
  lineSessionMissRead,
  lineSessionWriteOut,
  lineSessionReasonCost,
  lineToday,
  lineMonth,
  lineTotal,
  renderPanel,
} from "../shared/format.ts"
import {
  emptySnapshot,
  isSnapshot,
  subtreeBucketOf,
  subtreeIds,
  subtreeRecentOf,
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
    recent: [],
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

  test("dp 指定小数位（缓存命中用 2 位）", () => {
    assert.equal(fmtPct(0.963945, 2), "96.39%")
    assert.equal(fmtPct(0.985, 2), "98.50%") // 非整数固定两位，保留 0
    assert.equal(fmtPct(0.975), "97.5%") // 默认仍是 1 位
    // 整数值不带小数尾巴：0 / 100 / 恰好整数百分比都不显示 .00
    assert.equal(fmtPct(0, 2), "0%")
    assert.equal(fmtPct(1, 2), "100%")
    assert.equal(fmtPct(0.97, 2), "97%")
    assert.equal(fmtPct(NaN, 2), NO_DATA)
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
    assert.equal(lineHeader(emptySnapshot("¥"), "x"), "ocache")
    const solo = snap({ updated: 1, record: true, sessions: { x: sess({ session_id: "x" }) } })
    assert.equal(lineHeader(solo, "x"), "ocache · ● 记录中")
    // s 是首帧之前的快照（updated=0），补上更新时间才会有状态尾巴
    assert.equal(lineHeader({ ...s, updated: 1 }, "s1"), "ocache +1 子会话 · ○ 仅内存")
    // 会话还没数据时同样只报聚合范围，具体行各自退 "—"
    assert.equal(
      lineHeader(snap({ updated: 1, record: true }), "未见过"),
      "ocache · ● 记录中",
    )
  })

  test("无数据的会话每行给占位而不是一串 0", () => {
    assert.equal(lineSessionCounts(s, "未见过"), NO_DATA)
    assert.equal(lineSessionMissRead(s, "未见过"), NO_DATA)
    assert.equal(lineSessionWriteOut(s, "未见过"), NO_DATA)
    assert.equal(lineSessionReasonCost(s, "未见过"), NO_DATA)
  })

  test("行文案包含四档用量、命中率、成功率与费用", () => {
    assert.equal(lineSessionCounts(s, "s1"), "请求 5 · 成功 80% · 命中 96.39%")
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

describe("本次命中率与环比", () => {
  /** 39/40 = 97.5% */
  const HI = { input: 1, cacheRead: 39, cacheWrite: 0 }
  /** 239/250 = 95.6% */
  const LO = { input: 11, cacheRead: 239, cacheWrite: 0 }
  const at = (ts: number, t: typeof HI) => ({ ts, ...t })

  test("首次请求没有基线：只显示命中率，不带符号", () => {
    const s = snap({ sessions: { s1: sess({ session_id: "s1", recent: [at(200, HI)] }) } })
    assert.equal(lineSessionRecent(s, "s1"), "本次 97.50%")
  })

  test("上升带 +、下降带 -，不用箭头", () => {
    const up = snap({ sessions: { s1: sess({ session_id: "s1", recent: [at(200, HI), at(100, LO)] }) } })
    assert.equal(lineSessionRecent(up, "s1"), "本次 97.50% +1.90%")

    const down = snap({ sessions: { s1: sess({ session_id: "s1", recent: [at(200, LO), at(100, HI)] }) } })
    assert.equal(lineSessionRecent(down, "s1"), "本次 95.60% -1.90%")
  })

  test("与上次持平不显示 +0%", () => {
    const s = snap({ sessions: { s1: sess({ session_id: "s1", recent: [at(200, HI), at(100, HI)] }) } })
    assert.equal(lineSessionRecent(s, "s1"), "本次 97.50%")
  })

  test("命中率取两位小数，一位小数会被抹平的差异能显示出来", () => {
    // hitRate = cacheRead / (input + cacheRead + cacheWrite)
    // A = 197/200 = 98.50%   B = 395/400 = 98.75%
    // 一位小数下是 98.5% → 98.8%，看着像普通的 0.3 个百分点；
    // 两位小数才能读出确切的 "+0.25%"
    const A = { input: 3, cacheRead: 197, cacheWrite: 0 }
    const B = { input: 5, cacheRead: 395, cacheWrite: 0 }
    const s = snap({ sessions: { s1: sess({ session_id: "s1", recent: [at(200, B), at(100, A)] }) } })
    assert.equal(lineSessionRecent(s, "s1"), "本次 98.75% +0.25%")
  })

  test("整百分比不带小数尾巴，避免 97.00% 这种噪音", () => {
    const FULL = { input: 0, cacheRead: 100, cacheWrite: 0 } // 100%
    const s = snap({ sessions: { s1: sess({ session_id: "s1", recent: [at(200, FULL)] }) } })
    assert.equal(lineSessionRecent(s, "s1"), "本次 100%")
  })

  test("子树跨会话取全局最近两条，而不是各取各的", () => {
    const s = snap({
      sessions: {
        root: sess({ session_id: "root", recent: [at(300, HI), at(50, HI)] }),
        child: sess({ session_id: "child", parent_id: "root", recent: [at(200, LO)] }),
      },
    })
    // 正确取法：300 的 HI 与 200 的 LO → +1.90%
    // 若退化成"只看 root 自己两条"，会得到两条 HI → 无符号
    assert.equal(lineSessionRecent(s, "root"), "本次 97.50% +1.90%")
    // 子会话自己的子树只有一条，没有基线 → 不带符号
    assert.equal(lineSessionRecent(s, "child"), "本次 95.60%")
  })

  test("会话还没写过成功请求、或未见过该会话 → 占位", () => {
    assert.equal(lineSessionRecent(snap({ sessions: {} }), "没有"), NO_DATA)
    const none = snap({ sessions: { s1: sess({ session_id: "s1" }) } })
    assert.equal(lineSessionRecent(none, "s1"), NO_DATA)
  })

  test("子树最近两条按 ts 倒序，超出两条的直接丢弃", () => {
    const s = snap({
      sessions: {
        root: sess({ session_id: "root", recent: [at(10, HI), at(90, LO)] }),
        child: sess({ session_id: "child", parent_id: "root", recent: [at(50, HI), at(70, LO), at(30, HI)] }),
      },
    })
    const got = subtreeRecentOf(s.sessions, "root")
    assert.deepEqual(
      got.map((e) => e.ts),
      [90, 70],
    )
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

describe("整块面板端到端断言（M5/A2）", () => {
  /**
   * 主会话 + 一个子会话。数字全部取整到能手算核对的量级：
   *
   * 子树合计 = steps 105 / ok 104 / error 1
   *          input 1600 · cache_read 148400 · output 5300 · reasoning 3200 · cost 1.30
   * 成功 = 104/105 = 99.048% → 一位 "99%"
   * 命中 = 148400/150000 = 98.933% → 两位 "98.93%"
   */
  const sessions = {
    root: sess({
      session_id: "root",
      session_title: "主会话",
      agent: "build",
      last_ts: 300,
      steps: 100,
      ok: 99,
      error: 1,
      input: 1000,
      cache_read: 98900,
      output: 5000,
      reasoning: 3000,
      cost: 1.2345,
      recent: [{ ts: 300, input: 1, cacheRead: 39, cacheWrite: 0 }], // 39/40 = 97.50%
    }),
    child: sess({
      session_id: "child",
      parent_id: "root",
      last_ts: 200,
      steps: 5,
      ok: 5,
      input: 600,
      cache_read: 49500,
      output: 300,
      reasoning: 200,
      cost: 0.0655,
      recent: [{ ts: 200, input: 11, cacheRead: 239, cacheWrite: 0 }], // 95.60%
    }),
  }
  const agg = {
    totals: {
      input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5,
      steps: 12345, ok: 12300, error: 45, cost: 1234.5,
    },
    today: {
      input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
      steps: 12, ok: 12, error: 0, cost: 0.045,
    },
    month: {
      input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
      steps: 340, ok: 337, error: 3, cost: 1.23,
    },
  }
  const s = snap({ updated: 1, record: true, sessions, agg })

  test("面板恒为 10 行", () => {
    assert.equal(renderPanel(s, "root").length, 10)
    assert.equal(renderPanel(snap({}), "x").length, 10)
  })

  test("十行全串逐行断言：子会话聚合 + 两位小数命中率 + 三口径", () => {
    assert.deepEqual(
      renderPanel(s, "root").map((l) => l.text),
      [
        "ocache +1 子会话 · ● 记录中",
        "请求 105 · 成功 99% · 命中 98.93%",
        "本次 97.50% +1.90%",
        "未命中 1.6K · 缓存读 148K",
        "缓存写 0 · 输出 5.3K",
        "推理 3.2K · 费用 ¥1.30",
        DIVIDER,
        "今日 ¥0.045 · 100% 成功",
        "本月 ¥1.23 · 99.1% 成功",
        "累计 ¥1,234.50 · 12,345 请求 · 99.6% 成功",
      ],
    )
  })

  test("记录状态三态：首帧不显示 / 仅内存 / 记录中", () => {
    // updated=0（首帧快照还没到）→ 不带状态尾巴，避免闪一句"仅内存"误导
    assert.equal(renderPanel(snap({ sessions }), "root")[0]!.text, "ocache +1 子会话")
    const off = snap({ updated: 1, record: false, sessions, agg })
    assert.equal(renderPanel(off, "root")[0]!.text, "ocache +1 子会话 · ○ 仅内存")
    assert.equal(renderPanel(s, "root")[0]!.text, "ocache +1 子会话 · ● 记录中")
  })

  test("会话毫无数据：标题行照常，第 2~6 行整片占位，历史三口径不受影响", () => {
    const empty = snap({ updated: 1, record: true, agg })
    assert.deepEqual(
      renderPanel(empty, "没见过的会话").map((l) => l.text),
      [
        "ocache · ● 记录中",
        NO_DATA,
        NO_DATA,
        NO_DATA,
        NO_DATA,
        NO_DATA,
        DIVIDER,
        "今日 ¥0.045 · 100% 成功",
        "本月 ¥1.23 · 99.1% 成功",
        "累计 ¥1,234.50 · 12,345 请求 · 99.6% 成功",
      ],
    )
  })

  test("历史口径整体缺失时也还是 10 行，不会塌成 7 行", () => {
    const noAgg = snap({ updated: 1, record: true, sessions })
    const got = renderPanel(noAgg, "root").map((l) => l.text)
    assert.equal(got.length, 10)
    assert.equal(got[7], NO_DATA)
    assert.equal(got[8], NO_DATA)
    assert.equal(got[9], NO_DATA)
  })

  /**
   * tui.tsx 用**十条固定 `<text>`** 而不是 `.map(renderPanel)`——
   * `.map` 每秒重建整棵子树、终端里会闪（REQUIREMENTS §4 实现约束）。
   * 代价是渲染顺序与 `renderPanel` 分居两处，会被人改乱。
   * 这条测试反查 tui.tsx 源码，钉死两者一致。
   */
  test("renderPanel 的行序与 tui.tsx 里固定 <text> 的顺序一致", async () => {
    const src = await readFile(new URL("../tui.tsx", import.meta.url), "utf8")
    const inTui = [...src.matchAll(/<text>\{([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!)
    assert.ok(inTui.length > 0, "没能从 tui.tsx 解析出 <text> 行——渲染结构被改过？")
    assert.deepEqual(renderPanel(s, "root").map((l) => l.name), inTui)
  })
})
