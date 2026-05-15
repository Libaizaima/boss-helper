import { ElMessage } from 'element-plus'

import { useLog } from '@/stores/log'
import { logger } from '@/utils/logger'

import {
  ackRegistry,
  type SendChannel,
  type SendResult,
} from './ackRegistry'
import type { TechwolfChatProtocol } from './type'
import { AwesomeMessage } from './type'

// Re-export ackRegistry types so callers can import them from `@/composables/useWebSocket`.
export type { SendChannel, SendFailureReason, SendResult } from './ackRegistry'

/**
 * Optional knobs for `Message.send`.
 *
 * Defaults are chosen so that `await buf.send()` (no opts) gives the safest
 * behaviour: 5s ACK timeout (clamped to [1000, 15000] when explicitly set)
 * and `expectAck: true`. Greeting call sites supply the user-configured
 * timeout via task 3.3; this module stays pinia-free.
 */
export interface SendOptions {
  /** ACK timeout in milliseconds. Clamped to [1000, 15000]. Defaults to 5000. */
  timeoutMs?: number
  /**
   * When false, skip ACK registration and resolve immediately with
   * `{ ok: true, channel, cmid }` after the channel call returns. Defaults to true.
   * Reserved for non-greeting call sites that have no need for verification.
   */
  expectAck?: boolean
}

/**
 * 把消息发送相关日志写入插件日志面板
 */
function logToPanel(title: string, message: string, payload?: any) {
  try {
    useLog().debug(title, message, payload)
  } catch {
    // pinia 还没初始化时静默忽略
  }
}

ackRegistry.setDiagnosticsLogger(logToPanel)

/** Clamp the user-supplied timeout to the design-mandated `[1000, 15000]` range. */
function resolveTimeoutMs(input: number | undefined): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return 5000
  if (input < 1000) return 1000
  if (input > 15000) return 15000
  return input
}

