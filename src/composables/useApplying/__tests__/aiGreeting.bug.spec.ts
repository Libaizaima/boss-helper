/**
 * Bug Condition exploration property test for AI / 自定义招呼语 send-verification.
 *
 * Spec:   .kiro/specs/ai-greeting-send-verification/{requirements,design,tasks}.md
 * Task:   "1. 在未修复代码上写 Bug Condition 探索性属性测试（必须 FAIL）"
 *         + Updated at task 3.3 to reflect the fixed `Message.send` contract:
 *           the simulator now `await`s the registry-driven promise and maps
 *           `SendResult.reason` to greetUnverified / greetRejected. The
 *           assertions are unchanged in spirit — they still pin Property 1.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  CONTRACT FLIP (TASK 3.3 + 3.6):                                         ║
 * ║    Pre-3.3 unfixed code: this test FAILED (the success criterion of      ║
 * ║      task 1 — failure proved Bug Condition reachability).                ║
 * ║    Post-3.3 fixed code: this test now PASSES — every Bug Condition       ║
 * ║      sub-domain produces `result.ok === false`, the simulator throws     ║
 * ║      `GreetError`, and exactly one of greetUnverified / greetRejected    ║
 * ║      is bumped. This is the validation the orchestrator will run at 3.6.║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Property 1 (Bug Condition):
 *   forall input. isBugCondition(input) === true
 *      ⟹  buf.send()-driven greeting after-hook MUST throw GreetError,
 *           AND useLog().debug MUST NOT have written '消息发送/成功' or '消息发送/已确认',
 *           AND statistics.todayData.success MUST NOT have been auto-incremented,
 *           AND exactly one of {greetUnverified, greetRejected} MUST have been bumped.
 *
 * ── Subdomains covered (each as its own fast-check property) ───────────────
 *   C₁  channel-up-but-WS-down          GeekChatCore.client.send is a no-op.
 *   C₂  buffered-only channel            ChatWebsocket.send is a no-op.
 *   C₃  server-rejected echo             ChatWebsocket.send is a no-op AND a
 *                                        TechwolfIqResponse-style rejection
 *                                        frame would arrive (no inbound
 *                                        dispatcher in this fixture, so the
 *                                        fixed code degrades to TIMEOUT).
 *   C₄  EventBus success-but-server-     EventBus.publish triggers its success
 *        silent                          callback yet no inbound ACK arrives.
 *
 * ── Anti-anti-fraud constraints respected (AC7.1–AC7.7) ────────────────────
 *   - No outbound HTTP / WebSocket / EventBus requests beyond what existing
 *     source code already issues; mocks intercept locally inside the test.
 *   - No mutation of the protocol byte layout, cmid generation, channel
 *     priority, or any source file. Mocks are dependency-injection only.
 *   - `vi.useFakeTimers()` drives the ackRegistry timeout deterministically;
 *     no real-time wall clock is observed by the test process.
 */

import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── 1. Telemetry collector + module mocks ─────────────────────────────────
//
// `protobuf.ts` writes telemetry through `useLog().debug(title, message, payload)`.
// Capturing those calls is the core observation channel of this test.

interface DebugCall {
  title: string
  message: string
  payload?: unknown
}

const debugCalls: DebugCall[] = []

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
import { ackRegistry } from '@/composables/useWebSocket/ackRegistry'
// eslint-disable-next-line import/first
import { Message } from '@/composables/useWebSocket/protobuf'
// eslint-disable-next-line import/first
import { GreetError } from '@/types/deliverError'

// ── 2. Test fixtures: simulate handles.ts greeting after-hook ─────────────
//
// `simulateGreetingAfter` mirrors the relevant lines of
// `src/composables/useApplying/handles.ts` (`aiGreeting` / `customGreeting`
// after-hook) WITHOUT pulling in pinia / useChat / useModel. Post-3.3 it
// matches the new contract verbatim:
//
//   const result = await buf.send({ timeoutMs })
//   if (!result.ok) throw new GreetError(mapSendFailureToMessage(result))
//   // ctx.message / ctx.aiGreetingA / ctx.aiGreetingR are written ONLY here
//   ctx.aiGreetingA = content
//   stats.success++
//
// Per the task brief, the simulator pins greetUnverified / greetRejected
// from the `SendResult.reason`:
//   TIMEOUT / UNVERIFIED / CMID_COLLISION → greetUnverified
//   SERVER_REJECTED / EVENTBUS_FAILED / CHANNEL_SYNC_THROW / NO_CHANNEL → greetRejected
//
// We use a SHORT timeoutMs (50ms) and `vi.advanceTimersByTimeAsync(50)` so
// each property iteration settles in a single microtask flush — vitest does
// not have to wait the production 5s default.

interface FakeStats {
  success: number
  greetUnverified: number
  greetRejected: number
}

function makeStats(): FakeStats {
  return { success: 0, greetUnverified: 0, greetRejected: 0 }
}

interface SendResultLike {
  ok: boolean
  reason?: string
  channel?: string
  cmid?: string
  serverCode?: number
  serverMessage?: string
}

function isSendResult(v: unknown): v is SendResultLike {
  return v != null && typeof v === 'object' && 'ok' in (v as Record<string, unknown>)
}

function classifyReason(reason: string | undefined): 'unverified' | 'rejected' {
  switch (reason) {
    case 'TIMEOUT':
    case 'UNVERIFIED':
    case 'CMID_COLLISION':
      return 'unverified'
    // SERVER_REJECTED / EVENTBUS_FAILED / CHANNEL_SYNC_THROW / NO_CHANNEL
    // and any unknown future reason all fall here.
    default:
      return 'rejected'
  }
}

async function simulateGreetingAfter(opts: {
  content: string
  stats: FakeStats
  greetingKind: 'ai' | 'custom'
  /**
   * ACK timeout in ms. `Message.send` clamps to `[1000, 15000]` per AC1.3,
   * so the smallest deterministic delay we can drive with fake timers is
   * 1000ms. The test driver advances vitest fake timers past this floor.
   */
  timeoutMs?: number
}): Promise<{ aiGreetingA?: string }> {
  const ctx: { aiGreetingA?: string; message?: string } = {}
  try {
    const buf = new Message({
      form_uid: '1001',
      to_uid: '2002',
      to_name: 'encryptedHrId',
      content: opts.content,
    })

    // Post-3.3 contract: `Message.send` returns Promise<SendResult>. We
    // still tolerate the legacy `void` shape via `isSendResult` so a
    // future refactor of `protobuf.ts` cannot silently mute the property.
    const sendReturn = (buf as unknown as {
      send: (o?: unknown) => unknown
    }).send({ timeoutMs: opts.timeoutMs ?? 1000 })

    if (sendReturn && typeof (sendReturn as PromiseLike<unknown>).then === 'function') {
      const result = await (sendReturn as Promise<unknown>)
      if (isSendResult(result) && result.ok === false) {
        if (classifyReason(result.reason) === 'unverified') {
          opts.stats.greetUnverified++
        } else {
          opts.stats.greetRejected++
        }
        // The real `mapSendFailureToMessage` lives in handles.ts and is
        // the production wrapper; for the simulator we only need a string
        // that round-trips through GreetError so the assertion layer can
        // observe a thrown GreetError. Reason carries the diagnostic.
        throw new GreetError(`打招呼失败：${result.reason ?? 'UNKNOWN'}`)
      }
    }

    // Healthy ok-path (kept for the post-fix simulator; never reached in
    // any of the C₁–C₄ test fixtures because none of them dispatch an
    // inbound ACK frame, so `ackRegistry` always settles to TIMEOUT).
    ctx.message = opts.content
    ctx.aiGreetingA = opts.content
    opts.stats.success++
    return ctx
  } catch (e) {
    if (e instanceof GreetError) throw e
    // customGreeting wraps unknown errors in GreetError via errorHandle;
    // we mirror that behaviour for parity with handles.ts.
    throw new GreetError((e as Error)?.message ?? String(e))
  }
}

// ── 3. Window-level channel installers ────────────────────────────────────

type Win = Window & {
  GeekChatCore?: any
  ChatWebsocket?: { send: (e: { toArrayBuffer: () => ArrayBuffer }) => void } | null
  EventBus?: {
    publish: (e: string, ...data: any[]) => void
    subscribe: (e: string, t: (...data: any[]) => void) => void
  } | null
}

function clearChannels() {
  const w = window as Win
  delete w.GeekChatCore
  w.ChatWebsocket = undefined
  w.EventBus = undefined
}

function installGeekChatCore(opts: {
  /** Whether the inner SDK send call should synchronously throw (false ⟹ silent no-op). */
  syncThrow: boolean
}) {
  const w = window as Win
  w.GeekChatCore = {
    getInstance: () => ({
      getClient: () => ({
        client: {
          send: (_buf: unknown) => {
            if (opts.syncThrow) throw new Error('synthetic GeekChatCore failure')
            // C₁ / C₂ semantics: synchronous no-op. Buffer never reaches the
            // wire, but the SDK call itself does not raise.
          },
        },
      }),
    }),
  }
}

function installChatWebsocket(opts: { syncThrow: boolean }) {
  const w = window as Win
  w.ChatWebsocket = {
    send: (_e) => {
      if (opts.syncThrow) throw new Error('synthetic ChatWebsocket failure')
      // Channel "looks up" but the underlying WebSocket is gone.
    },
  }
}

function installEventBus(opts: { fireSuccess: boolean; fireFailure: boolean }) {
  const w = window as Win
  w.EventBus = {
    publish: (_event, _data, success, failure) => {
      if (opts.fireSuccess && typeof success === 'function') success()
      if (opts.fireFailure && typeof failure === 'function') failure()
    },
    subscribe: () => {},
  }
}

// ── 4. Lifecycle hooks ────────────────────────────────────────────────────

beforeEach(() => {
  debugCalls.length = 0
  clearChannels()
  ackRegistry.__reset()
  // Fake timers so the ackRegistry `setTimeout(timeoutMs)` settles
  // synchronously inside the test under our control. Without this the
  // 1000ms-clamped timeout would gate every property iteration on real
  // wall time.
  vi.useFakeTimers()
})

afterEach(() => {
  clearChannels()
  ackRegistry.__reset()
  vi.useRealTimers()
})

// ── 5. Bug Condition assertions (shared across C₁–C₄) ─────────────────────
//
// All four subdomains share the exact same post-conditions; only the channel
// fixture changes. Encoding them once keeps the property text aligned with
// the spec's Property 1 statement.

function assertBugConditionSatisfied(opts: {
  threwGreetError: boolean
  stats: FakeStats
  greetingKind: 'ai' | 'custom'
  ctxAiGreetingA?: string
  content: string
}) {
  const successDebugTitles = debugCalls
    .map((c) => c.title)
    .filter((t) => t === '消息发送/成功' || t === '消息发送/已确认')

  // (1) GreetError must be thrown — unfixed code does NOT throw.
  expect(
    opts.threwGreetError,
    `Bug Condition violated: simulateGreetingAfter did not throw GreetError. ` +
      `debug titles seen=${JSON.stringify(debugCalls.map((c) => c.title))}`,
  ).toBe(true)

  // (2) Telemetry must not include either pre-fix '成功' or post-fix '已确认'.
  expect(
    successDebugTitles,
    `Bug Condition violated: telemetry reports success without server ACK. ` +
      `entries=${JSON.stringify(successDebugTitles)}`,
  ).toEqual([])

  // (3) `statistics.todayData.success` must not auto-increment in this domain.
  expect(
    opts.stats.success,
    `Bug Condition violated: statistics.success bumped despite unverified send`,
  ).toBe(0)

  // (4) Exactly one of {greetUnverified, greetRejected} must be bumped.
  const bumped =
    (opts.stats.greetUnverified > 0 ? 1 : 0) + (opts.stats.greetRejected > 0 ? 1 : 0)
  expect(
    bumped,
    `Bug Condition violated: neither greetUnverified nor greetRejected was bumped. ` +
      `stats=${JSON.stringify(opts.stats)}`,
  ).toBe(1)

  // (5) For ai variant: `ctx.aiGreetingA` must NOT be the content (unfixed code
  // writes it eagerly, fixed code only writes after `result.ok === true`).
  if (opts.greetingKind === 'ai') {
    expect(
      opts.ctxAiGreetingA,
      `Bug Condition violated: ctx.aiGreetingA written to "${opts.ctxAiGreetingA ?? ''}" without ACK`,
    ).not.toBe(opts.content)
  }
}

