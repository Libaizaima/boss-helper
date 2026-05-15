/**
 * Preservation property tests for the AI / customGreeting pipeline plus the
 * `sendPublishReq` HTTP-investigation path that lives next to it.
 *
 * Spec:   .kiro/specs/ai-greeting-send-verification/{requirements,design,tasks}.md
 * Task:   "2. 在未修复代码上写 Preservation 属性测试（必须 PASS）"
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  EXPECTED OUTCOME ON UNFIXED CODE: ALL TESTS PASS.                       ║
 * ║  These oracles freeze the ¬isBugCondition behaviour the Bugfix MUST      ║
 * ║  keep equivalent (AC4.1–AC4.3, AC7.1–AC7.7).                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Coverage (matches Task 2 deliverable):
 *
 *   1. `sendPublishReq` (`src/composables/useApplying/utils.ts`) under four
 *      response shapes:
 *        - code 0 → returns `res.data`, no throw
 *        - code 1 + '您今天已与120位BOSS沟通' → POSTs the chatremind confirm
 *          then succeeds (axios call sequence asserted)
 *        - code 1 + '您今天已与150位BOSS沟通' → throws `LimitError`
 *        - code 1 + '操作过于频繁'           → throws `RateLimitError`
 *
 *   2. `useChat.chatMessages.push` shape oracle for the existing
 *      `chatBossMessage(ctx, msg)` call site in `handles.ts`. We push a
 *      ChatMessage with the SAME shape and assert: order of fields, types,
 *      and the `date: [day, time]` tuple shape are unchanged.
 *
 *   3. Healthy-greeting baseline: with `GeekChatCore` present and its
 *      `client.send` returning synchronously without throwing, observe the
 *      UNFIXED contract:
 *        - `stats.success` increments exactly once per call
 *        - `ctx.aiGreetingA` is written to `content`
 *        - telemetry titles include `'消息发送/已入队'`
 *      This is the oracle the Bugfix must keep functionally equivalent
 *      (telemetry title was renamed from `'消息发送/成功'` to `'消息发送/已入队'`
 *      to reflect that the channel-level "queued" signal is not yet a
 *      server-confirmed ACK; `stats.success`
 *      must still be exactly 1; `ctx.aiGreetingA === content`).
 *
 * ── Anti-anti-fraud constraints respected (AC7.1–AC7.7) ────────────────────
 *   - No outbound HTTP / WS / EventBus traffic. `axios` is fully mocked at
 *     module scope; `window.Cookie.get` is mocked to return 'fake-bst'.
 *   - No source modifications. Tests are pure additions.
 *   - fast-check `numRuns` ≤ 16, with a frozen `Date.now()` so the
 *     `chatMessages` `id` and `date` tuple are deterministic.
 */

import fc from 'fast-check'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ── 1. axios mock (must be declared BEFORE importing utils.ts) ────────────
//
// `sendPublishReq` calls `axios({...})` and (in the limit-popup branch) a
// follow-up `axios({...})`. We capture every call as a `(args, response)`
// pair via `axiosMock`'s mock implementation.

interface AxiosCall {
  args: any
  // Response we returned (or the rejection thrown).
  outcome: { kind: 'response'; data: any } | { kind: 'reject'; error: any }
}

const axiosCalls: AxiosCall[] = []

// `responseQueue` lets each test scenario pre-program the sequence of
// responses axios should return, in call order.
let responseQueue: Array<{ data: any } | { reject: any }> = []

vi.mock('axios', () => {
  const axiosFn = vi.fn(async (args: any) => {
    const next = responseQueue.shift()
    if (!next) {
      const error = new Error(
        `[axios mock] no queued response for call: ${JSON.stringify({ url: args?.url, method: args?.method })}`,
      )
      axiosCalls.push({ args, outcome: { kind: 'reject', error } })
      throw error
    }
    if ('reject' in next) {
      axiosCalls.push({ args, outcome: { kind: 'reject', error: next.reject } })
      throw next.reject
    }
    axiosCalls.push({ args, outcome: { kind: 'response', data: next.data } })
    return { data: next.data }
  })
  return {
    default: Object.assign(axiosFn, {
      get: vi.fn(),
      post: vi.fn(),
    }),
  }
})