/** Truncate `serverMessage` for log payloads (≤ 120 chars per design AC6.2). */
function truncate(s: string | undefined, max = 120): string {
  if (s == null) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Wrap a pending ACK promise with the final telemetry layer (一已确认 / 未确认 /
 * 服务端拒绝). Already-logged failure reasons (EVENTBUS_FAILED, CHANNEL_SYNC_THROW)
 * are intentionally skipped here to avoid duplicate log entries.
 */
async function attachOutcomeLogger(
  pending: Promise<SendResult>,
  content: string | undefined,
): Promise<SendResult> {
  const res = await pending
  if (res.ok) {
    logToPanel(
      '消息发送/已确认',
      `通过 ${res.channel} 发送已确认: ${content ?? ''}`,
      {
        cmid: res.cmid,
        channel: res.channel,
        ackMid: res.ackMid,
        ackSource: res.ackSource,
        serverCode: res.serverCode,
      },
    )
  } else {
    switch (res.reason) {
      case 'TIMEOUT':
        logToPanel(
          '消息发送/未确认',
          `ACK 超时: ${content ?? ''}`,
          { cmid: res.cmid, channel: res.channel, reason: res.reason },
        )
        break
      case 'SERVER_REJECTED':
        logToPanel(
          '消息发送/服务端拒绝',
          `服务端拒绝(code=${res.serverCode ?? ''}): ${truncate(res.serverMessage)}`,
          {
            cmid: res.cmid,
            channel: res.channel,
            serverCode: res.serverCode,
            serverMessage: res.serverMessage,
          },
        )
        break
      case 'CMID_COLLISION':
        logToPanel(
          '消息发送/未确认',
          'cmid 冲突',
          { cmid: res.cmid, channel: res.channel, reason: res.reason },
        )
        break
      case 'UNVERIFIED':
        // Reserved for future use: current code paths don't directly emit
        // UNVERIFIED, but if a future ACK source produces it the operator
        // will see a distinct "未确认" panel entry.
        logToPanel(
          '消息发送/未确认',
          `ACK 不可验证: ${content ?? ''}`,
          { cmid: res.cmid, channel: res.channel, reason: res.reason },
        )
        break
      // EVENTBUS_FAILED / CHANNEL_SYNC_THROW / NO_CHANNEL:
      // already logged at the throw / failure site, intentionally skipped here.
      default:
        break
    }
  }
  return res
}

interface MessageArgs {
  form_uid: string
  to_uid: string
  to_name: string // encryptBossId  擦,boss的id不是岗位的
  content?: string
  image?: string // url
}

export class Message {
  msg: Uint8Array
  hex: string
  args: MessageArgs
  /**
   * Client message id used both for the protocol `mid` / `cmid` fields and as the
   * key in `ackRegistry`. Generation is locked to `(Date.now() + 68256432452609)`
   * by AC7.3 — do NOT change this expression.
   */
  readonly cmid: string

  constructor(args: MessageArgs) {
    this.args = args
    const r = new Date().getTime()
    const d = r + 68256432452609
    this.cmid = d.toString()
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
          time: r.toString(),
          body: {
            type: 1,
            templateId: 1,
            text: args.content,
            // image: {},
          },
          cmid: this.cmid,
        },
      ],
      type: 1,
    }

    this.msg = AwesomeMessage.encode(data).finish().slice()
    this.hex = [...this.msg].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  toArrayBuffer(): ArrayBuffer {
    return this.msg.buffer.slice(0, this.msg.byteLength) as ArrayBuffer
  }

  /**
   * Send this message through the available channel and (when `expectAck` is true)
   * await an ACK / rejection / timeout from `ackRegistry`.
   *
   * Channel priority (locked by AC7.3):
   *   GeekChatCore → ChatWebsocket → EventBus → `{ ok: false, reason: 'NO_CHANNEL' }`.
   *
   * Returns a `Promise<SendResult>`. Channel/setup failures resolve as
   * `{ ok: false }` so greeting callers can surface "失败/未确认" in the same
   * log and statistics path as ACK timeouts.
   */
  async send(opts?: SendOptions): Promise<SendResult> {
    const timeoutMs = resolveTimeoutMs(opts?.timeoutMs)
    const expectAck = opts?.expectAck ?? true
    const cmid = this.cmid
    const content = this.args.content

    const sendInfo = {
      to_uid: this.args.to_uid,
      to_name: this.args.to_name,
      content,
    }
    const sendInfoWithCmid = { ...sendInfo, cmid }

    // 渠道 1: GeekChatCore
    if ('GeekChatCore' in window && window.GeekChatCore != null) {
      const chatCore = (window.GeekChatCore as any).getInstance?.()
      const client = chatCore?.getClient?.()?.client
      if (client?.send) {
        const channel: SendChannel = 'GeekChatCore'
        if (expectAck) {
          // Register BEFORE calling SDK.send so an ultra-fast inbound ACK
          // can never out-race us. ackRegistry handles cmid collisions
          // internally per AC7.2 (no auto-retry; old promise is settled).
          const pending = ackRegistry.register(cmid, timeoutMs, channel)
          try {
            client.send(this)
          } catch (e: any) {
            ackRegistry.resolveFail(cmid, 'CHANNEL_SYNC_THROW')
            logger.error('[Send] GeekChatCore 发送异常', e?.message ?? e)
            logToPanel(
              '消息发送/GeekChatCore 异常',
              e?.message ?? String(e),
              sendInfo,
            )
            return attachOutcomeLogger(pending, content)
          }
          logToPanel(
            '消息发送/已入队',
            `通过 GeekChatCore 发送: ${content ?? ''}`,
            { ...sendInfoWithCmid, channel },
          )
          return attachOutcomeLogger(pending, content)
        } else {
          try {
            client.send(this)
            logToPanel(
              '消息发送/已入队',
              `通过 GeekChatCore 发送: ${content ?? ''}`,
              { ...sendInfoWithCmid, channel },
            )
            return Promise.resolve<SendResult>({ ok: true, channel, cmid })
          } catch (e: any) {
            logger.error('[Send] GeekChatCore 发送异常', e?.message ?? e)
            logToPanel(
              '消息发送/GeekChatCore 异常',
              e?.message ?? String(e),
              sendInfo,
            )
            return Promise.resolve<SendResult>({
              ok: false,
              channel,
              cmid,
              reason: 'CHANNEL_SYNC_THROW',
            })
          }
        }
      }
    }

    // 渠道 2: ChatWebsocket
    if ('ChatWebsocket' in window && window.ChatWebsocket != null) {
      const channel: SendChannel = 'ChatWebsocket'
      if (expectAck) {
        const pending = ackRegistry.register(cmid, timeoutMs, channel)
        try {
          window.ChatWebsocket.send(this)
        } catch (e: any) {
          ackRegistry.resolveFail(cmid, 'CHANNEL_SYNC_THROW')
          logger.error('[Send] ChatWebsocket 发送异常', e?.message ?? e)
          logToPanel(
            '消息发送/ChatWebsocket 异常',
            e?.message ?? String(e),
            sendInfo,
          )
          return attachOutcomeLogger(pending, content)
        }
        logToPanel(
          '消息发送/已入队',
          `通过 ChatWebsocket 发送: ${content ?? ''}`,
          { ...sendInfoWithCmid, channel },
        )
        return attachOutcomeLogger(pending, content)
      } else {
        try {
          window.ChatWebsocket.send(this)
          logToPanel(
            '消息发送/已入队',
            `通过 ChatWebsocket 发送: ${content ?? ''}`,
            { ...sendInfoWithCmid, channel },
          )
          return Promise.resolve<SendResult>({ ok: true, channel, cmid })
        } catch (e: any) {
          logger.error('[Send] ChatWebsocket 发送异常', e?.message ?? e)
          logToPanel(
            '消息发送/ChatWebsocket 异常',
            e?.message ?? String(e),
            sendInfo,
          )
          return Promise.resolve<SendResult>({
            ok: false,
            channel,
            cmid,
            reason: 'CHANNEL_SYNC_THROW',
          })
        }
      }
    }

    logToPanel(
      '消息发送/通道诊断',
      '可验证发送通道不可用，准备退回 EventBus',
      {
        cmid,
        diagnostics: ackRegistry.getSendDiagnostics(),
      },
    )

    // 渠道 3: EventBus
    if (window.EventBus != null) {
      const channel: SendChannel = 'EventBus'
      try {
        let callbackFailed = false
        window.EventBus.publish(
          'CHAT_SEND_TEXT',
          {
            uid: this.args.to_uid,
            encryptUid: this.args.to_name,
            message: content,
            msg: content,
          },
          () => {
            logToPanel(
              '消息发送/未确认',
              `EventBus 已入队但无法验证服务端接收: ${content ?? ''}`,
              { ...sendInfoWithCmid, channel, reason: 'UNVERIFIED' },
            )
          },
          () => {
            callbackFailed = true
            logToPanel(
              '消息发送/EventBus 失败',
              '回调返回失败',
              { ...sendInfoWithCmid, channel },
            )
          },
        )
        logToPanel(
          '消息发送/已入队',
          `通过 EventBus 发送: ${content ?? ''}`,
          { ...sendInfoWithCmid, channel },
        )
        if (callbackFailed) {
          return Promise.resolve<SendResult>({
            ok: false,
            channel,
            cmid,
            reason: 'EVENTBUS_FAILED',
          })
        }
        if (!expectAck) {
          return Promise.resolve<SendResult>({ ok: true, channel, cmid })
        }
        return Promise.resolve<SendResult>({
          ok: false,
          channel,
          cmid,
          reason: 'UNVERIFIED',
        })
      } catch (e: any) {
        logger.error('[Send] EventBus 发送异常', e?.message ?? e)
        logToPanel('消息发送/EventBus 异常', e?.message ?? String(e), sendInfo)
        return Promise.resolve<SendResult>({
          ok: false,
          channel,
          cmid,
          reason: 'CHANNEL_SYNC_THROW',
        })
      }
    }

    const errMsg = `无可用消息发送渠道: GeekChatCore=${'GeekChatCore' in window}, ChatWebsocket=${'ChatWebsocket' in window}, EventBus=${window.EventBus != null}`
    logger.error('[Send] ' + errMsg)
    logToPanel('消息发送/全部失败', errMsg, {
      ...sendInfo,
      diagnostics: ackRegistry.getSendDiagnostics(),
    })
    ElMessage.error(errMsg)
    return Promise.resolve<SendResult>({
      ok: false,
      channel: 'none',
      cmid,
      reason: 'NO_CHANNEL',
    })
  }
}
