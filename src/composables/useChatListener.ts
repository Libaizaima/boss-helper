import { useUser } from '@/stores/user'
import { logger } from '@/utils/logger'

import { AwesomeMessage, type TechwolfChatProtocol, type TechwolfMessage } from './useWebSocket/type'

export interface BossChatEvent {
  fromUid: string
  toUid: string
  myUid: string
  text?: string
  mid?: string
  bodyType?: number
  sessionId?: string
  isFromMe: boolean
  isFromBoss: boolean
  hasResume: boolean
  hasResumeShare: boolean
  raw: unknown
}

type BossChatEventListener = (event: BossChatEvent) => void | Promise<void>

const listeners = new Set<BossChatEventListener>()
const recentEventKeys = new Map<string, number>()

let initialized = false
let legacySocketHooked = false
let nativePollTimer: ReturnType<typeof setInterval> | null = null
let nativePollAttempts = 0

const RECENT_EVENT_TTL_MS = 30_000
const NATIVE_POLL_INTERVAL_MS = 1000
const NATIVE_POLL_MAX_ATTEMPTS = 60

function cleanupRecentEventKeys(now = Date.now()) {
  for (const [key, ts] of recentEventKeys) {
    if (now - ts > RECENT_EVENT_TTL_MS) {
      recentEventKeys.delete(key)
    }
  }
}

function toStringId(value: unknown): string {
  return value == null ? '' : String(value)
}

function getMyUid(): string {
  try {
    return toStringId(useUser().getUserId())
  } catch {
    return ''
  }
}

function getMessageBody(message: any): any {
  return message?.body ?? message?.messageBody ?? message
}

function getMessageText(message: any): string | undefined {
  const body = getMessageBody(message)
  const text = body?.text ?? message?.text ?? message?.content
  return typeof text === 'string' && text.trim() ? text : undefined
}

function getBodyType(message: any): number | undefined {
  const body = getMessageBody(message)
  const type = body?.type ?? message?.bodyType ?? message?.type
  return typeof type === 'number' ? type : undefined
}

function getMessageUid(message: any, key: 'from' | 'to'): string {
  const nested = toStringId(message?.[key]?.uid ?? message?.[`${key}User`]?.uid)
  if (nested) return nested
  if (key === 'from') return toStringId(message?.fromUid ?? message?.fromId ?? message?.senderId)
  return toStringId(message?.toUid ?? message?.toId ?? message?.receiverId)
}

function hasResumePayload(message: any): boolean {
  const body = getMessageBody(message)
  return Boolean(body?.resume ?? body?.resumeAttach ?? message?.resume ?? message?.resumeAttach)
}

function hasResumeSharePayload(message: any): boolean {
  const body = getMessageBody(message)
  return Boolean(body?.resumeShare ?? message?.resumeShare)
}

function getSessionId(message: any): string | undefined {
  return (
    toStringId(
      message?.sessionId ??
        message?.conversationId ??
        message?.dialogId ??
        message?.bizId ??
        message?.jobId,
    ) || undefined
  )
}

function isProbablySystemMessage(message: any, fromUid: string, toUid: string): boolean {
  if (!fromUid || !toUid) return true
  const body = getMessageBody(message)
  const messageType = message?.messageType ?? message?.msgType ?? body?.messageType
  if (typeof messageType === 'string' && /system|notice|notify/i.test(messageType)) return true
  const role = message?.role ?? message?.fromRole ?? message?.senderRole
  if (typeof role === 'string' && /system|notice|robot/i.test(role)) return true
  return false
}

export function normalizeBossChatMessages(payload: unknown): any[] {
  if (payload == null) return []
  if (Array.isArray(payload)) return payload
  const value = payload as any
  if (Array.isArray(value.messages)) return value.messages
  if (Array.isArray(value.messageList)) return value.messageList
  if (value.message != null) return [value.message]
  if (value.from != null || value.fromUid != null || value.fromId != null) return [value]
  return []
}

export function toBossChatEvent(message: unknown, myUid = getMyUid()): BossChatEvent | null {
  const item = message as any
  const fromUid = getMessageUid(item, 'from')
  const toUid = getMessageUid(item, 'to')
  if (isProbablySystemMessage(item, fromUid, toUid)) return null

  const isFromMe = Boolean(myUid && fromUid === myUid)
  const isToMe = Boolean(myUid && toUid === myUid)
  const hasResume = hasResumePayload(item)
  const hasResumeShare = hasResumeSharePayload(item)
  const bodyType = getBodyType(item)

  return {
    fromUid,
    toUid,
    myUid,
    text: getMessageText(item),
    mid: toStringId(item?.mid ?? item?.messageId ?? item?.serverMid) || undefined,
    bodyType,
    sessionId: getSessionId(item),
    isFromMe,
    isFromBoss: !isFromMe && isToMe && (bodyType == null || bodyType > 0),
    hasResume,
    hasResumeShare,
    raw: item,
  }
}

function eventDedupKey(event: BossChatEvent): string {
  return [
    event.mid || 'no-mid',
    event.fromUid,
    event.toUid,
    event.bodyType ?? 'no-type',
    event.text ?? '',
    event.hasResume ? 'resume' : '',
    event.hasResumeShare ? 'resume-share' : '',
  ].join('|')
}

function emitBossChatEvent(event: BossChatEvent) {
  const now = Date.now()
  cleanupRecentEventKeys(now)
  const key = eventDedupKey(event)
  if (recentEventKeys.has(key)) return
  recentEventKeys.set(key, now)

  for (const listener of listeners) {
    try {
      void listener(event)
    } catch (e) {
      logger.warn('[ChatListener] listener failed', e)
    }
  }
}

export function handleBossChatPayload(payload: unknown) {
  const myUid = getMyUid()
  for (const message of normalizeBossChatMessages(payload)) {
    const event = toBossChatEvent(message, myUid)
    if (event) emitBossChatEvent(event)
  }
}

async function decodeLegacySocketPayload(data: unknown): Promise<TechwolfChatProtocol | null> {
  try {
    if (typeof data === 'string') return null
    let bytes: Uint8Array | null = null
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer())
    }
    if (!bytes) return null
    return AwesomeMessage.decode(bytes) as unknown as TechwolfChatProtocol
  } catch {
    return null
  }
}

function hookWebSocket(ws: WebSocket) {
  if ((ws as any).__bossHelperChatListenerHooked) return
  ;(ws as any).__bossHelperChatListenerHooked = true
  ws.addEventListener('message', (event) => {
    void decodeLegacySocketPayload(event.data).then((protocol) => {
      if (protocol?.messages?.length) {
        handleBossChatPayload(protocol.messages as TechwolfMessage[])
      }
    })
  })
}

function tryHookLegacyWebSocket(): boolean {
  let hooked = false
  try {
    const cws = (window as any).ChatWebsocket
    const ws = cws?.ws || cws?.socket || cws
    if (ws instanceof WebSocket) {
      hookWebSocket(ws)
      hooked = true
    }
  } catch {
    // ignore
  }

  try {
    const client = (window as any).GeekChatCore?.getInstance?.()?.getClient?.()?.client
    const ws = client?.ws || client?.socket || client
    if (ws instanceof WebSocket) {
      hookWebSocket(ws)
      hooked = true
    }
  } catch {
    // ignore
  }
  return hooked
}

function tryHookNativeEvents(): boolean {
  let hooked = false
  try {
    const chatCore = (window as any).GeekChatCore?.getInstance?.()
    if (chatCore && !(chatCore as any).__bossHelperMessageArrivedHooked) {
      if (typeof chatCore.on === 'function') {
        chatCore.on('messageArrived', handleBossChatPayload)
        hooked = true
      }
      ;(chatCore as any).__bossHelperMessageArrivedHooked = true
    }

    const broadcastManager = chatCore?.socketConnect?.broadcastManager
    if (broadcastManager && !(broadcastManager as any).__bossHelperMessageArrivedHooked) {
      if (typeof broadcastManager.addListener === 'function') {
        broadcastManager.addListener('message-arrived', handleBossChatPayload)
        hooked = true
      }
      ;(broadcastManager as any).__bossHelperMessageArrivedHooked = true
    }
  } catch {
    // ignore
  }
  return hooked
}

export function subscribeBossChatEvents(listener: BossChatEventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function initBossChatListener() {
  if (initialized) return
  initialized = true

  const hook = () => {
    const nativeHooked = tryHookNativeEvents()
    const legacyHooked = tryHookLegacyWebSocket()
    legacySocketHooked ||= legacyHooked
    if ((nativeHooked || legacySocketHooked) && nativePollTimer) {
      clearInterval(nativePollTimer)
      nativePollTimer = null
    }
  }

  hook()
  nativePollTimer = setInterval(() => {
    nativePollAttempts++
    hook()
    if (nativePollAttempts >= NATIVE_POLL_MAX_ATTEMPTS && nativePollTimer) {
      clearInterval(nativePollTimer)
      nativePollTimer = null
    }
  }, NATIVE_POLL_INTERVAL_MS)
}
