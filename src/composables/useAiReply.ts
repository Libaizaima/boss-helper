/**
 * AI 自动回复
 *
 * 原理：拦截 Boss 直聘的 WebSocket onmessage，解析收到的 Protobuf 消息，
 * 判断是否是 HR 发来的文本消息，若是则调用 LLM 生成回复并发送。
 *
 * 防抖策略：同一个 HR（uid）在上一条回复发送完成前不会重复触发，
 * 避免 HR 连续发多条消息时重复回复。
 */

import { useModel } from '@/composables/useModel'
import { Message } from '@/composables/useWebSocket'
import { AwesomeMessage } from '@/composables/useWebSocket/type'
import { useConf } from '@/stores/conf'
import { useUser } from '@/stores/user'
import { logger } from '@/utils/logger'

// 正在处理中的 HR uid，防止重复触发
const pendingReplies = new Set<string>()

// 已回复过的消息 mid，防止重复回复同一条消息
const repliedMids = new Set<string>()

let hooked = false

/**
 * 解析 WebSocket 收到的二进制数据，返回消息列表
 */
function decodeMessage(data: ArrayBuffer | Blob | string) {
  try {
    if (typeof data === 'string') return null
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : null
    if (!buf) return null
    const protocol = AwesomeMessage.decode(buf)
    return protocol
  } catch {
    return null
  }
}

/**
 * 拦截 WebSocket 实例的 onmessage，注入 AI 回复逻辑
 */
function hookWebSocket(ws: WebSocket) {
  const originalOnMessage = ws.onmessage?.bind(ws)

  ws.addEventListener('message', async (event: MessageEvent) => {
    try {
      await handleIncomingMessage(event.data)
    } catch (e) {
      logger.error('[AiReply] 处理消息异常', e)
    }
  })

  // 保留原有 onmessage
  if (originalOnMessage) {
    ws.onmessage = originalOnMessage
  }
}

/**
 * 处理收到的一条 WebSocket 消息
 */
async function handleIncomingMessage(data: any) {
  const conf = useConf()
  if (!conf.formData.aiReply.enable) return
  if (!conf.formData.aiReply.prompt) return

  const protocol = decodeMessage(data)
  if (!protocol || !Array.isArray(protocol.messages)) return

  const myUid = String(useUser().getUserId() ?? '')

  for (const msg of protocol.messages) {
    // 只处理文本消息（body.type === 1）
    if (msg.body?.type !== 1) continue
    const text = msg.body?.text
    if (!text) continue

    const fromUid = String(msg.from?.uid ?? '')
    const toUid = String(msg.to?.uid ?? '')
    const toName = String(msg.to?.name ?? '')
    const mid = String(msg.mid ?? '')

    // 只处理发给自己的消息（HR → 我）
    if (toUid !== myUid) continue
    // 不回复自己发的消息
    if (fromUid === myUid) continue
    // 不重复回复同一条消息
    if (mid && repliedMids.has(mid)) continue
    // 同一个 HR 正在处理中，跳过
    if (pendingReplies.has(fromUid)) continue

    logger.info('[AiReply] 收到 HR 消息', { fromUid, text })

    pendingReplies.add(fromUid)
    if (mid) repliedMids.add(mid)
    // 防止 repliedMids 无限增长
    if (repliedMids.size > 500) {
      const first = repliedMids.values().next().value
      if (first) repliedMids.delete(first)
    }

    try {
      await replyToMessage({ fromUid, toName: fromUid, myUid, text })
    } finally {
      pendingReplies.delete(fromUid)
    }
  }
}

/**
 * 调用 LLM 生成回复并发送
 */
async function replyToMessage({
  fromUid,
  toName,
  myUid,
  text,
}: {
  fromUid: string
  toName: string
  myUid: string
  text: string
}) {
  const conf = useConf()
  const model = useModel()

  const curModel = model.modelData.find((v) => conf.formData.aiReply.model === v.key)
  if (!curModel) {
    logger.warn('[AiReply] 未配置 AI 回复模型')
    return
  }

  const gpt = model.getModel(curModel, conf.formData.aiReply.prompt)

  let replyContent: string | undefined
  try {
    const { content } = await gpt.message(
      {
        // 把 HR 消息作为 data 传入，模板里可以用 {{ message }} 引用
        data: { data: { message: text } as any },
      },
      'aiReply',
    )
    replyContent = content
  } catch (e: any) {
    logger.error('[AiReply] LLM 调用失败', e.message)
    return
  }

  if (!replyContent?.trim()) {
    logger.warn('[AiReply] LLM 返回空内容，跳过发送')
    return
  }

  logger.info('[AiReply] 发送回复', { to: fromUid, content: replyContent })

  const buf = new Message({
    form_uid: myUid,
    to_uid: fromUid,
    to_name: toName,
    content: replyContent,
  })
  buf.send()
}

/**
 * 等待 WebSocket 对象出现并 hook
 * Boss 直聘有两种 WebSocket 入口：ChatWebsocket 和 GeekChatCore
 */
function waitAndHookWebSocket() {
  if (hooked) return
  let attempts = 0
  const maxAttempts = 60 // 最多等 60s

  const timer = setInterval(() => {
    attempts++
    if (attempts > maxAttempts) {
      clearInterval(timer)
      logger.warn('[AiReply] 等待 WebSocket 超时，AI 回复功能未启动')
      return
    }

    // 尝试 ChatWebsocket
    if ('ChatWebsocket' in window && window.ChatWebsocket != null) {
      const ws = (window.ChatWebsocket as any)?.ws || (window.ChatWebsocket as any)?.socket
      if (ws instanceof WebSocket && ws.readyState === WebSocket.OPEN) {
        hookWebSocket(ws)
        hooked = true
        clearInterval(timer)
        logger.info('[AiReply] 已 hook ChatWebsocket')
        return
      }
    }

    // 尝试 GeekChatCore
    if ('GeekChatCore' in window && window.GeekChatCore != null) {
      try {
        const client = (window.GeekChatCore as any).getInstance?.()?.getClient?.()?.client
        const ws = client?.ws || client?.socket || client
        if (ws instanceof WebSocket && ws.readyState === WebSocket.OPEN) {
          hookWebSocket(ws)
          hooked = true
          clearInterval(timer)
          logger.info('[AiReply] 已 hook GeekChatCore WebSocket')
          return
        }
      } catch {
        // GeekChatCore 还没初始化，继续等
      }
    }
  }, 1000)
}

/**
 * 初始化 AI 回复功能，在 main-world 启动时调用一次
 */
export function initAiReply() {
  waitAndHookWebSocket()
}
