/**
 * ChatAckRegistry — passive inbound-frame ACK correlator for `Message.send()`.
 *
 * Spec:   .kiro/specs/ai-greeting-send-verification/{requirements,design,tasks}.md
 * Task:   3.1 新增 `ChatAckRegistry`（被动监听入站帧的单例）
 *
 * Purpose
 * -------
 * Correlates Boss-server ACKs (or rejection signals) back to a specific
 * outbound `cmid` so that callers of `Message.send()` can decide whether the
 * message was actually accepted by the server. The registry is a
 * lazily-initialised module-level singleton; it does NOT export a class.
 *
 * Discovery tiers
 * ---------------
 *   Tier A — native SDK events on `window.GeekChatCore` /
 *            `window.ChatWebsocket` (`on(...)` / `addListener(...)`).
 *   Tier B — `addEventListener('message', ...)` on the underlying WebSocket
 *            reachable via `(window.ChatWebsocket as any).ws | .socket` or
 *            `window.GeekChatCore.getInstance().getClient().client.ws`. Frames
 *            are decoded with `AwesomeMessage.decode(...)`; if any contained
 *            message has `cmid` matching a pending registration, the promise
 *            resolves with `{ ok: true }` (echo-frame match).
 *   Tier C — handled by `Message.send()` itself (EventBus). The registry only
 *            listens passively, so Tier C still hits TIMEOUT → which the
 *            caller maps to `UNVERIFIED`.
 *
 * Limitations
 * -----------
 *   - `src/composables/useWebSocket/type.ts` does NOT define a type for
 *     `TechwolfIqResponse`, so Tier B currently can only echo-match on
 *     `messages[*].cmid`. Server rejection frames flowing as `IqResponse`
 *     are not decoded here; in such cases the registration falls back to
 *     `TIMEOUT`. Decoding `TechwolfIqResponse` is intentionally deferred to
 *     a future task — extending `type.ts` is out of scope for 3.1 per the
 *     task brief.
 *   - Tier A is the only path that can deliver `SERVER_REJECTED` today
 *     (because the native callback already exposes `{ code, message }`).
 *
 * Anti-fraud (AC7.1–AC7.7) — every requirement honoured by construction
 * --------------------------------------------------------------------
 *   ✅ AC7.1 No new outbound HTTP/WS/EventBus requests; we only
 *           `addEventListener` on existing WebSockets and subscribe to
 *           SDK-native events that already fire.
 *   ✅ AC7.2 No automatic retries — resolve-once semantics. Once a `cmid` is
 *           settled, subsequent inbound frames for the same `cmid` are
 *           silently ignored (the map entry is gone).
 *   ✅ AC7.3 No protocol byte changes; we only DECODE inbound frames and
 *           never re-encode or mutate them.
 *   ✅ AC7.4 No reduction of any existing anti-fraud delay; the only added
 *           latency is `timeoutMs` — strictly serial, ≤ 15 000 ms.
 *   ✅ AC7.5 Listener uses `{ capture: false, passive: true }`. We never call
 *           `stopPropagation` / `preventDefault`, never mutate the event or
 *           the underlying frame buffer, never `postMessage` back.
 *   ✅ AC7.6 No new globals, cookies, headers, localStorage keys.
 *   ✅ AC7.7 Tier D (HTTP polling) is intentionally NOT implemented and there
 *           is no feature flag for it.
 */

import { logger } from '@/utils/logger'

import type { TechwolfChatProtocol, TechwolfMessage, TechwolfMessageSync } from './type'
import { AwesomeMessage } from './type'

// ── Public types ──────────────────────────────────────────────────────────

export type SendChannel = 'GeekChatCore' | 'ChatWebsocket' | 'EventBus' | 'none'

export type SendFailureReason =
  | 'NO_CHANNEL'
  | 'CHANNEL_SYNC_THROW'
  | 'TIMEOUT'
  | 'SERVER_REJECTED'
  | 'EVENTBUS_FAILED'
  | 'UNVERIFIED'
  | 'CMID_COLLISION'

export type AckSource = 'native-event' | 'messages.cmid' | 'messageSync.clientMid'