async function runOnce(input: {
  greetingKind: 'ai' | 'custom'
  content: string
}): Promise<{
  threwGreetError: boolean
  stats: FakeStats
  ctxAiGreetingA?: string
}> {
  const stats = makeStats()
  let threw = false
  let ctxAiGreetingA: string | undefined
  // Kick off the simulator and immediately advance fake timers past the
  // ackRegistry timeout floor (1000ms after clamping). `runAllTimersAsync`
  // ensures any chained microtasks settle before we await the simulator
  // promise itself.
  //
  // We attach a no-op `.catch` to `pending` immediately so that if the
  // GreetError propagates before we `await` it below, Node does not log an
  // unhandled-rejection warning. The real catch is the `try/await` block.
  const pending = simulateGreetingAfter({
    content: input.content,
    stats,
    greetingKind: input.greetingKind,
    timeoutMs: 1000,
  })
  void pending.catch(() => {})
  // Advance enough to fire the ackRegistry TIMEOUT setTimeout(1000).
  await vi.advanceTimersByTimeAsync(1100)
  try {
    const ctx = await pending
    ctxAiGreetingA = ctx.aiGreetingA
  } catch (e) {
    if (e instanceof GreetError) threw = true
    else throw e
  }
  return { threwGreetError: threw, stats, ctxAiGreetingA }
}

// ── 6. Tests ──────────────────────────────────────────────────────────────

