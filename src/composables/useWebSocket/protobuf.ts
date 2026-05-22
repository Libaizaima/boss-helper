import { ElMessage } from 'element-plus'

import { useLog } from '@/stores/log'
import { logger } from '@/utils/logger'

import { ackRegistry, type SendChannel, type SendResult } from './ackRegistry'
import type { TechwolfChatProtocol } from './type'
import { AwesomeMessage } from './type'

export type { SendChannel, SendFailureReason, SendResult } from './ackRegistry'

export interface SendOptions {
  timeoutMs?: number
  expectAck?: boolean
}

interface MessageArgs {
  form_uid: string
  to_uid: string
  to_name: string
  friend_source?: number
  content?: string
  image?: string
}

function logToPanel(title: string, message: string, payload?: unknown) {
  try {
    useLog().debug(title, message, payload)
  } catch {
    // Pinia may not be ready in tests or early page bootstrap.
  }
}

ackRegistry.setDiagnosticsLogger(logToPanel)

function resolveTimeoutMs(input: number | undefined): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return 5000
  if (input < 1000) return 1000
  if (input > 15000) return 15000
  return input
}

function truncate(value: string | undefined, max = 120): string {
  if (value == null) return ''
  return value.length > max ? `${value.slice(0, max)}...` : value
}

async function attachOutcomeLogger(
  pending: Promise<SendResult>,
  content: string | undefined,
): Promise<SendResult> {
  const result = await pending
  if (result.ok) {
    logToPanel('消息发送/已确认', `通过 ${result.channel} 发送已确认: ${content ?? ''}`, {
      cmid: result.cmid,
      channel: result.channel,
      ackMid: result.ackMid,
      ackSource: result.ackSource,
      serverCode: result.serverCode,
    })
    return result
  }

  switch (result.reason) {
    case 'TIMEOUT':
    case 'UNVERIFIED':
    case 'CMID_COLLISION':
      logToPanel('消息发送/未确认', `ACK 未确认: ${content ?? ''}`, {
        cmid: result.cmid,
        channel: result.channel,
        reason: result.reason,
      })
      break
    case 'SERVER_REJECTED':
      logToPanel(
        '消息发送/服务端拒绝',
        `服务端拒绝(code=${result.serverCode ?? ''}): ${truncate(result.serverMessage)}`,
        {
          cmid: result.cmid,
          channel: result.channel,
          serverCode: result.serverCode,
          serverMessage: result.serverMessage,
        },
      )
      break
    default:
      break
  }
  return result
}

export class Message {
  msg: Uint8Array
  payload: Uint8Array
  packet: Uint8Array
  hex: string
  args: MessageArgs
  readonly cmid: string