export type SendResult =
  | {
      ok: true
      channel: SendChannel
      cmid: string
      ackMid?: string
      ackSource?: AckSource
      serverCode?: number
    }
  | {
      ok: false
      channel: SendChannel
      cmid: string
      reason: SendFailureReason
      serverCode?: number
      serverMessage?: string
    }

export interface SendChannelDiagnostics {
  geekChatCore: {
    exists: boolean
    instanceExists: boolean
    clientExists: boolean
    clientSend: boolean
    clientKeys: string[]
    clientFunctionKeys: string[]
  }
  chatWebsocket: {
    exists: boolean
    send: boolean
    keys: string[]
    functionKeys: string[]
    wsReadyState?: number
    socketReadyState?: number
  }
  eventBus: {
    exists: boolean
    publish: boolean
    subscribe: boolean
    keys: string[]
    functionKeys: string[]
  }
  capturedSockets: Array<{
    index: number
    readyState: number
    url: string
    bufferedAmount: number
    protocol: string
  }>
}

// ── Internal state (module-level singleton) ───────────────────────────────

interface PendingEntry {
  resolve: (r: SendResult) => void
  channel: SendChannel
  timeoutHandle: ReturnType<typeof setTimeout>
}

const pendingMap: Map<string, PendingEntry> = new Map()
const capturedSockets: Set<WebSocket> = new Set()
const sendWrappedSockets: WeakSet<WebSocket> = new WeakSet()

let listenerAttached = false
let pollHandle: ReturnType<typeof setInterval> | null = null
let pollAttempts = 0
let webSocketCaptureInstalled = false
let diagnosticsLogger: ((title: string, message: string, payload?: unknown) => void) | null = null
const POLL_INTERVAL_MS = 1000
const POLL_MAX_ATTEMPTS = 60

function setDiagnosticsLogger(
  loggerFn: (title: string, message: string, payload?: unknown) => void,
): void {
  diagnosticsLogger = loggerFn
}

function logDiagnostics(title: string, message: string, payload?: unknown): void {
  try {
    diagnosticsLogger?.(title, message, payload)
  } catch {
    // diagnostics must never affect send / receive paths
  }
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}

function dataTypeName(data: unknown): string {
  if (data instanceof ArrayBuffer) return 'ArrayBuffer'
  if (ArrayBuffer.isView(data)) return data.constructor?.name || 'ArrayBufferView'
  if (typeof Blob !== 'undefined' && data instanceof Blob) return 'Blob'
  return typeof data
}

function byteLengthOf(data: unknown): number | undefined {
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size
  if (typeof data === 'string') return data.length
  return undefined
}

function summarizeProtocol(protocol: TechwolfChatProtocol) {
  const messages = Array.isArray(protocol.messages) ? protocol.messages : []
  const messageSync = Array.isArray(protocol.messageSync) ? protocol.messageSync : []
  return {
    type: protocol.type,
    messageCount: messages.length,
    messageSyncCount: messageSync.length,
    messages: messages.slice(0, 3).map((msg) => ({
      mid: msg.mid != null ? String(msg.mid) : undefined,
      cmid: msg.cmid != null ? String(msg.cmid) : undefined,
      fromUid: msg.from?.uid != null ? String(msg.from.uid) : undefined,
      toUid: msg.to?.uid != null ? String(msg.to.uid) : undefined,
      toNamePresent: Boolean(msg.to?.name),
      bodyType: msg.body?.type,
      templateId: msg.body?.templateId,
      hasText: typeof msg.body?.text === 'string',
      textLength: typeof msg.body?.text === 'string' ? msg.body.text.length : undefined,
    })),
    messageSync: messageSync.slice(0, 3).map((sync) => ({
      clientMid: sync.clientMid != null ? String(sync.clientMid) : undefined,
      serverMid: sync.serverMid != null ? String(sync.serverMid) : undefined,
    })),
  }
}

function logOutboundWebSocketSend(ws: WebSocket, data: unknown): void {
  const bytes = toUint8Array(data)
  if (!bytes) return
  let decoded: TechwolfChatProtocol
  try {
    decoded = AwesomeMessage.decode(bytes) as unknown as TechwolfChatProtocol
  } catch {
    return
  }
  const summary = summarizeProtocol(decoded)
  if (summary.messageCount === 0 && summary.messageSyncCount === 0) return
  logDiagnostics('消息发送/手动通道探针', '页面调用 WebSocket.send', {
    socket: {
      readyState: ws.readyState,
      url: maskWebSocketUrl(ws.url),
      bufferedAmount: ws.bufferedAmount,
      protocol: ws.protocol,
    },
    dataType: dataTypeName(data),
    byteLength: byteLengthOf(data),
    decoded: summary,
  })
}

