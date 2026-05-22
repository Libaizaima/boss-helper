import { useModel } from '@/composables/useModel'
import { Message } from '@/composables/useWebSocket'
import { useConf } from '@/stores/conf'
import { useUser } from '@/stores/user'
import { logger } from '@/utils/logger'

import {
  type BossChatEvent,
  initBossChatListener,
  subscribeBossChatEvents,
} from './useChatListener'

const pendingReplies = new Set<string>()
const repliedMids = new Set<string>()
const chatHistory = new Map<string, Array<{ role: 'hr' | 'me'; text: string }>>()
const MAX_HISTORY = 10

let cachedResume: string | null = null
let unsubscribeChatListener: (() => void) | null = null

async function getResume(): Promise<string> {
  if (cachedResume != null) return cachedResume
  try {
    const user = useUser()
    cachedResume = await user.getUserResumeString({})
    logger.debug('[AiReply] resume loaded')
  } catch (e) {
    logger.debug('[AiReply] resume unavailable, continue without resume', e)
    cachedResume = ''
  }
  return cachedResume
}

function appendHistory(uid: string, role: 'hr' | 'me', text: string) {
  if (!chatHistory.has(uid)) {
    chatHistory.set(uid, [])
  }
  const history = chatHistory.get(uid)!
  history.push({ role, text })
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY)
  }
}

function formatHistory(uid: string): string {
  const history = chatHistory.get(uid)
  if (!history || history.length === 0) return ''
  return history.map((m) => `${m.role === 'hr' ? 'HR' : '我'}: ${m.text}`).join('\n')
}

async function handleIncomingMessage(event: BossChatEvent) {
  const conf = useConf()
  if (!conf.formData.aiReply.enable) return
  if (!conf.formData.aiReply.prompt) return
  if (!event.text || event.bodyType !== 1) return

  const myUid = String(useUser().getUserId() ?? '')

  if (event.isFromMe) {
    appendHistory(event.toUid, 'me', event.text)
    return
  }

  if (!event.isFromBoss || event.toUid !== myUid) return
  if (event.mid && repliedMids.has(event.mid)) return
  if (pendingReplies.has(event.fromUid)) return

  appendHistory(event.fromUid, 'hr', event.text)
  logger.info('[AiReply] 收到 HR 消息', { fromUid: event.fromUid, text: event.text })

  pendingReplies.add(event.fromUid)
  if (event.mid) repliedMids.add(event.mid)
  if (repliedMids.size > 500) {
    const first = repliedMids.values().next().value
    if (first) repliedMids.delete(first)
  }

  try {
    await replyToMessage({ fromUid: event.fromUid, myUid, text: event.text })
  } finally {
    pendingReplies.delete(event.fromUid)
  }
}

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
  const resume = await getResume()
  const history = formatHistory(fromUid)

  let replyContent: string | undefined
  try {
    const { content } = await gpt.message(
      {
        data: {
          data: {
            message: text,
            history,
            resume,
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

  const delayMs = (30 + Math.random() * 90) * 1000
  logger.info(`[AiReply] 等待 ${Math.round(delayMs / 1000)}s 后发送回复`)
  await new Promise((resolve) => setTimeout(resolve, delayMs))

  logger.info('[AiReply] 发送回复', { to: fromUid, content: replyContent })
  appendHistory(fromUid, 'me', replyContent)

  const buf = new Message({
    form_uid: myUid,
    to_uid: fromUid,
    to_name: fromUid,
    content: replyContent,
  })
  void buf.send()
}

export function initAiReply() {
  setTimeout(() => {
    getResume().catch(() => {})
  }, 3000)

  initBossChatListener()
  if (!unsubscribeChatListener) {
    unsubscribeChatListener = subscribeBossChatEvents((event) => {
      void handleIncomingMessage(event).catch((e) => {
        logger.debug('[AiReply] handle message failed', e)
      })
    })
  }
}