  constructor(args: MessageArgs) {
    this.args = args

    const now = Date.now()
    const mid = now + 68256432452609
    this.cmid = mid.toString()

    const data: TechwolfChatProtocol = {
      messages: [
        {
          from: {
            uid: args.form_uid,
            source: 0,
          },
          to: {
            uid: args.to_uid,
            name: args.to_name,
            source: 0,
          },
          type: 1,
          mid: this.cmid,
          time: now.toString(),
          body: {
            type: 1,
            templateId: 1,
            text: args.content,
          },
          cmid: this.cmid,
        },
      ],
      type: 1,
    }

    this.msg = AwesomeMessage.encode(data).finish().slice()
    this.payload = this.msg
    this.packet = this.msg
    this.hex = [...this.msg].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  toArrayBuffer(): ArrayBuffer {
    return this.msg.buffer.slice(
      this.msg.byteOffset,
      this.msg.byteOffset + this.msg.byteLength,
    ) as ArrayBuffer
  }

  toPayloadArrayBuffer(): ArrayBuffer {
    return this.toArrayBuffer()
  }

  private sendInfo(channel?: SendChannel) {
    return {
      cmid: this.cmid,
      channel,
      to_uid: this.args.to_uid,
      to_name: this.args.to_name,
      content: this.args.content,
    }
  }

  private async sendWithAck(
    channel: SendChannel,
    timeoutMs: number,
    send: () => void,
  ): Promise<SendResult> {
    const pending = ackRegistry.register(this.cmid, timeoutMs, channel)
    try {
      send()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ackRegistry.resolveFail(this.cmid, 'CHANNEL_SYNC_THROW')
      logger.error(`[Send] ${channel} 发送异常`, message)
      logToPanel(`消息发送/${channel} 异常`, message, this.sendInfo(channel))
      return attachOutcomeLogger(pending, this.args.content)
    }

    logToPanel(
      '消息发送/已入队',
      `通过 ${channel} 发送: ${this.args.content ?? ''}`,
      this.sendInfo(channel),
    )
    return attachOutcomeLogger(pending, this.args.content)
  }

  private buildNativeTextUser() {
    const uid = Number(this.args.to_uid)
    const clientMid = Number(this.cmid)
    if (!Number.isFinite(uid) || uid <= 0) {
      throw new Error('invalid chat target uid')
    }
    if (!Number.isFinite(clientMid)) {
      throw new Error('invalid chat clientMid')
    }
    return {
      uid,
      friendSource: this.args.friend_source ?? 0,
      encryptUid: this.args.to_name,
      encryptGid: '',
      clientMid,
    }
  }

  private sendWithCurrentGeekChatCore(): boolean {
    const chatCore = window.GeekChatCore?.getInstance?.()
    const content = this.args.content ?? ''
    if (!chatCore || !content) {
      return false
    }

    const user = this.buildNativeTextUser()
    if (typeof chatCore.sendMessage === 'function') {
      chatCore.sendMessage(user, content, 'text')
      return true
    }
    if (typeof chatCore.sendMessageByType === 'function') {
      chatCore.sendMessageByType('text', user, content)
      return true
    }

    const socketConnect = chatCore.socketConnect
    if (typeof socketConnect?.sendMessage === 'function') {
      socketConnect.sendMessage(user, content, 'text')
      return true
    }
    if (typeof socketConnect?.sendMessageByType === 'function') {
      socketConnect.sendMessageByType('text', user, content)
      return true
    }

    const sharedWorkerClient =
      socketConnect?.broadcastManager?.sharedWorkerClient
    if (typeof sharedWorkerClient?.sendTextMessage === 'function') {
      void sharedWorkerClient.sendTextMessage(user, content)
      return true
    }

    return false
  }

  private hasCurrentGeekChatCoreSender(): boolean {
    const chatCore = window.GeekChatCore?.getInstance?.()
    const socketConnect = chatCore?.socketConnect
    const sharedWorkerClient =
      socketConnect?.broadcastManager?.sharedWorkerClient
    return (
      typeof chatCore?.sendMessage === 'function' ||
      typeof chatCore?.sendMessageByType === 'function' ||
      typeof socketConnect?.sendMessage === 'function' ||
      typeof socketConnect?.sendMessageByType === 'function' ||
      typeof sharedWorkerClient?.sendTextMessage === 'function'
    )
  }

  async send(opts?: SendOptions): Promise<SendResult> {
    const timeoutMs = resolveTimeoutMs(opts?.timeoutMs)
    const expectAck = opts?.expectAck ?? true

    if (this.hasCurrentGeekChatCoreSender()) {
      const channel: SendChannel = 'GeekChatCore'
      if (!expectAck) {
        try {
          if (!this.sendWithCurrentGeekChatCore()) {
            throw new Error('GeekChatCore sendMessage is unavailable')
          }
          logToPanel(
            '消息发送/已入队',
            `通过 GeekChatCore 发送: ${this.args.content ?? ''}`,
            this.sendInfo(channel),
          )
          return { ok: true, channel, cmid: this.cmid }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.error('[Send] GeekChatCore 发送异常', message)
          logToPanel('消息发送/GeekChatCore 异常', message, this.sendInfo(channel))
          return { ok: false, channel, cmid: this.cmid, reason: 'CHANNEL_SYNC_THROW' }
        }
      }

      return this.sendWithAck(channel, timeoutMs, () => {
        if (!this.sendWithCurrentGeekChatCore()) {
          throw new Error('GeekChatCore sendMessage is unavailable')
        }
      })
    }

    const geekClient = window.GeekChatCore?.getInstance?.()?.getClient?.()?.client
    if (typeof geekClient?.send === 'function') {
      const channel: SendChannel = 'GeekChatCore'
      if (!expectAck) {
        try {
          geekClient.send(this)
          logToPanel(
            '消息发送/已入队',
            `通过 GeekChatCore 发送: ${this.args.content ?? ''}`,
            this.sendInfo(channel),
          )
          return { ok: true, channel, cmid: this.cmid }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.error('[Send] GeekChatCore 发送异常', message)
          logToPanel('消息发送/GeekChatCore 异常', message, this.sendInfo(channel))
          return { ok: false, channel, cmid: this.cmid, reason: 'CHANNEL_SYNC_THROW' }
        }
      }
      return this.sendWithAck(channel, timeoutMs, () => geekClient.send(this))
    }

    if (window.ChatWebsocket != null && typeof window.ChatWebsocket.send === 'function') {
      const channel: SendChannel = 'ChatWebsocket'
      if (!expectAck) {
        try {
          window.ChatWebsocket.send(this)
          logToPanel(
            '消息发送/已入队',
            `通过 ChatWebsocket 发送: ${this.args.content ?? ''}`,
            this.sendInfo(channel),
          )
          return { ok: true, channel, cmid: this.cmid }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger.error('[Send] ChatWebsocket 发送异常', message)
          logToPanel('消息发送/ChatWebsocket 异常', message, this.sendInfo(channel))
          return { ok: false, channel, cmid: this.cmid, reason: 'CHANNEL_SYNC_THROW' }
        }
      }
      return this.sendWithAck(channel, timeoutMs, () => window.ChatWebsocket!.send(this))
    }

    logToPanel('消息发送/通道诊断', '可验证发送通道不可用，准备退回 EventBus', {
      cmid: this.cmid,
      diagnostics: ackRegistry.getSendDiagnostics(),
    })

    if (window.EventBus != null && typeof window.EventBus.publish === 'function') {
      const channel: SendChannel = 'EventBus'
      try {
        let callbackFailed = false
        window.EventBus.publish(
          'CHAT_SEND_TEXT',
          {
            uid: this.args.to_uid,
            encryptUid: this.args.to_name,
            message: this.args.content,
            msg: this.args.content,
          },
          () => {
            logToPanel(
              '消息发送/未确认',
              `EventBus 已入队但无法验证服务端接收: ${this.args.content ?? ''}`,
              { ...this.sendInfo(channel), reason: 'UNVERIFIED' },
            )
          },
          () => {
            callbackFailed = true
            logToPanel('消息发送/EventBus 失败', '回调返回失败', this.sendInfo(channel))
          },
        )
        logToPanel(
          '消息发送/已入队',
          `通过 EventBus 发送: ${this.args.content ?? ''}`,
          this.sendInfo(channel),
        )
        if (callbackFailed) {
          return { ok: false, channel, cmid: this.cmid, reason: 'EVENTBUS_FAILED' }
        }
        if (!expectAck) {
          return { ok: true, channel, cmid: this.cmid }
        }
        return { ok: false, channel, cmid: this.cmid, reason: 'UNVERIFIED' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('[Send] EventBus 发送异常', message)
        logToPanel('消息发送/EventBus 异常', message, this.sendInfo(channel))
        return { ok: false, channel, cmid: this.cmid, reason: 'CHANNEL_SYNC_THROW' }
      }
    }

    const errMsg = `无可用消息发送渠道: GeekChatCore=${window.GeekChatCore != null}, ChatWebsocket=${window.ChatWebsocket != null}, EventBus=${window.EventBus != null}`
    logger.error(`[Send] ${errMsg}`)
    logToPanel('消息发送/全部失败', errMsg, {
      ...this.sendInfo('none'),
      diagnostics: ackRegistry.getSendDiagnostics(),
    })
    ElMessage.error(errMsg)
    return { ok: false, channel: 'none', cmid: this.cmid, reason: 'NO_CHANNEL' }
  }
}