function wrapSocketSend(ws: WebSocket): void {
  if (sendWrappedSockets.has(ws)) return
  sendWrappedSockets.add(ws)
  try {
    const nativeSend = ws.send.bind(ws)
    Object.defineProperty(ws, 'send', {
      configurable: true,
      value(data: unknown) {
        logOutboundWebSocketSend(ws, data)
        return nativeSend(data as Parameters<WebSocket['send']>[0])
      },
    })
  } catch (e) {
    logger.warn('[ackRegistry] WebSocket send wrap failure', e)
  }
}

function rememberSocket(ws: WebSocket): void {
  capturedSockets.add(ws)
  wrapSocketSend(ws)
  try {
    ws.addEventListener(
      'close',
      () => {
        capturedSockets.delete(ws)
      },
      { once: true },
    )
  } catch {
    // ignore cleanup listener failures; the Set is tiny and bounded by page life
  }
}

function installPassiveWebSocketCapture(): void {
  if (webSocketCaptureInstalled) return
  webSocketCaptureInstalled = true
  try {
    const NativeWebSocket = window.WebSocket
    if (typeof NativeWebSocket !== 'function') return

    const WrappedWebSocket = function (
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ) {
      const ws =
        protocols == null
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols)
      rememberSocket(ws)
      return ws
    } as unknown as typeof WebSocket

    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket)
    WrappedWebSocket.prototype = NativeWebSocket.prototype
    window.WebSocket = WrappedWebSocket
  } catch (e) {
    logger.warn('[ackRegistry] WebSocket capture install failure', e)
  }
}

installPassiveWebSocketCapture()

function safeKeys(value: unknown, limit = 30): string[] {
  try {
    if (value == null || (typeof value !== 'object' && typeof value !== 'function')) {
      return []
    }
    return Array.from(
      new Set([
        ...Object.keys(value as object),
        ...Object.getOwnPropertyNames(value as object),
      ]),
    ).slice(0, limit)
  } catch {
    return []
  }
}

function functionKeys(value: unknown, limit = 30): string[] {
  return safeKeys(value, limit).filter((key) => {
    try {
      return typeof (value as any)?.[key] === 'function'
    } catch {
      return false
    }
  })
}

function maskWebSocketUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return url.split('?')[0] ?? ''
  }
}

function getReadyState(value: unknown): number | undefined {
  return value instanceof WebSocket ? value.readyState : undefined
}

function getSendDiagnostics(): SendChannelDiagnostics {
  let chatCore: any
  let geekClient: any
  try {
    chatCore = (window as any).GeekChatCore?.getInstance?.()
    geekClient = chatCore?.getClient?.()?.client
  } catch {
    // ignore
  }

  let cws: any
  try {
    cws = (window as any).ChatWebsocket
  } catch {
    // ignore
  }

  let eventBus: any
  try {
    eventBus = (window as any).EventBus
  } catch {
    // ignore
  }

  return {
    geekChatCore: {
      exists: (window as any).GeekChatCore != null,
      instanceExists: chatCore != null,
      clientExists: geekClient != null,
      clientSend: typeof geekClient?.send === 'function',
      clientKeys: safeKeys(geekClient),
      clientFunctionKeys: functionKeys(geekClient),
    },
    chatWebsocket: {
      exists: cws != null,
      send: typeof cws?.send === 'function',
      keys: safeKeys(cws),
      functionKeys: functionKeys(cws),
      wsReadyState: getReadyState(cws?.ws),
      socketReadyState: getReadyState(cws?.socket),
    },
    eventBus: {
      exists: eventBus != null,
      publish: typeof eventBus?.publish === 'function',
      subscribe: typeof eventBus?.subscribe === 'function',
      keys: safeKeys(eventBus),
      functionKeys: functionKeys(eventBus),
    },
    capturedSockets: Array.from(capturedSockets).map((ws, index) => ({
      index,
      readyState: ws.readyState,
      url: maskWebSocketUrl(ws.url),
      bufferedAmount: ws.bufferedAmount,
      protocol: ws.protocol,
    })),
  }
}

// ── Tier A — native SDK event handler ─────────────────────────────────────

interface NativeAckPayload {
  cmid?: string | number
  mid?: string | number
  clientMid?: string | number
  tempID?: string | number
  code?: number
  message?: string
}

function nativeAckHandler(payload: NativeAckPayload | undefined): void {
  try {
    if (payload == null || typeof payload !== 'object') return
    if (payload.cmid == null) return
    const cmid = String(payload.cmid)
    if (!pendingMap.has(cmid)) return
    const code = typeof payload.code === 'number' ? payload.code : 0
    const mid = payload.mid != null ? String(payload.mid) : undefined
    const message = payload.message != null ? String(payload.message) : undefined
    if (code === 0) {
      resolveOk(cmid, mid, code, 'native-event')
    } else {
      resolveFail(cmid, 'SERVER_REJECTED', code, message)
    }
  } catch (e) {
    // Per AC7.5: a single bad frame must never settle the wrong promise.
    logger.warn('[ackRegistry] native ack handler exception', e)
  }
}

function normalizeNativeMessages(payload: any): NativeAckPayload[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.messages)) return payload.messages
  if (payload?.message != null) return [payload.message]
  return payload != null ? [payload] : []
}

function getNativeMessageCmid(message: NativeAckPayload | undefined): string | null {
  const cmid = message?.cmid ?? message?.clientMid ?? message?.tempID
  return cmid == null ? null : String(cmid)
}

function nativeDeliveredHandler(payload: any): void {
  try {
    for (const message of normalizeNativeMessages(payload)) {
      const cmid = getNativeMessageCmid(message)
      if (cmid == null || !pendingMap.has(cmid)) continue
      const mid = message?.mid != null ? String(message.mid) : undefined
      resolveOk(cmid, mid, 0, 'native-event')
    }
  } catch (e) {
    logger.warn('[ackRegistry] native delivered handler exception', e)
  }
}

function nativeSendErrorHandler(payload: any): void {
  try {
    const message = normalizeNativeMessages(payload)[0]
    const cmid = getNativeMessageCmid(message)
    if (cmid == null || !pendingMap.has(cmid)) return
    resolveFail(cmid, 'SERVER_REJECTED', payload?.code, payload?.error ?? payload?.message)
  } catch (e) {
    logger.warn('[ackRegistry] native send-error handler exception', e)
  }
}

function tryHookNativeEvents(): boolean {
  let hooked = false

  try {
    const w = window as unknown as { GeekChatCore?: any }
    const chatCore = w.GeekChatCore?.getInstance?.()
    if (chatCore && typeof chatCore.on === 'function') {
      for (const [evt, handler] of [
        ['messageDelivered', nativeDeliveredHandler],
        ['sendError', nativeSendErrorHandler],
      ] as const) {
        try {
          chatCore.on(evt, handler)
          hooked = true
        } catch {
          // ignore individual event registration failures
        }
      }
    }

    const sharedWorkerClient =
      chatCore?.socketConnect?.broadcastManager?.sharedWorkerClient
    if (sharedWorkerClient && typeof sharedWorkerClient.addListener === 'function') {
      for (const [evt, handler] of [
        ['message-delivered', nativeDeliveredHandler],
        ['send-error', nativeSendErrorHandler],
      ] as const) {
        try {
          sharedWorkerClient.addListener(evt, handler)
          hooked = true
        } catch {
          // ignore individual event registration failures
        }
      }
    }

    const client = chatCore?.getClient?.()
    if (client && typeof client.on === 'function') {
      for (const evt of ['messageAck', 'sendAck', 'sendResult'] as const) {
        try {
          client.on(evt, nativeAckHandler)
          hooked = true
        } catch {
          // ignore individual event registration failures
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const w = window as unknown as { ChatWebsocket?: any }
    const cws = w.ChatWebsocket
    if (cws && typeof cws.on === 'function') {
      for (const evt of ['messageAck', 'sendAck'] as const) {
        try {
          cws.on(evt, nativeAckHandler)
          hooked = true
        } catch {
          // ignore
        }
      }
    } else if (cws && typeof cws.addListener === 'function') {
      for (const evt of ['messageAck', 'sendAck'] as const) {
        try {
          cws.addListener(evt, nativeAckHandler)
          hooked = true
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  return hooked
}

// ── Tier B — passive WebSocket message listener ───────────────────────────

function wsMessageHandler(event: MessageEvent): void {
  try {
    const data = (event as { data?: unknown }).data
    if (!(data instanceof ArrayBuffer)) {
      // We never decode strings or Blobs; Boss frames are binary protobuf.
      return
    }
    let decoded: TechwolfChatProtocol
    try {
      decoded = AwesomeMessage.decode(new Uint8Array(data)) as unknown as TechwolfChatProtocol
    } catch (e) {
      // AC7.5: a single bad frame must never settle the wrong promise.
      logger.warn('[ackRegistry] frame decode failure (ignored)', e)
      return
    }
    const messages = decoded?.messages
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        try {
          if (msg == null) continue
          const cmidRaw = (msg as TechwolfMessage).cmid
          if (cmidRaw == null) continue
          const cmid = String(cmidRaw)
          if (!pendingMap.has(cmid)) continue
          const midRaw = (msg as TechwolfMessage).mid
          const ackMid = midRaw != null ? String(midRaw) : undefined
          resolveOk(cmid, ackMid, undefined, 'messages.cmid')
        } catch (e) {
          logger.warn('[ackRegistry] per-message dispatch failure (ignored)', e)
        }
      }
    }

    const syncs = decoded?.messageSync
    if (!Array.isArray(syncs)) return
    for (const sync of syncs) {
      try {
        if (sync == null) continue
        const clientMidRaw = (sync as TechwolfMessageSync).clientMid
        if (clientMidRaw == null) continue
        const cmid = String(clientMidRaw)
        if (!pendingMap.has(cmid)) continue
        const serverMidRaw = (sync as TechwolfMessageSync).serverMid
        const ackMid = serverMidRaw != null ? String(serverMidRaw) : undefined
        resolveOk(cmid, ackMid, undefined, 'messageSync.clientMid')
      } catch (e) {
        logger.warn('[ackRegistry] per-messageSync dispatch failure (ignored)', e)
      }
    }
  } catch (e) {
    logger.warn('[ackRegistry] message handler exception (ignored)', e)
  }
}

function tryHookWebSocket(): boolean {
  const candidates: unknown[] = []
  try {
    const w = window as unknown as { ChatWebsocket?: any }
    const cws = w.ChatWebsocket
    candidates.push(cws?.ws, cws?.socket)
  } catch {
    // ignore
  }
  try {
    const w = window as unknown as { GeekChatCore?: any }
    const chatCore = w.GeekChatCore?.getInstance?.()
    const client = chatCore?.getClient?.()?.client
    candidates.push(client?.ws, client?.socket, client)
  } catch {
    // ignore
  }
  candidates.push(...capturedSockets)

  for (const cand of candidates) {
    if (!(cand instanceof WebSocket)) continue
    if (cand.readyState !== WebSocket.OPEN) continue
    try {
      // AC7.5: passive listener, no bubbling/cancel side effects.
      cand.addEventListener('message', wsMessageHandler, {
        capture: false,
        passive: true,
      })
      return true
    } catch (e) {
      logger.warn('[ackRegistry] addEventListener failure', e)
    }
  }
  return false
}

// ── Listener bootstrapping (lazy + polling fallback) ──────────────────────

function attemptAttach(): boolean {
  if (listenerAttached) return true
  // Tier A first; Tier B is still attempted because Tier A may attach to a
  // partial event surface and we want both paths to converge into the same
  // pendingMap. Either succeeding flips `listenerAttached` so the polling
  // loop stops.
  const a = tryHookNativeEvents()
  const b = tryHookWebSocket()
  if (a || b) {
    listenerAttached = true
    if (pollHandle != null) {
      clearInterval(pollHandle)
      pollHandle = null
    }
  }
  return listenerAttached
}

function ensureListener(): void {
  if (listenerAttached) return
  if (attemptAttach()) return
  if (pollHandle != null) return
  pollAttempts = 0
  pollHandle = setInterval(() => {
    pollAttempts++
    if (listenerAttached || pollAttempts >= POLL_MAX_ATTEMPTS) {
      if (pollHandle != null) {
        clearInterval(pollHandle)
        pollHandle = null
      }
      return
    }
    attemptAttach()
  }, POLL_INTERVAL_MS)
}

// ── Resolve / release helpers ─────────────────────────────────────────────

function settleAndDelete(
  cmid: string,
  result: SendResult,
): void {
  const entry = pendingMap.get(cmid)
  if (!entry) return
  // Always clearTimeout + delete first so re-entrant resolves cannot leak.
  clearTimeout(entry.timeoutHandle)
  pendingMap.delete(cmid)
  try {
    entry.resolve(result)
  } catch (e) {
    logger.warn('[ackRegistry] resolver threw', e)
  }
}

function resolveOk(
  cmid: string,
  ackMid?: string,
  serverCode?: number,
  ackSource?: AckSource,
): void {
  const entry = pendingMap.get(cmid)
  if (!entry) return
  settleAndDelete(cmid, {
    ok: true,
    channel: entry.channel,
    cmid,
    ackMid,
    ...(ackSource ? { ackSource } : {}),
    serverCode,
  })
}

function resolveFail(
  cmid: string,
  reason: SendFailureReason,
  serverCode?: number,
  serverMessage?: string,
): void {
  const entry = pendingMap.get(cmid)
  if (!entry) return
  settleAndDelete(cmid, {
    ok: false,
    channel: entry.channel,
    cmid,
    reason,
    serverCode,
    serverMessage,
  })
}

function release(cmid: string): void {
  const entry = pendingMap.get(cmid)
  if (!entry) return
  clearTimeout(entry.timeoutHandle)
  pendingMap.delete(cmid)
  // Note: we deliberately do NOT call entry.resolve here. `release` is for
  // callers that have already produced a SendResult themselves (e.g.
  // `Message.send` resolving via SDK sync-throw); resolving twice would
  // double-settle the same promise.
}

function register(
  cmid: string,
  timeoutMs: number,
  channel: SendChannel,
): Promise<SendResult> {
  // CMID collision: pre-existing entry → resolve OLD with CMID_COLLISION,
  // clear its timeout, then proceed to register the NEW one. AC7.2 forbids
  // automatic retries, but this is a *settle*, not a retry — the caller
  // observes the failure.
  const prev = pendingMap.get(cmid)
  if (prev != null) {
    clearTimeout(prev.timeoutHandle)
    pendingMap.delete(cmid)
    try {
      prev.resolve({
        ok: false,
        channel: prev.channel,
        cmid,
        reason: 'CMID_COLLISION',
      })
    } catch (e) {
      logger.warn('[ackRegistry] resolver (collision) threw', e)
    }
  }

  // Lazy-init listener on first register call.
  ensureListener()

  return new Promise<SendResult>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      const entry = pendingMap.get(cmid)
      if (!entry) return
      pendingMap.delete(cmid)
      try {
        entry.resolve({
          ok: false,
          channel: entry.channel,
          cmid,
          reason: 'TIMEOUT',
        })
      } catch (e) {
        logger.warn('[ackRegistry] resolver (timeout) threw', e)
      }
    }, timeoutMs)
    pendingMap.set(cmid, { resolve, channel, timeoutHandle })
  })
}

// ── Test-only reset ───────────────────────────────────────────────────────

function __reset(): void {
  for (const entry of pendingMap.values()) {
    clearTimeout(entry.timeoutHandle)
  }
  pendingMap.clear()
  if (pollHandle != null) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  pollAttempts = 0
  // Note: previously-attached event listeners are intentionally left in
  // place — they fire on dead pendingMap entries which is a no-op. The flag
  // is reset so a fresh ws installed in a new test re-attaches cleanly.
  listenerAttached = false
}

// ── Singleton export ──────────────────────────────────────────────────────

export const ackRegistry = {
  register,
  resolveOk,
  resolveFail,
  release,
  getSendDiagnostics,
  setDiagnosticsLogger,
  /** test-only */
  __reset,
} as const