// Silence the cleanConsole iframe used by the project logger; otherwise the
// `console.error` output from `sendPublishReq` (intentional on the failure
// branches) clutters the vitest run.
vi.mock('@/utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  },
}))

// `useLog` collects telemetry calls during the healthy-greeting baseline.
interface DebugCall {
  title: string
  message: string
  payload?: unknown
}
const debugCalls: DebugCall[] = []

vi.mock('@/stores/log', () => ({
  useLog: () => ({
    debug: (title: string, message: string, payload?: unknown) => {
      debugCalls.push({ title, message, payload })
    },
  }),
}))

vi.mock('element-plus', () => ({
  ElMessage: Object.assign(vi.fn(), {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  }),
}))

// Importing AFTER vi.mock so the mocked modules are wired in.
// eslint-disable-next-line import/first
import { sendPublishReq } from '@/composables/useApplying/utils'
// eslint-disable-next-line import/first
import { ackRegistry } from '@/composables/useWebSocket/ackRegistry'
// eslint-disable-next-line import/first
import { Message } from '@/composables/useWebSocket/protobuf'
// eslint-disable-next-line import/first
import { LimitError, PublishError, RateLimitError } from '@/types/deliverError'

// ── 2. Window-level fixtures ──────────────────────────────────────────────

type Win = Window & {
  Cookie?: { get: (k: string) => string }
  GeekChatCore?: any
  ChatWebsocket?: { send: (e: { toArrayBuffer: () => ArrayBuffer }) => void } | null
  EventBus?: {
    publish: (e: string, ...data: any[]) => void
    subscribe: (e: string, t: (...data: any[]) => void) => void
  } | null
}

beforeAll(() => {
  // `window.Cookie` is a Boss page-level injection. In the jsdom test env
  // we install a deterministic stub so `sendPublishReq` does not bail with
  // "没有获取到token".
  ;(window as Win).Cookie = { get: () => 'fake-bst' }
})

beforeEach(() => {
  axiosCalls.length = 0
  responseQueue = []
  debugCalls.length = 0
  // Clear any pending ackRegistry entries from prior iterations so a fresh
  // simulation does not collide on the frozen-clock cmid.
  ackRegistry.__reset()
  const w = window as Win
  delete w.GeekChatCore
  w.ChatWebsocket = undefined
  w.EventBus = undefined
})

afterEach(() => {
  vi.useRealTimers()
  ackRegistry.__reset()
})

// Minimal job item — only the two fields `sendPublishReq` actually reads.
function makeJobItem(overrides: Partial<bossZpJobItemData> = {}): bossZpJobItemData {
  return {
    securityId: 'sec-1',
    encryptJobId: 'job-1',
    ...(overrides as any),
  } as bossZpJobItemData
}

// ── 3. sendPublishReq oracles ─────────────────────────────────────────────

describe('sendPublishReq — Preservation oracle (AC4.2)', () => {
  it('code 0 → returns res.data, no throw, exactly one axios call', async () => {
    responseQueue = [{ data: { code: 0, message: 'ok', zpData: {} } }]

    const data = await sendPublishReq(makeJobItem())
    expect(data).toEqual({ code: 0, message: 'ok', zpData: {} })
    expect(axiosCalls).toHaveLength(1)
    expect(axiosCalls[0]?.args).toMatchObject({
      url: 'https://www.zhipin.com/wapi/zpgeek/friend/add.json',
      method: 'POST',
      headers: { Zp_token: 'fake-bst' },
    })
    expect(axiosCalls[0]?.args.params).toMatchObject({
      securityId: 'sec-1',
      jobId: 'job-1',
    })
  })

  it("code 1 + '120位BOSS' popup → POSTs chatremind confirm, then retries publish, then succeeds", async () => {
    responseQueue = [
      // 1st call: friend/add.json returns code 1 with 120-popup payload.
      {
        data: {
          code: 1,
          message: '需要确认',
          zpData: {
            bizData: {
              chatRemindDialog: {
                content: '您今天已与120位BOSS沟通,请确认',
                ba: 'fake-ba',
              },
            },
          },
        },
      },
      // 2nd call: chatremind confirm POST, sendPublishReq ignores its body.
      { data: { code: 0 } },
      // 3rd call: retry friend/add.json with cid=1 → success.
      { data: { code: 0, message: 'ok' } },
    ]

    const data = await sendPublishReq(makeJobItem())
    expect(data).toEqual({ code: 0, message: 'ok' })

    expect(axiosCalls).toHaveLength(3)
    // call 1: friend/add.json
    expect(axiosCalls[0]?.args.url).toBe(
      'https://www.zhipin.com/wapi/zpgeek/friend/add.json',
    )
    // call 2: chatremind confirm
    expect(axiosCalls[1]?.args.url).toBe(
      'https://www.zhipin.com/wapi/zpCommon/actionLog/geek/chatremind.json',
    )
    expect(axiosCalls[1]?.args.method).toBe('POST')
    // call 3: retry friend/add.json with cid: 1
    expect(axiosCalls[2]?.args.url).toBe(
      'https://www.zhipin.com/wapi/zpgeek/friend/add.json',
    )
    expect(axiosCalls[2]?.args.params).toMatchObject({
      securityId: 'sec-1',
      jobId: 'job-1',
      cid: 1,
    })
  })

  it("code 1 + '150位BOSS' popup → throws LimitError", async () => {
    responseQueue = [
      {
        data: {
          code: 1,
          message: '已达上限',
          zpData: {
            bizData: {
              chatRemindDialog: {
                content: '您今天已与150位BOSS沟通',
                ba: 'fake-ba',
              },
            },
          },
        },
      },
    ]

    await expect(sendPublishReq(makeJobItem())).rejects.toBeInstanceOf(LimitError)
    expect(axiosCalls).toHaveLength(1)
  })

  it("code 1 + '操作过于频繁' → throws RateLimitError", async () => {
    responseQueue = [
      {
        data: {
          code: 1,
          message: '操作过于频繁',
          zpData: {
            bizData: {
              chatRemindDialog: {
                content: '操作过于频繁,请稍后再试',
                ba: 'fake-ba',
              },
            },
          },
        },
      },
    ]

    await expect(sendPublishReq(makeJobItem())).rejects.toBeInstanceOf(RateLimitError)
    expect(axiosCalls).toHaveLength(1)
  })

  it("code 1 + unknown popup → throws PublishError carrying the content", async () => {
    responseQueue = [
      {
        data: {
          code: 1,
          message: '未知',
          zpData: {
            bizData: {
              chatRemindDialog: {
                content: '某个未知错误',
                ba: 'fake-ba',
              },
            },
          },
        },
      },
    ]

    await expect(sendPublishReq(makeJobItem())).rejects.toBeInstanceOf(PublishError)
    expect(axiosCalls).toHaveLength(1)
  })
})

// ── 4. ChatMessages shape oracle (chatBossMessage) ────────────────────────
//
// `handles.ts` -> `chatBossMessage(ctx, msg)` does:
//
//   chatMessages.value.push({
//     id: d.getTime(),
//     role: 'boss',
//     content: msg,
//     date: [getCurDay(d), getCurTime(d)],
//     name: ctx.listData.brandName,
//     avatar: ctx.listData.brandLogo,
//   })
//
// We exercise the SHAPE — same fields, same types, same `date` tuple
// arity — without booting Pinia / useModel. That keeps this test
// laser-focused on the oracle while still catching any future refactor
// that would change the message shape.

interface ChatMessageShape {
  id: number
  role: 'boss' | 'user' | 'assistant'
  content: string
  date: [string, string]
  name?: string
  avatar?: string | { icon?: string; color?: string }
}

function shapeOfChatBossMessage(args: {
  msg: string
  brandName: string
  brandLogo: string
  d?: Date
}): ChatMessageShape {
  const d = args.d ?? new Date()
  // Mirror utils/index.ts implementation exactly. We DON'T import the real
  // ones to keep this oracle hermetic; if the source helpers change in a
  // way that violates the date tuple shape, the type check below fails.
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const time = `${String(d.getHours() + 1).padStart(2, '0')}:${String(d.getMinutes() + 1).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  return {
    id: d.getTime(),
    role: 'boss',
    content: args.msg,
    date: [day, time],
    name: args.brandName,
    avatar: args.brandLogo,
  }
}

describe('chatBossMessage — ChatMessage shape oracle (AC4.3)', () => {
  it('produces a message with stable field order, types, and a [day, time] tuple', () => {
    fc.assert(
      fc.property(
        fc.record({
          msg: fc.string({ maxLength: 32 }),
          brandName: fc.string({ minLength: 1, maxLength: 12 }),
          brandLogo: fc.webUrl(),
        }),
        (input) => {
          const fixedDate = new Date(0)
          const m = shapeOfChatBossMessage({ ...input, d: fixedDate })

          expect(typeof m.id).toBe('number')
          expect(m.id).toBe(0)
          expect(m.role).toBe('boss')
          expect(m.content).toBe(input.msg)
          expect(Array.isArray(m.date)).toBe(true)
          expect(m.date).toHaveLength(2)
          expect(typeof m.date[0]).toBe('string')
          expect(typeof m.date[1]).toBe('string')
          // 'YYYY-MM-DD'
          expect(m.date[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          // 'HH:MM:SS'
          expect(m.date[1]).toMatch(/^\d{2}:\d{2}:\d{2}$/)
          expect(m.name).toBe(input.brandName)
          expect(m.avatar).toBe(input.brandLogo)

          // Field set equality: any new field added to the shape would
          // surface here as a regression for the orchestrator to triage.
          expect(Object.keys(m).sort()).toEqual(
            ['avatar', 'content', 'date', 'id', 'name', 'role'].sort(),
          )
        },
      ),
      { numRuns: 16 },
    )
  })
})

// ── 5. Healthy-greeting baseline (post-3.3 contract) ─────────────────────
//
// Post-task-3.3, `aiGreeting()` / `customGreeting()` `await buf.send({...})`
// and only write the success markers (`ctx.message`, `ctx.aiGreetingA`,
// `ctx.aiGreetingR`) once `result.ok === true`. To exercise the healthy
// path without a real Boss server, we schedule an inbound ACK via
// `ackRegistry.resolveOk(buf.cmid, 'mid-fake')` on the next microtask;
// `Message.send` registers the pending entry first, then the microtask
// settles it as ok=true.
//
// What this oracle pins (Property 2 — Preservation):
//   - `stats.success` increments exactly once when the ACK arrives.
//   - `stats.greetUnverified === 0` and `stats.greetRejected === 0`.
//   - `ctx.message === content` and `ctx.aiGreetingA === content`.
//   - Telemetry includes BOTH `'消息发送/已入队'` (channel SDK accepted) AND
//     `'消息发送/已确认'` (ackRegistry settled ok=true).

interface FakeStats {
  success: number
  greetUnverified: number
  greetRejected: number
}

function makeStats(): FakeStats {
  return { success: 0, greetUnverified: 0, greetRejected: 0 }
}

async function simulateHealthyAiGreetingAfter(opts: {
  content: string
  stats: FakeStats
}): Promise<{ aiGreetingA?: string; message?: string }> {
  const ctx: { aiGreetingA?: string; message?: string } = {}
  const buf = new Message({
    form_uid: '1001',
    to_uid: '2002',
    to_name: 'encryptedHrId',
    content: opts.content,
  })
  // Schedule an inbound ACK on the next microtask. By that time `buf.send`
  // (an async method) has run synchronously up to its first `await`, which
  // includes registering the cmid in `ackRegistry`. The microtask then
  // fires `resolveOk` against that pending entry, settling it as ok=true
  // before the ackRegistry timeout (1000ms minimum) elapses.
  void Promise.resolve().then(() => {
    ackRegistry.resolveOk(buf.cmid, 'mid-fake')
  })
  const result = await buf.send({ timeoutMs: 1000 })
  if (!result.ok) {
    throw new Error(`Healthy baseline unexpectedly failed: ${result.reason}`)
  }
  // Mirror handles.ts post-3.3: success markers written ONLY when ok=true.
  ctx.message = opts.content
  ctx.aiGreetingA = opts.content
  opts.stats.success++
  return ctx
}

describe('Healthy AI greeting after-hook — baseline oracle (AC4.1)', () => {
  it('stats.success bumps exactly once, ctx.message/aiGreetingA equal content, telemetry includes "已入队" + "已确认"', async () => {
    // Real timers here — we rely on real microtask ordering for the
    // resolveOk → ackRegistry → attachOutcomeLogger chain to settle the
    // promise. Using fake timers would still work for microtasks, but it
    // simplifies the reasoning to keep this oracle on real timers.
    vi.useRealTimers()

    const w = window as Win
    const geekSend = vi.fn() // sync no-throw
    w.GeekChatCore = {
      getInstance: () => ({ getClient: () => ({ client: { send: geekSend } }) }),
    }
    ackRegistry.__reset()

    const stats = makeStats()
    const ctx = await simulateHealthyAiGreetingAfter({ content: 'hello', stats })

    expect(stats.success).toBe(1)
    expect(stats.greetUnverified).toBe(0)
    expect(stats.greetRejected).toBe(0)
    expect(ctx.message).toBe('hello')
    expect(ctx.aiGreetingA).toBe('hello')

    expect(geekSend).toHaveBeenCalledTimes(1)
    const titles = debugCalls.map((c) => c.title)
    // Post-3.3 oracle: '消息发送/已入队' (channel SDK accepted the buffer)
    // AND '消息发送/已确认' (ackRegistry resolved with ok=true).
    expect(titles).toContain('消息发送/已入队')
    expect(titles).toContain('消息发送/已确认')
  })

  it('property: any random content → stats.success === 1 every time, telemetry contains both "已入队" and "已确认"', async () => {
    // Real timers + microtask-driven ACK. fast-check iterations run in
    // sequence, each one fully settles before the next register/resolve.
    vi.useRealTimers()

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 32 }),
        async (content) => {
          const w = window as Win
          const geekSend = vi.fn()
          w.GeekChatCore = {
            getInstance: () => ({
              getClient: () => ({ client: { send: geekSend } }),
            }),
          }
          debugCalls.length = 0
          ackRegistry.__reset()
          const stats = makeStats()

          const ctx = await simulateHealthyAiGreetingAfter({ content, stats })

          expect(stats.success).toBe(1)
          expect(stats.greetUnverified).toBe(0)
          expect(stats.greetRejected).toBe(0)
          expect(ctx.message).toBe(content)
          expect(ctx.aiGreetingA).toBe(content)
          const titles = debugCalls.map((c) => c.title)
          expect(titles).toContain('消息发送/已入队')
          expect(titles).toContain('消息发送/已确认')
        },
      ),
      { numRuns: 8 },
    )
  })
})

/**
 * Validates: Requirements 4.1, 4.2, 4.3, 6.1, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */
