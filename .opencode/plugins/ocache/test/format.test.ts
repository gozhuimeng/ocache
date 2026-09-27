import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  fmtCount,
  fmtReq,
  fmtCost,
  fmtPct,
  NO_DATA,
  DIVIDER,
  LABEL_W,
  VALUE_W,
  MONEY_W,
  FULL_ORDER,
  LAYOUT_LINES,
  PANEL_LAYOUTS,
  NEXT_LAYOUT,
  isPanelLayout,
  show,
  lineHeader,
  lineSessionReq,
  lineSessionHit,
  lineSessionInOut,
  lineSessionCache,
  lineSessionReasoning,
  lineSessionCost,
  lineToday,
  lineTodayDetail,
  lineMonth,
  lineMonthDetail,
  lineTotal,
  lineTotalDetail,
  plain,
  lineDivider,
  renderPanel,
  width,
  type Seg,
  type Tone,
  type PanelLayout,
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

/**
 * 无数据占位在面板上的实际样子：标签列**之后**的 "—"。
 * 与 `shared/format.ts` 的 `emptyCell()` 同口径——占位不打破对齐。
 */
const EMPTY_CELL = " ".repeat(LABEL_W) + NO_DATA

describe("fmtCount", () => {
  test("999 以内原样：不加小数、不加单位", () => {
    assert.equal(fmtCount(0), "0")
    assert.equal(fmtCount(999), "999")
    assert.equal(fmtCount(1000), "1.00K")
    assert.equal(fmtCount(-1234), "-1.23K")
    assert.equal(fmtCount(123456), "123.46K")
  })

  test("四档 K/M/B/T，十亿写成 B", () => {
    assert.equal(fmtCount(10000), "10.00K")
    assert.equal(fmtCount(100000), "100.00K")
    assert.equal(fmtCount(1234567), "1.23M")
    assert.equal(fmtCount(2.5e9), "2.50B")
    assert.equal(fmtCount(2.5e12), "2.50T")
    // 旧版四档只到 G，1e12 只能挤成 `1000G`
    assert.ok(!fmtCount(2.5e12).includes("G"), "B 档不该再出现 G")
  })

  test("固定两位，进位跨档不出 1000.00K", () => {
    assert.equal(fmtCount(1234), "1.23K")
    assert.equal(fmtCount(1236), "1.24K")
    assert.equal(fmtCount(999400), "999.40K")
    assert.equal(fmtCount(999999), "1.00M")
    assert.equal(fmtCount(999999999), "1.00B")
    assert.equal(fmtCount(1e12), "1.00T")
    // 先取整再缩写：999.6 若按原值落进 999 以内会显示成 `1000`
    assert.equal(fmtCount(999.6), "1.00K")
  })

  test("最长 999.99K 正好 7 格——VALUE_W 就是按它定的", () => {
    assert.equal(fmtCount(999990), "999.99K")
    assert.equal(width("999.99K"), 7)
    for (const n of [0, 1, 999, 1000, 123456, 999990, 999999, 1234567, 987654321, 2.5e12]) {
      assert.ok(width(fmtCount(n)) <= 7, `${n} → ${fmtCount(n)} 超 7 格`)
    }
    // 档位尽头的 T 升无可升，只能把溢出的那一位留下——现实中到不了的量级
    assert.equal(fmtCount(999999999999999), "1000.00T")
    assert.equal(fmtCount(Number.NaN), NO_DATA)
    assert.equal(fmtCount(Number.POSITIVE_INFINITY), NO_DATA)
  })
})