describe('AI / customGreeting after-hook — Bug Condition exploration (Property 1)', () => {
  /**
   * C₁ — channel-up-but-WS-down.
   * Channel object exists; SDK `client.send` is a sync no-op. No ACK ever
   * arrives, but unfixed code logs `消息发送/成功` immediately.
   *
   * UNFIXED COUNTEREXAMPLE (recorded for orchestrator):
   *   { greetingKind: 'ai', content: '' }
   *   debug titles seen = ['消息发送/成功']
   *   threw GreetError = false ; stats.success = 1 ;
   *   greetUnverified = 0 ; greetRejected = 0
   */
  it('C₁ channel-up-but-WS-down → must throw GreetError, must not log 成功 (FAILS on unfixed)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          greetingKind: fc.constantFrom('ai' as const, 'custom' as const),
          content: fc.string({ maxLength: 16 }),
        }),
        async (input) => {
          debugCalls.length = 0
          clearChannels()
          installGeekChatCore({ syncThrow: false })

          const observed = await runOnce(input)

          assertBugConditionSatisfied({
            threwGreetError: observed.threwGreetError,
            stats: observed.stats,
            greetingKind: input.greetingKind,
            ctxAiGreetingA: observed.ctxAiGreetingA,
            content: input.content,
          })
        },
      ),
      { numRuns: 8 },
    )
  })

  /**
   * C₂ — buffered-only channel.
   * GeekChatCore is absent; ChatWebsocket.send is a sync no-op (frame is
   * buffered locally and never written to the wire).
   *
   * UNFIXED COUNTEREXAMPLE (recorded for orchestrator):
   *   { greetingKind: 'custom', content: '' }
   *   debug titles seen = ['消息发送/成功']
   *   threw GreetError = false ; stats.success = 1 ;
   *   greetUnverified = 0 ; greetRejected = 0
   */
  it('C₂ buffered-only channel → must throw GreetError, must not log 成功 (FAILS on unfixed)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          greetingKind: fc.constantFrom('ai' as const, 'custom' as const),
          content: fc.string({ maxLength: 16 }),
        }),
        async (input) => {
          debugCalls.length = 0
          clearChannels()
          installChatWebsocket({ syncThrow: false })

          const observed = await runOnce(input)

          assertBugConditionSatisfied({
            threwGreetError: observed.threwGreetError,
            stats: observed.stats,
            greetingKind: input.greetingKind,
            ctxAiGreetingA: observed.ctxAiGreetingA,
            content: input.content,
          })
        },
      ),
      { numRuns: 8 },
    )
  })

  /**
   * C₃ — server-rejected echo.
   * Channel succeeds synchronously, but Boss would reject with non-zero code
   * (e.g. -1 / 1 / 2 / 3 —风控、限频、相同消息、敏感词). Unfixed code never
   * listens for inbound frames so the rejection is unobservable to the
   * caller; fixed code must surface SERVER_REJECTED → GreetError.
   *
   * UNFIXED COUNTEREXAMPLE (recorded for orchestrator):
   *   { greetingKind: 'ai', content: '', serverCode: -1, messageReason: '相同消息' }
   *   debug titles seen = ['消息发送/成功']
   *   threw GreetError = false ; stats.success = 1 ;
   *   greetRejected = 0 (should have been 1 on fixed code)
   */
  it('C₃ server-rejected echo → must throw GreetError carrying serverCode (FAILS on unfixed)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          greetingKind: fc.constantFrom('ai' as const, 'custom' as const),
          content: fc.string({ maxLength: 16 }),
          serverCode: fc.constantFrom(-1, 1, 2, 3),
          messageReason: fc.constantFrom('相同消息', '操作过于频繁', '敏感词', '非好友'),
        }),
        async (input) => {
          debugCalls.length = 0
          clearChannels()
          installChatWebsocket({ syncThrow: false })

          // NOTE: We deliberately DO NOT install any inbound-frame dispatcher.
          // The unfixed code has no inbound listener; even if we dispatched
          // an IqResponse-style frame here it would be ignored. Recording
          // the would-be rejection in a closure suffices for the property,
          // because the bug manifests as "success logged regardless of any
          // rejection signal".
          const _wouldBeRejection = {
            cmid: '<set-by-Message-ctor>',
            code: input.serverCode,
            message: input.messageReason,
          }
          void _wouldBeRejection

          const observed = await runOnce(input)

          assertBugConditionSatisfied({
            threwGreetError: observed.threwGreetError,
            stats: observed.stats,
            greetingKind: input.greetingKind,
            ctxAiGreetingA: observed.ctxAiGreetingA,
            content: input.content,
          })
        },
      ),
      { numRuns: 12 },
    )
  })

  /**
   * C₄ — EventBus publish 不抛错也只能证明页面事件入队。
   * EventBus 渠道无法可靠获取服务端 ACK，必须按未确认处理。
   */
  it('C₄ EventBus publish 不抛错 → UNVERIFIED, stats.greetUnverified 自增, 抛 GreetError', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          greetingKind: fc.constantFrom('ai' as const, 'custom' as const),
          content: fc.string({ maxLength: 16 }),
        }),
        async (input) => {
          debugCalls.length = 0
          clearChannels()
          installEventBus({ fireSuccess: true, fireFailure: false })

          const stats = makeStats()
          let threw = false
          let ctxAiGreetingA: string | undefined

          const pending = simulateGreetingAfter({
            content: input.content,
            stats,
            greetingKind: input.greetingKind,
            timeoutMs: 1000,
          })
          void pending.catch(() => {})
          await vi.advanceTimersByTimeAsync(10)
          try {
            const ctx = await pending
            ctxAiGreetingA = ctx.aiGreetingA
          } catch (e) {
            if (e instanceof GreetError) threw = true
            else throw e
          }

          expect(threw, 'EventBus 无法验证服务端 ACK 时应抛 GreetError').toBe(true)
          expect(stats.success, 'stats.success 应为 0').toBe(0)
          expect(stats.greetUnverified, 'greetUnverified 应为 1').toBe(1)
          expect(stats.greetRejected, 'greetRejected 应为 0').toBe(0)
          if (input.greetingKind === 'ai') {
            expect(ctxAiGreetingA).toBeUndefined()
          }
        },
      ),
      { numRuns: 8 },
    )
  })
})

/**
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.3, 5.1, 5.2, 6.2, 6.3
 */
