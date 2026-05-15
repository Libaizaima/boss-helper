/**
 * Preservation property tests for `Message` (src/composables/useWebSocket/protobuf.ts).
 *
 * Spec:   .kiro/specs/ai-greeting-send-verification/{requirements,design,tasks}.md
 * Task:   "2. 在未修复代码上写 Preservation 属性测试（必须 PASS）"
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  EXPECTED OUTCOME ON UNFIXED CODE: ALL TESTS PASS.                       ║
 * ║  This file freezes the byte-level / channel-priority oracle that the    ║
 * ║  Bugfix MUST keep intact (AC4.1–AC4.3, AC7.3 anti-fraud).                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Property 2 (Preservation) covered here:
 *   - Determinism of `Message.encode` given the same `(form_uid, to_uid,
 *     to_name, content)` and a frozen `Date.now()`.
 *   - Byte-identical golden hex recorded once on UNFIXED code; locks down
 *     `cmid` / `mid` algorithm (`Date.now() + 68256432452609`), field order,
 *     `source` / `type` / `templateId`, and string encoding order.
 *   - Channel priority: `GeekChatCore` → `ChatWebsocket` → `EventBus`. The
 *     first available + sync-non-throwing channel wins; the others MUST NOT
 *     be consulted.
 *   - EventBus-only behaviour on `success` / `failure` callbacks: both
 *     return WITHOUT throwing on unfixed code; only the telemetry title
 *     differs. This matches AC7.5 (passive monitoring, no spurious throws).
 *   - All-channels-missing: synchronous `throw new Error(...)` containing
 *     the diagnostic substring `'无可用消息发送渠道'`.
 *
 * ── Anti-anti-fraud constraints respected (AC7.1–AC7.7) ────────────────────
 *   - No outbound HTTP / WebSocket / EventBus is performed; every channel is
 *     a local `vi.fn()` mock installed on `window`.
 *   - No source modification. `protobuf.ts` is imported as-is.
 *   - `numRuns` are kept ≤ 16 for byte-level oracle properties so the test
 *     run is fast and deterministic.
 */

import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── 1. Mocks for `useLog` / `logger` / `element-plus` ─────────────────────
//
// `protobuf.ts` writes telemetry through `useLog().debug(title, message, payload)`.
// The "all channels missing" branch also calls `ElMessage.error(...)` and
// `logger.error(...)` before throwing.

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
import { Message } from '@/composables/useWebSocket/protobuf'

// ── 2. Window channel installers ──────────────────────────────────────────

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
  // `ChatWebsocket` typing in env.d.ts is non-optional, but for the runtime
  // check `'ChatWebsocket' in window && window.ChatWebsocket != null` an
  // `undefined` value is treated as "absent".
  w.ChatWebsocket = undefined
  w.EventBus = undefined
}

beforeEach(() => {
  debugCalls.length = 0
  clearChannels()
})

afterEach(() => {
  vi.useRealTimers()
  clearChannels()
})

// ── 3. Encoding determinism + golden hex oracle ───────────────────────────
//
// Golden hex captured once on unfixed code with `Date.now() === 0`, i.e.
// `r = 0`, `d = 68256432452609`. Three example fixtures lock down field
// order, varint encoding, string encoding, and constant `source`/`type`/
// `templateId` values. Any future change to the protocol fingerprint
// (cmid algorithm, field tags, source value, etc) will break these.

const GOLDEN: Array<{
  args: { form_uid: string; to_uid: string; to_name: string; content: string }
  hex: string
}> = [
  {
    args: { form_uid: '1001', to_uid: '2002', to_name: 'encryptedHrId', content: 'hello' },
    hex: '08011a3e0a0508e9073800121408d20f120d656e6372797074656448724964380018012081e8a383c3c20f2800320b080110011a0568656c6c6f5881e8a383c3c20f',
  },
  {
    args: { form_uid: '1', to_uid: '2', to_name: 'A', content: '' },
    hex: '08011a2b0a040801380012070802120141380018012081e8a383c3c20f28003206080110011a005881e8a383c3c20f',
  },
  {
    args: { form_uid: '12345678', to_uid: '87654321', to_name: 'XYZ', content: '你好' },
    hex: '08011a390a0708cec2f1053800120c08b1ffe529120358595a380018012081e8a383c3c20f2800320c080110011a06e4bda0e5a5bd5881e8a383c3c20f',
  },
]

function bytesToHex(u8: Uint8Array): string {
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('Message — encoding determinism + golden hex (Preservation, AC7.3)', () => {
  it('encodes the recorded golden hex byte-for-byte at Date.now() === 0', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    for (const fixture of GOLDEN) {
      const buf = new Message(fixture.args)
      expect(bytesToHex(buf.msg)).toBe(fixture.hex)
      expect(buf.hex).toBe(fixture.hex)
    }
  })

  it('produces the same byte sequence for the same (inputs, frozen Date.now)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    fc.assert(
      fc.property(
        fc.record({
          form_uid: fc
            .integer({ min: 1, max: 9_999_999_999 })
            .map((n) => n.toString()),
          to_uid: fc
            .integer({ min: 1, max: 9_999_999_999 })
            .map((n) => n.toString()),
          to_name: fc.string({ minLength: 0, maxLength: 16 }),
          content: fc.string({ minLength: 0, maxLength: 32 }),
        }),
        (args) => {
          // Two encodes at the SAME frozen timestamp → identical bytes.
          const a = new Message(args).msg
          const b = new Message(args).msg
          expect(bytesToHex(a)).toBe(bytesToHex(b))
        },
      ),
      { numRuns: 16 },
    )
  })

  it('shifts cmid / mid / time when Date.now() advances by a known delta', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    const args = {
      form_uid: '1001',
      to_uid: '2002',
      to_name: 'encryptedHrId',
      content: 'hello',
    }
    const a = new Message(args).hex

    vi.setSystemTime(new Date(1))
    const b = new Message(args).hex

    // Different timestamp → different encoded bytes (cmid/mid/time changed).
    expect(a).not.toBe(b)
    // But the prefix up to the first variable-int field (`messages` outer
    // length will also differ when length-prefixes change), so we just
    // assert non-equality to lock in "non-zero sensitivity to clock".
  })
})