describe("fmtReq", () => {
  test("与 token 同形：两位小数 + 单位", () => {
    assert.equal(fmtReq(0), "0")
    assert.equal(fmtReq(5), "5")
    assert.equal(fmtReq(999), "999")
    assert.equal(fmtReq(1000), "1.00K")
    assert.equal(fmtReq(1160), "1.16K")
    assert.equal(fmtReq(40000), "40.00K")
    assert.equal(fmtReq(116000), "116.00K")
    assert.equal(fmtReq(-1500), "-1.50K")
  })

  test("档位只有 K/M，同样 7 格封顶", () => {
    assert.equal(fmtReq(999990), "999.99K")
    assert.equal(fmtReq(654321), "654.32K")
    // 999,999 四舍五入跨过千位 → 升 M 档，与 token 同一条进位规则
    assert.equal(fmtReq(999999), "1.00M")
    assert.equal(fmtReq(1000000), "1.00M")
    // 请求理论不会超过 1,000,000；真撞上更大的就停在 M 档不升 B
    assert.equal(fmtReq(1e9), "1000.00M")
    for (const n of [0, 1, 999, 1000, 123456, 999990, 999999, 1000000]) {
      assert.ok(width(fmtReq(n)) <= 7, `${n} → ${fmtReq(n)} 超 7 格`)
    }
    assert.equal(fmtReq(Number.NaN), NO_DATA)
    assert.equal(fmtReq(Number.POSITIVE_INFINITY), NO_DATA)
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
    assert.equal(plain(lineHeader(emptySnapshot("¥"), "x")), "ocache")
    const solo = snap({ updated: 1, record: true, sessions: { x: sess({ session_id: "x" }) } })
    assert.equal(plain(lineHeader(solo, "x")), "ocache  ● 记录中")
    // s 是首帧之前的快照（updated=0），补上更新时间才会有状态尾巴
    assert.equal(
      plain(lineHeader({ ...s, updated: 1 }, "s1")),
      "ocache +1 子会话  ○ 仅内存",
    )
    // 会话还没数据时同样只报聚合范围，具体行各自退 "—"
    assert.equal(
      plain(lineHeader(snap({ updated: 1, record: true }), "未见过")),
      "ocache  ● 记录中",
    )
  })

  test("无数据的会话每行给占位而不是一串 0", () => {
    // 占位落在标签列**之后**（trim 掉前导补空再断言内容）
    for (const line of [
      lineSessionReq(s, "未见过"),
      lineSessionHit(s, "未见过"),
      lineSessionInOut(s, "未见过"),
      lineSessionCache(s, "未见过"),
      lineSessionReasoning(s, "未见过"),
      lineSessionCost(s, "未见过"),
    ]) {
      assert.equal(plain(line).trim(), NO_DATA)
      assert.equal(plain(line).length, LABEL_W + NO_DATA.length)
    }
  })

  test("行文案：请求+成功 / 命中 / 输入+输出 / 缓读+缓写 / 推理 / 费用", () => {
    // 每行第一段数值都补到 VALUE_W（这里用 padEnd 展开，好看出补了几个空格），
    // 后面的空 2 格与第二个标签才能落在固定列上
    assert.equal(
      plain(lineSessionReq(s, "s1")),
      `请求${" ".repeat(1)}${"5".padEnd(VALUE_W)}  成功 80%`,
    )
    // 会话没有 recent：命中行退成只有累计段，不整行占位
    assert.equal(plain(lineSessionHit(s, "s1")), `命中${" ".repeat(1)}96.39%`)
    assert.equal(
      plain(lineSessionInOut(s, "s1")),
      `输入${" ".repeat(1)}${"1.23K".padEnd(VALUE_W)}  输出 1.46K`,
    )
    assert.equal(
      plain(lineSessionCache(s, "s1")),
      `缓读${" ".repeat(1)}${"56.79K".padEnd(VALUE_W)}  缓写 890`,
    )
    assert.equal(plain(lineSessionReasoning(s, "s1")), `推理${" ".repeat(1)}900`)
    // 推理不在费用行里了：金额是这行唯一的内容
    assert.equal(plain(lineSessionCost(s, "s1")), `费用${" ".repeat(1)}¥0.0234`)
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
    // 紧凑档金额补到 MONEY_W：三行金额长短不一，不补的话 `成功` 各起各的列；
    // `成功` 提到百分比前面（与展开档同规则），百分比落到行尾、不再补宽
    assert.equal(
      plain(lineToday(withAgg)),
      `今日${" ".repeat(1)}${"¥0.045".padEnd(MONEY_W)}  成功 100%`,
    )
    assert.equal(
      plain(lineMonth(withAgg)),
      `本月${" ".repeat(1)}${"¥1.23".padEnd(MONEY_W)}  成功 99.1%`,
    )
    assert.equal(
      plain(lineTotal(withAgg)),
      `累计${" ".repeat(1)}${"¥5.67".padEnd(MONEY_W)}  成功 99.7%`,
    )

    const empty = snap({ agg: null })
    assert.equal(plain(lineToday(empty)).trim(), NO_DATA)
    assert.equal(plain(lineMonth(empty)).trim(), NO_DATA)
    assert.equal(plain(lineTotal(empty)).trim(), NO_DATA)
  })
})

describe("本次命中率与环比", () => {
  /** 39/40 = 97.5% */
  const HI = { input: 1, cacheRead: 39, cacheWrite: 0 }
  /** 239/250 = 95.6% */
  const LO = { input: 11, cacheRead: 239, cacheWrite: 0 }
  const at = (ts: number, t: typeof HI) => ({ ts, ...t })
  /**
   * 本组的会话。命中行前半段的**累计**值取自会话桶，所以桶不能空着——
   * 固定成 3/4 = 75%，于是每条断言的前半截恒定，后半截才是被测的"本次 + 环比"。
   */
  const hit = (over: Partial<SessionSnapshot> & { session_id: string }) =>
    sess({ input: 1, cache_read: 3, cache_write: 0, ...over })
  /** 该行拼成的整串：文案与分段分开断言，这里只看"写了什么"。 */
  const row = (s: Snapshot, sid: string) => plain(lineSessionHit(s, sid))
  /** 命中行的固定前缀：累计值补到 VALUE_W，空 2 格 + `本次` 因此落在固定列。 */
  const HEAD = `命中${" ".repeat(1)}${"75%".padEnd(VALUE_W)}  本次 `
  /** 有环比时"本次"值补到 VALUE_W（把 ± 顶到固定列），环比接在它后面。 */
  const CUR = (v: string, d: string) => `${v.padEnd(VALUE_W)} ${d}`

  test("首次请求没有基线：只显示命中率，不带符号", () => {
    const s = snap({ sessions: { s1: hit({ session_id: "s1", recent: [at(200, HI)] }) } })
    assert.equal(row(s, "s1"), HEAD + `97.50%`)
  })

  test("上升带 +、下降带 -，不用箭头", () => {
    const up = snap({
      sessions: { s1: hit({ session_id: "s1", recent: [at(200, HI), at(100, LO)] }) },
    })
    assert.equal(row(up, "s1"), HEAD + CUR("97.50%", "+1.90%"))

    const down = snap({
      sessions: { s1: hit({ session_id: "s1", recent: [at(200, LO), at(100, HI)] }) },
    })
    assert.equal(row(down, "s1"), HEAD + CUR("95.60%", "-1.90%"))

    // 符号之外还得有颜色：光靠 +/- 在弱光下扫不出来
    assert.equal(lineSessionHit(up, "s1").at(-1)?.tone, "up")
    assert.equal(lineSessionHit(down, "s1").at(-1)?.tone, "down")
    // 段序固定：标签 → 数值 → 分隔 → 标签 → 数值 → 环比（环比独占一段才能单独上色）
    assert.deepEqual(
      lineSessionHit(up, "s1").map((g) => g.tone),
      ["label", "value", "label", "value", "up"],
    )
  })

  test("与上次持平不显示 +0%", () => {
    const s = snap({
      sessions: { s1: hit({ session_id: "s1", recent: [at(200, HI), at(100, HI)] }) },
    })
    assert.equal(row(s, "s1"), HEAD + `97.50%`)
    assert.deepEqual(
      lineSessionHit(s, "s1").map((g) => g.tone),
      ["label", "value", "label", "value"],
    )
  })

  test("命中率取两位小数，一位小数会被抹平的差异能显示出来", () => {
    // hitRate = cacheRead / (input + cacheRead + cacheWrite)
    // A = 197/200 = 98.50%   B = 395/400 = 98.75%
    // 一位小数下是 98.5% → 98.8%，看着像普通的 0.3 个百分点；
    // 两位小数才能读出确切的 "+0.25%"
    const A = { input: 3, cacheRead: 197, cacheWrite: 0 }
    const B = { input: 5, cacheRead: 395, cacheWrite: 0 }
    const s = snap({
      sessions: { s1: hit({ session_id: "s1", recent: [at(200, B), at(100, A)] }) },
    })
    assert.equal(row(s, "s1"), HEAD + CUR("98.75%", "+0.25%"))
  })

  test("整百分比不带小数尾巴，避免 97.00% 这种噪音", () => {
    const FULL = { input: 0, cacheRead: 100, cacheWrite: 0 } // 100%
    const s = snap({ sessions: { s1: hit({ session_id: "s1", recent: [at(200, FULL)] }) } })
    assert.equal(row(s, "s1"), HEAD + `100%`)
  })

  test("子树跨会话取全局最近两条，而不是各取各的", () => {
    const s = snap({
      sessions: {
        root: hit({ session_id: "root", recent: [at(300, HI), at(50, HI)] }),
        child: hit({ session_id: "child", parent_id: "root", recent: [at(200, LO)] }),
      },
    })
    // 正确取法：300 的 HI 与 200 的 LO → +1.90%
    // 若退化成"只看 root 自己两条"，会得到两条 HI → 无符号
    assert.equal(row(s, "root"), HEAD + CUR("97.50%", "+1.90%"))
    // 子会话自己的子树只有一条，没有基线 → 不带符号
    assert.equal(row(s, "child"), HEAD + `95.60%`)
  })

  test("未见过的会话整行占位，见过但没 recent 的只退掉后半段", () => {
    assert.equal(plain(lineSessionHit(snap({ sessions: {} }), "没有")).trim(), NO_DATA)
    // 累计命中率就在桶里，白给的信息没道理扣着不显示——只把"本次"摘掉
    const none = snap({ sessions: { s1: hit({ session_id: "s1" }) } })
    assert.equal(plain(lineSessionHit(none, "s1")), `命中${" ".repeat(1)}75%`)
  })

  test("子树最近两条按 ts 倒序，超出两条的直接丢弃", () => {
    const s = snap({
      sessions: {
        root: hit({ session_id: "root", recent: [at(10, HI), at(90, LO)] }),
        child: hit({ session_id: "child", parent_id: "root", recent: [at(50, HI), at(70, LO), at(30, HI)] }),
      },
    })
    const got = subtreeRecentOf(s.sessions, "root")
    assert.deepEqual(
      got.map((e) => e.ts),
      [90, 70],
    )
  })

  /**
   * 命中行是面板上最长的一行（文件头的 35 格硬约束就卡在它身上）。
   * 最坏组合：累计、本次、环比三段全是两位小数且都顶到 99.99%。
   * 算得 `5 + 7 + 7 + 7 + 8 = 34`——离 35 的硬上限还剩 1 格。
   * （数值列从 6 涨到 7、分隔从 ` · ` 3 格收成 2 格，净值 +1。）
   */
  test("最坏情况（99.99% / 99.99% / +99.99%）正好 34 格", () => {
    const fat = snap({
      sessions: {
        s1: hit({
          session_id: "s1",
          input: 1,
          cache_read: 9999,
          recent: [
            { ts: 200, input: 1, cacheRead: 9999, cacheWrite: 0 },
            { ts: 100, input: 10000, cacheRead: 0, cacheWrite: 0 },
          ],
        }),
      },
    })
    const text = plain(lineSessionHit(fat, "s1"))
    assert.equal(
      text,
      `命中${" ".repeat(1)}${"99.99%".padEnd(VALUE_W)}  本次 ${"99.99%".padEnd(VALUE_W)} +99.99%`,
    )
    assert.equal(width(text), 34)
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

  test("三档布局行数：展开 16 / 紧凑 13 / 折叠 2", () => {
    // 展开 = 16（14 行内容 + 上下两条边框线）；紧凑 = 16 − 3 条历史明细；
    // 折叠只留 2 行内容、不画边框（见 lineRuleTop 的说明）
    assert.equal(renderPanel(s, "root", "full").length, 16)
    assert.equal(renderPanel(s, "root", "compact").length, 13)
    assert.equal(renderPanel(s, "root", "collapsed").length, 2)
    // 没有任何数据也必须是同样的行数——占位行不能把面板撑塌或撑高
    assert.equal(renderPanel(snap({}), "x", "full").length, 16)
    assert.equal(renderPanel(snap({}), "x", "compact").length, 13)
    assert.equal(renderPanel(snap({}), "x", "collapsed").length, 2)
  })

  test("上沿与下沿成对画线，折叠档一律不画", () => {
    for (const layout of ["full", "compact"] as const) {
      const lines = renderPanel(s, "root", layout)
      assert.equal(lines[0]!.name, "lineRuleTop", `${layout} 档缺上沿线`)
      assert.equal(lines.at(-1)!.name, "lineRuleBottom", `${layout} 档缺下沿线`)
      assert.equal(lines[0]!.text, DIVIDER)
      assert.equal(lines.at(-1)!.text, DIVIDER)
    }
    const collapsed = renderPanel(s, "root", "collapsed").map((l) => l.name)
    assert.equal(collapsed.includes("lineRuleTop"), false, "折叠档不该画上沿")
    assert.equal(collapsed.includes("lineRuleBottom"), false, "折叠档不该画下沿")
    assert.equal(collapsed.includes("lineDivider"), false, "折叠档也没有中缝")
  })

  test("折叠档只剩标题与费用，且顺序是标题 → 费用", () => {
    const got = renderPanel(s, "root", "collapsed").map((l) => l.name)
    assert.deepEqual(got, ["lineHeader", "lineSessionCost"])
    assert.deepEqual(
      renderPanel(s, "root", "collapsed").map((l) => l.text),
      ["ocache +1 子会话  ● 记录中", `费用${" ".repeat(1)}¥1.30`],
    )
  })

  test("紧凑档十三行逐行断言：会话块一行不删，只砍历史明细", () => {
    assert.deepEqual(
      renderPanel(s, "root", "compact").map((l) => l.text),
      [
        DIVIDER,
        "ocache +1 子会话  ● 记录中",
        `请求${" ".repeat(1)}${"105".padEnd(VALUE_W)}  成功 99%`,
        `命中${" ".repeat(1)}${"98.93%".padEnd(VALUE_W)}  本次 ${"97.50%".padEnd(VALUE_W)} +1.90%`,
        `输入${" ".repeat(1)}${"1.60K".padEnd(VALUE_W)}  输出 5.30K`,
        `缓读${" ".repeat(1)}${"148.40K".padEnd(VALUE_W)}  缓写 0`,
        `推理${" ".repeat(1)}3.20K`,
        `费用${" ".repeat(1)}¥1.30`,
        DIVIDER,
        // 紧凑档的钱后面跟着成功率，三行金额补到 MONEY_W 才不各起各的列
        `今日${" ".repeat(1)}${"¥0.045".padEnd(MONEY_W)}  成功 100%`,
        `本月${" ".repeat(1)}${"¥1.23".padEnd(MONEY_W)}  成功 99.1%`,
        `累计${" ".repeat(1)}${"¥1,234.50".padEnd(MONEY_W)}  成功 99.6%`,
        DIVIDER,
      ],
    )
  })

  test("展开档十六行逐行断言：上下边框 + 请求+成功 + 三条历史明细", () => {
    assert.deepEqual(
      renderPanel(s, "root", "full").map((l) => l.text),
      [
        DIVIDER,
        "ocache +1 子会话  ● 记录中",
        // 104/105 = 99.05% → 一位小数 99.0 → 整百分比去尾巴 = 99%
        `请求${" ".repeat(1)}${"105".padEnd(VALUE_W)}  成功 99%`,
        `命中${" ".repeat(1)}${"98.93%".padEnd(VALUE_W)}  本次 ${"97.50%".padEnd(VALUE_W)} +1.90%`,
        `输入${" ".repeat(1)}${"1.60K".padEnd(VALUE_W)}  输出 5.30K`,
        `缓读${" ".repeat(1)}${"148.40K".padEnd(VALUE_W)}  缓写 0`,
        `推理${" ".repeat(1)}3.20K`,
        `费用${" ".repeat(1)}¥1.30`,
        DIVIDER,
        // 展开档的历史行：第一行只留金额（四笔金额因此竖在同一列），
        // 第二行标签在前、请求数与成功率接在后面，`请求` 与 `今日` 同起点
        `今日${" ".repeat(1)}¥0.045`,
        `请求${" ".repeat(1)}${"12".padEnd(VALUE_W)}  成功 100%`,
        `本月${" ".repeat(1)}¥1.23`,
        `请求${" ".repeat(1)}${"340".padEnd(VALUE_W)}  成功 99.1%`,
        `累计${" ".repeat(1)}¥1,234.50`,
        `请求${" ".repeat(1)}${"12.35K".padEnd(VALUE_W)}  成功 99.6%`,
        DIVIDER,
      ],
    )
  })

  test("记录状态三态：首帧不显示 / 仅内存 / 记录中", () => {
    // updated=0（首帧快照还没到）→ 不带状态尾巴，避免闪一句"仅内存"误导
    // 行 0 是上沿分隔线，标题在行 1
    const header = (x: ReturnType<typeof renderPanel>) => x[1]!.text
    assert.equal(header(renderPanel(snap({ sessions }), "root")), "ocache +1 子会话")
    const off = snap({ updated: 1, record: false, sessions, agg })
    assert.equal(header(renderPanel(off, "root")), "ocache +1 子会话  ○ 仅内存")
    assert.equal(header(renderPanel(s, "root")), "ocache +1 子会话  ● 记录中")
  })

  test("会话毫无数据：标题行照常，会话块整片占位，历史三口径不受影响", () => {
    const empty = snap({ updated: 1, record: true, agg })
    // 紧凑档与展开档的会话块行数相同（紧凑只砍历史明细），占位因此一样长
    assert.deepEqual(
      renderPanel(empty, "没见过的会话", "compact").map((l) => l.text),
      [
        DIVIDER,
        "ocache  ● 记录中",
        EMPTY_CELL,
        EMPTY_CELL,
        EMPTY_CELL,
        EMPTY_CELL,
        EMPTY_CELL,
        EMPTY_CELL,
        DIVIDER,
        `今日${" ".repeat(1)}${"¥0.045".padEnd(MONEY_W)}  成功 100%`,
        `本月${" ".repeat(1)}${"¥1.23".padEnd(MONEY_W)}  成功 99.1%`,
        `累计${" ".repeat(1)}${"¥1,234.50".padEnd(MONEY_W)}  成功 99.6%`,
        DIVIDER,
      ],
    )
    // 展开档多出来的是三条历史明细，会话块照旧整片占位
    assert.deepEqual(
      renderPanel(empty, "没见过的会话", "full").map((l) => l.text),
      [
        DIVIDER,
        "ocache  ● 记录中",
        EMPTY_CELL,
        EMPTY_CELL,
        EMPTY_CELL,
        EMPTY_CELL,
        EMPTY_CELL,
        EMPTY_CELL,
        DIVIDER,
        `今日${" ".repeat(1)}¥0.045`,
        `请求${" ".repeat(1)}${"12".padEnd(VALUE_W)}  成功 100%`,
        `本月${" ".repeat(1)}¥1.23`,
        `请求${" ".repeat(1)}${"340".padEnd(VALUE_W)}  成功 99.1%`,
        `累计${" ".repeat(1)}¥1,234.50`,
        `请求${" ".repeat(1)}${"12.35K".padEnd(VALUE_W)}  成功 99.6%`,
        DIVIDER,
      ],
    )
  })

  test("历史口径整体缺失时行数不变，明细行跟着变占位而不是塌掉", () => {
    const noAgg = snap({ updated: 1, record: true, sessions })
    const full = renderPanel(noAgg, "root", "full").map((l) => l.text)
    assert.equal(full.length, 16)
    // 行 0 上沿 / 行 1 标题 / 行 8 中缝 / 行 15 下沿
    assert.equal(full[0], DIVIDER)
    assert.equal(full[8], DIVIDER)
    assert.equal(full[15], DIVIDER)
    for (const i of [9, 10, 11, 12, 13, 14]) assert.equal(full[i], EMPTY_CELL)
    const compact = renderPanel(noAgg, "root", "compact").map((l) => l.text)
    assert.equal(compact.length, 13)
    // 紧凑档：行 0 上沿 / 行 1 标题 / 行 2-7 会话块 / 行 8 中缝 / 行 12 下沿
    assert.equal(compact[0], DIVIDER)
    assert.equal(compact[8], DIVIDER)
    for (const i of [9, 10, 11]) assert.equal(compact[i], EMPTY_CELL)
    // 折叠档只看标题与费用，历史缺不缺都与它无关
    assert.equal(renderPanel(noAgg, "root", "collapsed").length, 2)
  })

  /**
   * tui.tsx 用**写死的 `<text>`** 而不是 `.map(renderPanel)`——
   * `.map` 每秒重建整棵子树、终端里会闪（REQUIREMENTS §4 实现约束）。
   * 代价是渲染顺序与 `renderPanel` 分居两处，会被人改乱。
   * 这条测试反查 tui.tsx 源码，钉死两者一致。
   *
   * M6 之后每行是 `<text fg={...}>{paint(lineXxx(...))}</text>`：
   * 正则要跳过 `fg=` 属性、再从 `paint(` 里取出**行函数名**。
   *
   * 多档布局之后还要多验两件事：
   * 1. tui.tsx 的行序 == `FULL_ORDER`，且每一档渲染出的行名序列
   *    == 从 `FULL_ORDER` 里按该档过滤的结果（顺序定义只允许有一处）；
   * 2. 每个 `<text>` 外面都套着 `show(layout(), 同名)` 守卫——
   *    空 `<text>` 实测会占一整行，少一个守卫，折叠档就会变成
   *    "两行内容 + 十二行空白"。
   */
  test("renderPanel 的行序与 tui.tsx 里固定 <text> 的顺序一致", async () => {
    const src = await readFile(new URL("../tui.tsx", import.meta.url), "utf8")
    const inTui = [...src.matchAll(/<text[^>]*>\{paint\(([A-Za-z_$][\w$]*)\(/g)].map(
      (m) => m[1]!,
    )
    assert.ok(inTui.length > 0, "没能从 tui.tsx 解析出 <text> 行——渲染结构被改过？")
    assert.deepEqual(inTui, [...FULL_ORDER])

    for (const layout of PANEL_LAYOUTS) {
      const want: string[] = inTui.filter((name) => show(layout, name))
      assert.deepEqual(
        renderPanel(s, "root", layout).map((l) => l.name),
        want,
        `${layout} 档的行序与 tui.tsx 不一致`,
      )
    }

    // 每个 <text> 前面紧挨着的 show() 必须守卫同名的行
    const guarded = [...src.matchAll(
      /show\(layout\(\), "([A-Za-z_$][\w$]*)"[\s\S]*?<text[^>]*>\{paint\(([A-Za-z_$][\w$]*)\(/g,
    )].map((m) => [m[1]!, m[2]!] as const)
    assert.equal(guarded.length, inTui.length, "有 <text> 没被 show() 守卫包住")
    for (const [guard, paint] of guarded) {
      assert.equal(guard, paint, `守卫的行名 ${guard} 与 paint 的行名 ${paint} 对不上`)
    }
  })
})

/**
 * M6 外观：标签列对齐 + 视觉层次。
 *
 * 这两条是"按审美做一版"里**可被验证**的那部分——
 * 配色本身归 tui.tsx（要主题对象，测不了），但"哪段字该弱化、
 * 哪段该放亮、数值从第几列起跳"是纯逻辑，必须钉死。
 */
describe("M6 版式：标签列对齐与视觉层次", () => {
  const bucket = {
    input: 1,
    cacheRead: 2,
    cacheWrite: 3,
    output: 4,
    reasoning: 5,
    steps: 1234,
    ok: 1230,
    error: 4,
    cost: 5.67,
  }
  const sessions = {
    // 带一条 recent，否则"本次"行会退成占位、测不到对齐
    s1: sess({
      session_id: "s1",
      steps: 4,
      ok: 3,
      cost: 0.0234,
      recent: [{ ts: 1, input: 1, cacheRead: 39, cacheWrite: 0 }],
    }),
  }
  const s = snap({
    updated: 1,
    record: true,
    sessions,
    // 三个口径给不同金额，才能验出"同形不等于同值"
    agg: {
      totals: { ...bucket, cost: 5.67 },
      today: { ...bucket, cost: 0.045 },
      month: { ...bucket, cost: 1.23 },
    },
  })

  /** 第一个"非标签"片段从第几格开始（标签列宽就该等于它）。 */
  function firstValueCol(segs: readonly Seg[]): number {
    let col = 0
    for (const g of segs) {
      if (g.tone !== "label") return col
      col += width(g.text)
    }
    return -1
  }

  /** 指定角色第一次出现在第几格。 */
  function colOf(segs: readonly Seg[], tone: Tone): number {
    let col = 0
    for (const g of segs) {
      if (g.tone === tone) return col
      col += width(g.text)
    }
    return -1
  }

  /**
   * 某段文字的起始**显示格**（0 起），找不到返回 -1。
   * 用 `text.indexOf` 直接拿下标当列会把中文数成 1 格，整列全排歪——
   * 列断言必须先按格切片再量宽。
   */
  function atCol(text: string, needle: string): number {
    if (needle === "") return -1
    const i = text.indexOf(needle)
    return i < 0 ? -1 : width(text.slice(0, i))
  }

  test("显示宽度按格算：CJK 计 2 格、ASCII 计 1 格", () => {
    assert.equal(width(""), 0)
    assert.equal(width("abc"), 3)
    assert.equal(width("请求"), 4)
    assert.equal(width("未命中"), 6)
    assert.equal(width("¥1.23"), 5)
    assert.equal(width("未命中 1.2K"), 11)
    // 用 .length 排版会把中文数成一个字符、整列排歪
    assert.notEqual(width("未命中"), "未命中".length)
  })

  test("所有行的第一个数值都从 LABEL_W 起跳", () => {
    const lines = [
      lineSessionReq(s, "s1"),
      lineSessionHit(s, "s1"),
      lineSessionInOut(s, "s1"),
      lineSessionCache(s, "s1"),
      lineSessionReasoning(s, "s1"),
      lineSessionCost(s, "s1"),
      lineToday(s),
      lineMonth(s),
      lineTotal(s),
    ]
    for (const segs of lines) {
      assert.equal(firstValueCol(segs), LABEL_W, plain(segs))
    }
  })

  /**
   * 2026-09-27 改版的核心：一行两段的行不能靠手插空格排。
   * 第一个数值补到 `VALUE_W`，空 2 格与第二个标签因此钉死在固定的格上——
   * 数值从 `4` 到 `987.65B` 长短不一，这两个位置一格都不许动。
   * 2026-09-28 起 `·` 被拿掉，"分隔落在哪一格"就改由第二个标签间接钉住。
   */
  test("会话块四行两段：第二个标签、第二个数值两处全在同列", () => {
    // 数值故意拉得长短不一：请求 4、命中 100%、输入 1.23K、缓读 987.65B
    const varied = snap({
      updated: 1,
      record: true,
      sessions: {
        a: sess({
          session_id: "a",
          steps: 4,
          ok: 4,
          input: 1234,
          cache_read: 987654321,
          cache_write: 890,
          output: 5678,
          reasoning: 999,
          cost: 0.5,
          recent: [{ ts: 1, input: 1, cacheRead: 39, cacheWrite: 0 }],
        }),
      },
    })
    const rows: Array<[Seg[], string]> = [
      [lineSessionReq(varied, "a"), "成功"],
      [lineSessionHit(varied, "a"), "本次"],
      [lineSessionInOut(varied, "a"), "输出"],
      [lineSessionCache(varied, "a"), "缓写"],
    ]
    for (const [segs, second] of rows) {
      const text = plain(segs)
      assert.equal(text.includes("·"), false, `面板已无分隔点：${text}`)
      // 第二个标签 = 标签列(5) + 数值列(7) + 空 2 格 之后那一格（0 起第 14 格）
      assert.equal(atCol(text, second), LABEL_W + VALUE_W + 2, text)
    }
    // 第三个位置——第二个数值。四行的第二标签一律 2 字（4 格），四个数值因此
    // 必须落在同一格。这正是缓存那行从 `缓存读`/`缓存写` 改成 `缓读`/`缓写`
    // 的全部动机：三字标签占 6 格，会把该行数值顶到 0 起第 21 格、比别的行右移
    // 2 格，而把别处垫到 6 格会让最长的命中行涨到 36 格、超 35 的硬上限。
    // 谁把任一标签改长，这条断言会立刻歪掉，逼着重算宽度预算。
    for (const [segs, second] of rows) {
      const text = plain(segs)
      const value = text.slice(text.indexOf(second) + second.length + 1)
      assert.equal(atCol(text, value), LABEL_W + VALUE_W + 7, text)
    }
  })

  test("紧凑档三行历史：金额补到位，`成功` 竖在一列", () => {
    for (const segs of [lineToday(s), lineMonth(s), lineTotal(s)]) {
      const text = plain(segs)
      assert.equal(text.includes("·"), false, `面板已无分隔点：${text}`)
      // 金额列比数值列宽 4 格，这里的 `成功` 因此比会话块的右移 4 格
      assert.equal(atCol(text, "成功"), LABEL_W + MONEY_W + 2, text)
    }
  })

  test("三条历史明细：标签与数值各归其位，`成功` 与会话块同列", () => {
    // 明细行 = head("请求")(LABEL_W) + 请求数(VALUE_W) + 空 2 格 + "成功 " + 成功率
    for (const segs of [lineTodayDetail(s), lineMonthDetail(s), lineTotalDetail(s)]) {
      const text = plain(segs)
      // `请求` 占满标签列，数值从 LABEL_W 起跳——与上一行的金额同一起点
      assert.equal(firstValueCol(segs), LABEL_W, text)
      // 请求数与 token 同宽（7 格封顶），`成功` 于是落在会话块同一格上
      assert.equal(width(segs[1]!.text), VALUE_W, text)
      assert.equal(atCol(text, "成功"), LABEL_W + VALUE_W + 2, text)
      // `成功` 标签与百分比前后相接，中间只隔一格空隙
      assert.equal(segs[2]!.text, "  成功 ", text)
      assert.match(segs[3]!.text, /^[\d.]+%$/, text)
    }
    // 上下统一：会话块第 1 行与历史明细行的 `成功` 必须同列
    assert.equal(
      atCol(plain(lineTodayDetail(s)), "成功"),
      atCol(plain(lineSessionReq(s, "s1")), "成功"),
    )
  })

  test("四笔金额（费用/今日/本月/累计）竖在同一列", () => {
    assert.equal(colOf(lineSessionCost(s, "s1"), "money"), LABEL_W)
    assert.equal(colOf(lineToday(s), "money"), LABEL_W)
    assert.equal(colOf(lineMonth(s), "money"), LABEL_W)
    assert.equal(colOf(lineTotal(s), "money"), LABEL_W)
  })

  test("标签弱化、数值放亮、金额单独强调", () => {
    // 请求行：标签/数值交替，分隔符跟着标签一起弱化
    assert.deepEqual(
      lineSessionReq(s, "s1").map((g) => g.tone),
      ["label", "value", "label", "value"],
    )
    // 命中行同形（这里没有基线，环比那一段缺席）
    assert.deepEqual(
      lineSessionHit(s, "s1").map((g) => g.tone),
      ["label", "value", "label", "value"],
    )
    // 推理行：标签 + 一个数值，再没别的
    assert.deepEqual(
      lineSessionReasoning(s, "s1").map((g) => g.tone),
      ["label", "value"],
    )
    // 费用行：只剩金额——推理拆出去独立成行，行尾没有尾巴了
    assert.deepEqual(
      lineSessionCost(s, "s1").map((g) => g.tone),
      ["label", "money"],
    )
    // 历史三行同形
    assert.deepEqual(lineTotal(s).map((g) => g.tone), lineToday(s).map((g) => g.tone))
    assert.deepEqual(
      lineTotal(s).map((g) => g.tone),
      ["label", "money", "label", "value"],
    )
    // 金额段的文字就是原样数字，不掺标签
    assert.equal(lineSessionCost(s, "s1")[1]?.text, "¥0.0234")
  })

  test("历史三行同形：只有标签文字不同，段数与角色逐位一致", () => {
    const [d, m, t] = [lineToday(s), lineMonth(s), lineTotal(s)]
    assert.equal(d[0]?.text.trim(), "今日")
    assert.equal(m[0]?.text.trim(), "本月")
    assert.equal(t[0]?.text.trim(), "累计")
    // 三行段数相同、每段角色相同（标签→金额→分隔→成功率→后缀）
    for (const other of [m, t]) {
      assert.deepEqual(other.map((g) => g.tone), d.map((g) => g.tone))
    }
    // 金额位各自是各自的数，但落点相同（同形不等于同值）
    assert.notEqual(d[1]?.text, t[1]?.text)
  })

  /**
   * 侧栏可用宽不归我们定：170 格的终端实测只有 35 格（面板起点在第 130 列）。
   * 任何一行超宽都会折行、把面板撑高——所以"能塞进 35 格"是版式的硬约束，
   * 比好不好看优先。**三档都要验**：展开档的历史明细行、紧凑档带成功率的
   * 历史行，各自走的是不同的排版路径，一档过了不代表另一档也过。
   */
  test("用满的数也不超侧栏可用宽 35 格（三档都验）", () => {
    const fat = snap({
      updated: 1,
      record: true,
      sessions: {
        s1: sess({
          session_id: "s1",
          steps: 12345,
          ok: 12300,
          error: 45,
          cost: 12345.67,
          input: 1234567,
          cache_read: 987654321,
          cache_write: 54321,
          output: 987654,
          reasoning: 555555,
          recent: [{ ts: 1, input: 1, cacheRead: 39, cacheWrite: 0 }],
        }),
      },
      agg: {
        totals: { ...bucket, cost: 123456.78, steps: 987654 },
        today: { ...bucket, cost: 1234.56, steps: 34567 },
        month: { ...bucket, cost: 12345.67, steps: 654321 },
      },
    })
    let seen = 0
    for (const layout of PANEL_LAYOUTS) {
      for (const line of renderPanel(fat, "s1", layout)) {
        seen++
        const w = width(line.text)
        assert.ok(
          w <= 35,
          `${layout} 档 ${line.name} 占 ${w} 格 > 35：${JSON.stringify(line.text)}`,
        )
      }
    }
    assert.equal(seen, 16 + 13 + 2, "三档行数之和变了")
  })

  /**
   * 三档布局的机器：谁显示谁、循环顺序、配置值校验。
   * 这三件事全在 `show` / `NEXT_LAYOUT` / `isPanelLayout` 里，
   * 单测钉住它们，tui.tsx 那边就只要照着调用。
   */
  test("布局机器：子集有序、循环三步回原点、非法配置判否", () => {
    for (const layout of PANEL_LAYOUTS) {
      const lines = LAYOUT_LINES[layout]
      // 每一档都必须是 FULL_ORDER 按序过滤的结果，不允许另排一套顺序
      assert.deepEqual(
        [...lines],
        [...FULL_ORDER].filter((n) => lines.includes(n)),
        `${layout} 档不是 FULL_ORDER 的有序子集`,
      )
      assert.equal(show(layout, "lineHeader"), true, "标题在任何档都要显示")
    }
    // 展开档比紧凑档多出来的只有三条历史明细；会话块六行两档都在
    assert.equal(show("full", "lineTodayDetail"), true)
    assert.equal(show("compact", "lineTodayDetail"), false)
    assert.equal(show("full", "lineTotalDetail"), true)
    assert.equal(show("compact", "lineTotalDetail"), false)
    for (const name of [
      "lineSessionReq",
      "lineSessionHit",
      "lineSessionInOut",
      "lineSessionCache",
      "lineSessionReasoning",
      "lineSessionCost",
    ]) {
      assert.equal(show("full", name), true, `${name} 紧凑档必须显示`)
      assert.equal(show("compact", name), true, `${name} 紧凑档必须显示`)
      assert.equal(show("collapsed", name), name === "lineSessionCost", `${name} 折叠档`)
    }
    assert.equal(show("collapsed", "lineDivider"), false)
    assert.equal(show("collapsed", "lineTotal"), false)

    let l: PanelLayout = "full"
    for (const want of ["compact", "collapsed", "full"]) {
      l = NEXT_LAYOUT[l]
      assert.equal(l, want)
    }

    assert.equal(isPanelLayout("full"), true)
    assert.equal(isPanelLayout("collapsed"), true)
    assert.equal(isPanelLayout("Full"), false, "大小写要拒，别静默给了个错档")
    assert.equal(isPanelLayout(""), false)
    assert.equal(isPanelLayout(3), false)
    assert.equal(isPanelLayout(undefined), false)
    assert.equal(isPanelLayout(null), false)
  })

  test("历史明细行：标签在前，只装请求数与成功率，不碰金额", () => {
    // `请求` 打头（补满 LABEL_W，与上一行的 `今日` 同起点），后接 请求数 + 成功 P%——
    // 两组「标签+数值」交替，金额一个都不在这行
    for (const detail of [lineTodayDetail(s), lineMonthDetail(s), lineTotalDetail(s)]) {
      assert.deepEqual(
        detail.map((g) => g.tone),
        ["label", "value", "label", "value"],
      )
      assert.equal(detail[0]!.text.trim(), "请求")
      assert.equal(width(detail[0]!.text), LABEL_W)
      // 请求数与 token 同形同宽：两位小数 + K/M、7 格封顶，
      // 于是会话块与历史明细共用 VALUE_W，`成功` 落在同一格
      assert.equal(width(detail[1]!.text), VALUE_W)
      // 行尾的百分比不补宽（后面没人跟着了），所以 100% 与 99.1% 不等长
      assert.match(plain(detail), /^请求 [\d.]+[KMBT]? +成功 [\d.]+%$/)
      assert.equal(plain(detail).includes("·"), false, "面板已无分隔点")
      assert.ok(!plain(detail).includes("¥"), "金额留在第一行，明细行不重复")
    }
  })

  test("记录状态三态：首帧没有状态点，记录中/仅内存分别是 on/off", () => {
    const rec = lineHeader(s, "s1")
    assert.equal(rec[0]?.tone, "title")
    assert.equal(rec.at(-2)?.tone, "on")

    const mem = lineHeader({ ...s, record: false }, "s1")
    assert.equal(mem.at(-2)?.tone, "off")

    const first = lineHeader({ ...s, updated: 0 }, "s1")
    assert.equal(
      first.some((g) => g.tone === "on" || g.tone === "off"),
      false,
      "首帧快照没到时不该闪一句状态",
    )
  })

  test("分隔线是独立的 rule 角色，和正文分得开", () => {
    assert.deepEqual(lineDivider(), [{ text: DIVIDER, tone: "rule" }])
  })

  test("占位落在标签列之后，不打破对齐", () => {
    const none = snap({ updated: 1, record: true })
    for (const segs of [lineToday(none), lineSessionHit(none, "没见过")]) {
      assert.equal(segs.length, 1)
      assert.equal(width(segs[0]!.text), LABEL_W + width(NO_DATA))
      assert.equal(segs[0]!.text.trim(), NO_DATA)
      assert.equal(segs[0]!.tone, "label")
    }
  })
})
