/**
 * Unit + integration tests for `ackRegistry` (Task 3.1).
 *
 * Spec:   .kiro/specs/ai-greeting-send-verification/{requirements,design,tasks}.md
 *
 * Coverage:
 *   - register resolves on resolveOk (success path)
 *   - register resolves on resolveFail (server-rejected path)
 *   - register times out when no ACK arrives
 *   - cmid collision resolves the OLD promise then registers the NEW one
 *   - release removes a pending entry without settling its promise
 *   - Tier B WebSocket discovery: lazy-init via register, dispatch a
 *     synthetic ArrayBuffer frame whose decoded `messages[0].cmid === cmid`,
 *     assert resolveOk with the expected `ackMid`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// eslint-disable-next-line import/first
import { ackRegistry } from '@/composables/useWebSocket/ackRegistry'
// eslint-disable-next-line import/first
import { AwesomeMessage } from '@/composables/useWebSocket/type'

// ── Fake WebSocket helper ──────────────────────────────────────────────────
// Build a `WebSocket`-shaped object that passes `instanceof WebSocket` and
// reports `readyState === OPEN` so `ackRegistry.tryHookWebSocket()` accepts
// it. We collect the `addEventListener` callback as a spy for direct dispatch.

interface FakeWs {
  ws: WebSocket
  fire: (event: MessageEvent) => void
  addEventListener: ReturnType<typeof vi.fn>
}

function makeFakeWebSocket(): FakeWs {
  const handlers: Array<(ev: MessageEvent) => void> = []
  const ws = Object.create(WebSocket.prototype) as WebSocket
  // jsdom defines WebSocket.OPEN === 1
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN, configurable: true })
  const addEventListener = vi.fn(
    (
      type: string,
      cb: EventListenerOrEventListenerObject,
      _opts?: AddEventListenerOptions | boolean,
    ) => {
      if (type === 'message' && typeof cb === 'function') {
        handlers.push(cb as (ev: MessageEvent) => void)
      }
    },
  )
  Object.defineProperty(ws, 'addEventListener', { value: addEventListener, configurable: true })
  Object.defineProperty(ws, 'removeEventListener', { value: vi.fn(), configurable: true })
  return {
    ws,
    addEventListener,
    fire: (event: MessageEvent) => {
      for (const h of handlers) h(event)
    },
  }
}

function encodeEchoFrame(cmid: string, mid: string): ArrayBuffer {
  const proto = AwesomeMessage.create({
    type: 1,
    messages: [
      {
        from: { uid: '1', source: 0 },
        to: { uid: '2', name: 'enc', source: 0 },
        type: 1,
        mid,
        time: '0',
        body: { type: 1, templateId: 1, text: 'hi' },
        cmid,
      },
    ],
  })
  const u8 = AwesomeMessage.encode(proto).finish()
  // Slice into a fresh ArrayBuffer to ensure `instanceof ArrayBuffer` is true.
  const ab = new ArrayBuffer(u8.byteLength)
  new Uint8Array(ab).set(u8)
  return ab
}

function encodeMessageSyncFrame(cmid: string, serverMid: string): ArrayBuffer {
  const proto = AwesomeMessage.create({
    type: 1,
    messageSync: [
      {
        clientMid: cmid,
        serverMid,
      },
    ],
  })
  const u8 = AwesomeMessage.encode(proto).finish()
  const ab = new ArrayBuffer(u8.byteLength)
  new Uint8Array(ab).set(u8)
  return ab
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(() => {
  ackRegistry.__reset()
  // Wipe any window-installed channels from prior tests.
  const w = window as unknown as Record<string, unknown>
  delete w.GeekChatCore
  delete w.ChatWebsocket
})

afterEach(() => {
  vi.useRealTimers()
  ackRegistry.__reset()
  const w = window as unknown as Record<string, unknown>
  delete w.GeekChatCore
  delete w.ChatWebsocket
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ackRegistry.register — basic resolution semantics', () => {
  it('resolves with ok=true when resolveOk is called', async () => {
    const cmid = 'cmid-ok-1'
    const p = ackRegistry.register(cmid, 5_000, 'GeekChatCore')
    ackRegistry.resolveOk(cmid, 'mid-42', 0)
    const r = await p
    expect(r).toEqual({
      ok: true,
      channel: 'GeekChatCore',
      cmid,
      ackMid: 'mid-42',
      serverCode: 0,
    })
  })

  it('resolves with ok=false (SERVER_REJECTED) when resolveFail is called', async () => {
    const cmid = 'cmid-fail-1'
    const p = ackRegistry.register(cmid, 5_000, 'ChatWebsocket')
    ackRegistry.resolveFail(cmid, 'SERVER_REJECTED', -1, '相同消息')
    const r = await p
    expect(r).toEqual({
      ok: false,
      channel: 'ChatWebsocket',
      cmid,
      reason: 'SERVER_REJECTED',
      serverCode: -1,
      serverMessage: '相同消息',
    })
  })

  it('times out with reason=TIMEOUT when no ack arrives within timeoutMs', async () => {
    vi.useFakeTimers()
    const cmid = 'cmid-timeout-1'
    const p = ackRegistry.register(cmid, 1_000, 'EventBus')
    vi.advanceTimersByTime(1_000)
    const r = await p
    expect(r).toEqual({
      ok: false,
      channel: 'EventBus',
      cmid,
      reason: 'TIMEOUT',
    })
  })

  it('release() removes a pending entry without settling the promise (no double-resolve)', async () => {
    vi.useFakeTimers()
    const cmid = 'cmid-release-1'
    const p = ackRegistry.register(cmid, 2_000, 'GeekChatCore')

    let settled: SettledTag = { tag: 'pending' }
    const tracker = p.then(
      (v) => {
        settled = { tag: 'fulfilled', value: v }
      },
      (e) => {
        settled = { tag: 'rejected', reason: e }
      },
    )

    ackRegistry.release(cmid)

    // Even after the original timeout would have fired, the promise must NOT
    // be settled — release cleared the timer and removed the entry without
    // calling resolve.
    vi.advanceTimersByTime(5_000)
    await Promise.resolve()
    expect(settled.tag).toBe('pending')

    // Now manually resolve via the public API; this should be a no-op
    // because the entry was released.
    ackRegistry.resolveOk(cmid, 'mid-late')
    await Promise.resolve()
    expect(settled.tag).toBe('pending')

    // Avoid hanging the test runner on `tracker`. Don't await it.
    void tracker
  })

  it('cmid collision resolves the OLD promise with CMID_COLLISION, then registers the NEW one', async () => {
    vi.useFakeTimers()
    const cmid = 'cmid-collide-1'

    const oldP = ackRegistry.register(cmid, 5_000, 'GeekChatCore')
    const newP = ackRegistry.register(cmid, 3_000, 'ChatWebsocket')

    const oldR = await oldP
    expect(oldR).toEqual({
      ok: false,
      channel: 'GeekChatCore',
      cmid,
      reason: 'CMID_COLLISION',
    })

    // The new registration is now active — resolve it explicitly to verify
    // it is wired to the latest channel.
    ackRegistry.resolveOk(cmid, 'mid-99')
    const newR = await newP
    expect(newR).toEqual({
      ok: true,
      channel: 'ChatWebsocket',
      cmid,
      ackMid: 'mid-99',
    })
  })

  it('subsequent resolveOk/resolveFail for an already-settled cmid is a silent no-op', async () => {
    const cmid = 'cmid-noop-1'
    const p = ackRegistry.register(cmid, 5_000, 'GeekChatCore')
    ackRegistry.resolveOk(cmid, 'mid-1')
    const r = await p
    expect(r.ok).toBe(true)

    // These must not throw and must not leak into any future test.
    expect(() => ackRegistry.resolveOk(cmid, 'mid-2')).not.toThrow()
    expect(() =>
      ackRegistry.resolveFail(cmid, 'SERVER_REJECTED', -1, 'late'),
    ).not.toThrow()
    expect(() => ackRegistry.release(cmid)).not.toThrow()
  })
})

describe('ackRegistry — Tier B WebSocket discovery + frame dispatch', () => {
  it('lazy-attaches to a fake WebSocket on first register and resolves via inbound echo frame', async () => {
    const fake = makeFakeWebSocket()

    // Install fake into `window.ChatWebsocket` so `tryHookWebSocket()` finds it.
    const w = window as unknown as { ChatWebsocket?: unknown }
    w.ChatWebsocket = { ws: fake.ws }

    const cmid = '6826502718000'
    const expectedMid = '6826502718001'

    const p = ackRegistry.register(cmid, 5_000, 'ChatWebsocket')

    // Lazy init must have called addEventListener('message', ...).
    expect(fake.addEventListener).toHaveBeenCalled()
    const [type, , opts] = fake.addEventListener.mock.calls[0]
    expect(type).toBe('message')
    // Passive listener per AC7.5
    expect(opts).toMatchObject({ capture: false, passive: true })

    // Dispatch a synthetic ArrayBuffer frame whose decoded
    // `messages[0].cmid === cmid` to trigger the success path.
    const frame = encodeEchoFrame(cmid, expectedMid)
    const ev = new MessageEvent('message', { data: frame })
    fake.fire(ev)

    const r = await p
    expect(r).toEqual({
      ok: true,
      channel: 'ChatWebsocket',
      cmid,
      ackMid: expectedMid,
      ackSource: 'messages.cmid',
    })
  })

  it('inbound frame for an unknown cmid is a no-op (does not settle other pending registrations)', async () => {
    vi.useFakeTimers()
    const fake = makeFakeWebSocket()
    const w = window as unknown as { ChatWebsocket?: unknown }
    w.ChatWebsocket = { ws: fake.ws }

    // `cmid` is encoded as int64 by protobufjs so it must be numeric-string.
    const cmid = '6826502718000'
    const otherCmid = '6826502719999'

    const p = ackRegistry.register(cmid, 1_000, 'ChatWebsocket')

    // Fire an echo for an unrelated cmid.
    const frame = encodeEchoFrame(otherCmid, '7777777777777')
    fake.fire(new MessageEvent('message', { data: frame }))

    // Pending registration must still time out.
    vi.advanceTimersByTime(1_000)
    const r = await p
    expect(r).toEqual({
      ok: false,
      channel: 'ChatWebsocket',
      cmid,
      reason: 'TIMEOUT',
    })
  })

  it('resolves via inbound messageSync clientMid/serverMid frame', async () => {
    const fake = makeFakeWebSocket()
    const w = window as unknown as { ChatWebsocket?: unknown }
    w.ChatWebsocket = { ws: fake.ws }

    const cmid = '6826502718123'
    const serverMid = '6826502718456'

    const p = ackRegistry.register(cmid, 5_000, 'ChatWebsocket')
    fake.fire(new MessageEvent('message', { data: encodeMessageSyncFrame(cmid, serverMid) }))

    await expect(p).resolves.toEqual({
      ok: true,
      channel: 'ChatWebsocket',
      cmid,
      ackMid: serverMid,
      ackSource: 'messageSync.clientMid',
    })
  })

  it('non-ArrayBuffer or malformed frames are silently ignored', async () => {
    vi.useFakeTimers()
    const fake = makeFakeWebSocket()
    const w = window as unknown as { ChatWebsocket?: unknown }
    w.ChatWebsocket = { ws: fake.ws }

    const cmid = 'cmid-ignore-1'
    const p = ackRegistry.register(cmid, 1_000, 'ChatWebsocket')

    // String data → ignored.
    fake.fire(new MessageEvent('message', { data: 'not a buffer' as unknown as ArrayBuffer }))
    // Garbage bytes → decode throws → caught and ignored.
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff]).buffer
    fake.fire(new MessageEvent('message', { data: garbage }))

    vi.advanceTimersByTime(1_000)
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('TIMEOUT')
  })
})

// Helper type for release() observer.
type SettledTag =
  | { tag: 'pending' }
  | { tag: 'fulfilled'; value: unknown }
  | { tag: 'rejected'; reason: unknown }

/**
 * Validates: Requirements 1.2, 1.3, 2.3, 3.2, 6.2, 7.1, 7.3, 7.5, 7.6, 7.7
 */