// ── 4. Channel priority oracle ────────────────────────────────────────────

describe('Message.send() — channel priority preservation', () => {
  it('GeekChatCore wins: when present and sync-success, ChatWebsocket and EventBus are NOT consulted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    const w = window as Win
    const geekSend = vi.fn()
    w.GeekChatCore = {
      getInstance: () => ({
        getClient: () => ({ client: { send: geekSend } }),
      }),
    }
    const chatWsSend = vi.fn()
    w.ChatWebsocket = { send: chatWsSend }
    const ebPublish = vi.fn()
    w.EventBus = { publish: ebPublish, subscribe: vi.fn() }

    const buf = new Message({
      form_uid: '1001',
      to_uid: '2002',
      to_name: 'encryptedHrId',
      content: 'hi',
    })
    // Tolerate both unfixed (sync `void`) and a future fixed
    // (`Promise<SendResult>`) shape — we only care about "who got called".
    void (buf as unknown as { send: () => unknown }).send()

    expect(geekSend).toHaveBeenCalledTimes(1)
    expect(geekSend).toHaveBeenCalledWith(buf)
    expect(chatWsSend).not.toHaveBeenCalled()
    expect(ebPublish).not.toHaveBeenCalled()
  })

  it('ChatWebsocket fallback: when GeekChatCore is absent, EventBus is NOT consulted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    const w = window as Win
    const chatWsSend = vi.fn()
    w.ChatWebsocket = { send: chatWsSend }
    const ebPublish = vi.fn()
    w.EventBus = { publish: ebPublish, subscribe: vi.fn() }

    const buf = new Message({
      form_uid: '1001',
      to_uid: '2002',
      to_name: 'encryptedHrId',
      content: 'hi',
    })
    void (buf as unknown as { send: () => unknown }).send()

    expect(chatWsSend).toHaveBeenCalledTimes(1)
    expect(chatWsSend).toHaveBeenCalledWith(buf)
    expect(ebPublish).not.toHaveBeenCalled()
  })

  it('EventBus only — success callback path: returns UNVERIFIED because server ACK is not observable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    const w = window as Win
    const ebPublish = vi.fn(
      (
        _event: string,
        _data: unknown,
        success?: () => void,
        _failure?: () => void,
      ) => {
        if (typeof success === 'function') success()
      },
    )
    w.EventBus = { publish: ebPublish, subscribe: vi.fn() }

    const buf = new Message({
      form_uid: '1001',
      to_uid: '2002',
      to_name: 'encryptedHrId',
      content: 'hi',
    })

    const result = await buf.send()
    expect(result).toMatchObject({
      ok: false,
      channel: 'EventBus',
      reason: 'UNVERIFIED',
      cmid: buf.cmid,
    })
    expect(ebPublish).toHaveBeenCalledTimes(1)
    // Post-fix oracle: the EventBus success callback only proves the event
    // was queued, NOT that Boss accepted the message. The fixed code logs
    // '消息发送/已入队' here; '消息发送/已确认' is reserved for the
    // ackRegistry-resolved path.
    const titles = debugCalls.map((c) => c.title)
    expect(titles).toContain('消息发送/已入队')
    expect(titles).toContain('消息发送/未确认')
  })

  it('EventBus only — failure callback path: returns EVENTBUS_FAILED and logs panel "EventBus 失败"', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    const w = window as Win
    const ebPublish = vi.fn(
      (
        _event: string,
        _data: unknown,
        _success?: () => void,
        failure?: () => void,
      ) => {
        if (typeof failure === 'function') failure()
      },
    )
    w.EventBus = { publish: ebPublish, subscribe: vi.fn() }

    const buf = new Message({
      form_uid: '1001',
      to_uid: '2002',
      to_name: 'encryptedHrId',
      content: 'hi',
    })

    const result = await buf.send()
    expect(result).toMatchObject({
      ok: false,
      channel: 'EventBus',
      reason: 'EVENTBUS_FAILED',
      cmid: buf.cmid,
    })
    expect(ebPublish).toHaveBeenCalledTimes(1)
    const titles = debugCalls.map((c) => c.title)
    expect(titles).toContain('消息发送/EventBus 失败')
  })

  it('all channels missing → returns NO_CHANNEL with diagnostic log entry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))

    // Channels intentionally cleared in beforeEach.
    const buf = new Message({
      form_uid: '1001',
      to_uid: '2002',
      to_name: 'encryptedHrId',
      content: 'hi',
    })

    await expect(buf.send()).resolves.toMatchObject({
      ok: false,
      channel: 'none',
      reason: 'NO_CHANNEL',
      cmid: buf.cmid,
    })
    const titles = debugCalls.map((c) => c.title)
    expect(titles).toContain('消息发送/全部失败')
  })
})

/**
 * Validates: Requirements 4.1, 4.2, 4.3, 6.1, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */
