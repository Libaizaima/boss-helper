/**
 * AI 自动回复
 *
 * 原理：拦截 Boss 直聘的 WebSocket onmessage，解析收到的 Protobuf 消息，
 * 判断是否是 HR 发来的文本消息，若是则调用 LLM 生成回复并发送。
 *
 * 上下文信息：
 * - 用户简历（启动时拉取一次缓存）
 * - 与该 HR 的历史消息（最近 10 条，实现多轮对话）
 * - HR 发来的当前消息
 *
 * 防抖策略：同一个 HR（uid）在上一条回复发送完成前不会重复触发。
 */

import { useModel } from '@/composables/useModel'
import { Message } from '@/composables/useWebSocket'
import { AwesomeMessage, type TechwolfChatProtocol } from '@/composables/useWebSocket/type'
import { useConf } from '@/stores/conf'
import { useUser } from '@/stores/user'
import { logger } from '@/utils/logger'

// 正在处理中的 HR uid，防止重复触发
const pendingReplies = new Set<string>()

// 已回复过的消息 mid，防止重复回复同一条消息
const repliedMids = new Set<string>()

// 每个 HR 的历史消息（最近 N 条），用于多轮对话
const chatHistory = new Map<string, Array<{ role: 'hr' | 'me'; text: string }>>()
const MAX_HISTORY = 10

// 缓存的简历字符串，避免每次都请求
let cachedResume: string | null = null

let hooked = false

/**
 * 获取简历字符串，带缓存
 */
async function getResume(): Promise<string> {
  if (cachedResume != null) return cachedResume
  try {
    const user = useUser()
    cachedResume = await user.getUserResumeString({})
    logger.info('[AiReply] 简历加载成功')
  } catch (e) {
    logger.warn('[AiReply] 简历加载失败，将不携带简历信息', e)
    cachedResume = ''
  }
  return cachedResume
}

/**
 * 追加历史消息
 */
function appendHistory(uid: string, role: 'hr' | 'me', text: string) {
  if (!chatHistory.has(uid)) {
    chatHistory.set(uid, [])
  }
  const history = chatHistory.get(uid)!
  history.push({ role, text })
  // 只保留最近 N 条
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY)
  }
}

/**
 * 把历史消息格式化为字符串，传给 LLM
 */
function formatHistory(uid: string): string {
  const history = chatHistory.get(uid)
  if (!history || history.length === 0) return ''
  return history.map((m) => `${m.role === 'hr' ? 'HR' : '我'}: ${m.text}`).join('\n')
}

/**
 * 解析 WebSocket 收到的二进制数据
 */
function decodeMessage(data: ArrayBuffer | Blob | string) {
  try {
    if (typeof data === 'string') return null
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : null
    if (!buf) return null
    const protocol = AwesomeMessage.decode(buf) as unknown as TechwolfChatProtocol
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
    if (msg.body?.type !== 1) continue
    const text = msg.body?.text
    if (!text) continue

    const fromUid = String(msg.from?.uid ?? '')
    const toUid = String(msg.to?.uid ?? '')
    const mid = String(msg.mid ?? '')

    // 记录自己发出的消息到历史（用于多轮对话上下文）
    if (fromUid === myUid) {
      appendHistory(toUid, 'me', text)
      continue
    }

    // 只处理发给自己的消息
    if (toUid !== myUid) continue
    if (mid && repliedMids.has(mid)) continue
    if (pendingReplies.has(fromUid)) continue

    // 记录 HR 消息到历史
    appendHistory(fromUid, 'hr', text)

    logger.info('[AiReply] 收到 HR 消息', { fromUid, text })

    pendingReplies.add(fromUid)
    if (mid) repliedMids.add(mid)
    if (repliedMids.size > 500) {
      const first = repliedMids.values().next().value
      if (first) repliedMids.delete(first)
    }

    try {
      await replyToMessage({ fromUid, myUid, text })
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
  myUid,
  text,
}: {
  fromUid: string
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

  // 收集上下文
  const resume = await getResume()
  const history = formatHistory(fromUid)

  let replyContent: string | undefined
  try {
    const { content } = await gpt.message(
      {
        data: {
          data: {
            message: text, // 当前 HR 消息，模板里用 {{ data.message }}
            history, // 历史对话，模板里用 {{ data.history }}
            resume, // 我的简历，模板里用 {{ data.resume }}
          },
        },
      } as any,
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

  // 随机延迟 30-120 秒，模拟人工回复节奏
  const delayMs = (30 + Math.random() * 90) * 1000
  logger.info(`[AiReply] 等待 ${Math.round(delayMs / 1000)}s 后发送回复`)
  await new Promise((resolve) => setTimeout(resolve, delayMs))

  logger.info('[AiReply] 发送回复', { to: fromUid, content: replyContent })

  // 记录自己的回复到历史
  appendHistory(fromUid, 'me', replyContent)

  const buf = new Message({
    form_uid: myUid,
    to_uid: fromUid,
    to_name: fromUid,
    content: replyContent,
  })
  void buf.send()
}

/**
 * 等待 WebSocket 对象出现并 hook
 */
function waitAndHookWebSocket() {
  if (hooked) return
  let attempts = 0
  const maxAttempts = 60

  const timer = setInterval(() => {
    attempts++
    if (attempts > maxAttempts) {
      clearInterval(timer)
      logger.warn('[AiReply] 等待 WebSocket 超时，AI 回复功能未启动')
      return
    }

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
        // 还没初始化，继续等
      }
    }
  }, 1000)
}

/**
 * 初始化 AI 回复功能
 */
export function initAiReply() {
  // 提前预热简历缓存
  setTimeout(() => {
    getResume().catch(() => {})
  }, 3000)

  waitAndHookWebSocket()
}
