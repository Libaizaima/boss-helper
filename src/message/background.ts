import type { Adapter, Message, OnMessage, SendMessage } from 'comctx'
import { defineProxy } from 'comctx'

import type { Browser } from '#imports'
import { browser, storage } from '#imports'
import type { FormData } from '@/types/formData'
import type { ResponseType } from '@/utils/request'

export const userKey = 'local:conf-user'

export interface CookieInfo {
  uid: string
  user: string
  avatar: string
  remark: string
  gender: 'man' | 'woman'
  flag: 'student' | 'staff'
  date: string
  form?: FormData
  statistics?: string
}

export type UserConf = Record<
  string,
  {
    info: CookieInfo
    cookies: Browser.cookies.Cookie[]
  }
>

export class BackgroundCounter {
  async cookieInfo() {
    const cookieInfo = await storage.getItem<UserConf>(userKey, { fallback: {} })
    const result: Record<string, CookieInfo> = {}
    Object.entries(cookieInfo).forEach(([uid, v]) => {
      result[uid] = v.info
    })
    return result
  }

  async cookieSwitch(uid: string) {
    const userConf = await storage.getItem<UserConf>(userKey, { fallback: {} })
    if (uid in userConf) {
      const cookies = await browser.cookies.getAll({ url: 'https://zhipin.com' })
      await Promise.all(
        cookies.map(async (cookie) => {
          await browser.cookies.remove({
            url: 'https://zhipin.com',
            name: cookie.name,
          })
        }),
      )

      const targetUser = userConf[uid]

      await Promise.all(
        targetUser.cookies.map(async (ck) => {
          await browser.cookies.set({
            url: 'https://zhipin.com',
            name: ck.name,
            value: ck.value,
            path: ck.path,
            domain: ck.domain,
            expirationDate: ck.expirationDate,
          })
        }),
      )
    }
    return true
  }

  async cookieSave(info: CookieInfo) {
    // 直接保存完整的cookie字符串数组
    const cookies = await browser.cookies.getAll({ url: 'https://zhipin.com' })

    const userConf = await storage.getItem<UserConf>(userKey, { fallback: {} })
    userConf[info.uid] = {
      info,
      cookies,
    }
    await storage.setItem(userKey, userConf)
    return true
  }

  async cookieDelete(uid: string) {
    const userConf = await storage.getItem<UserConf>(userKey, { fallback: {} })
    delete userConf[uid]
    await storage.setItem(userKey, userConf)
    return true
  }

  async cookieClear() {
    const cookies = await browser.cookies.getAll({ url: 'https://zhipin.com' })
    await Promise.all(
      cookies.map(async (cookie) => {
        await browser.cookies.remove({
          url: 'https://zhipin.com',
          name: cookie.name,
        })
      }),
    )
    return true
  }

  async request(args: {
    url: string
    data: RequestInit
    timeout: number
    responseType: ResponseType
  }) {
    const signal = AbortSignal.timeout(args.timeout * 1000)

    const res = await fetch(args.url, {
      ...args.data,
      signal,
      mode: 'cors',
      credentials: 'include',
    }).then(async (res) => {
      if (!res.ok || res.status >= 400) {
        const errorText = await res.text()
        throw new Error(`状态码: ${res.status}: ${errorText}`)
      }

      const result = args.responseType === 'json' ? await res.json() : await res.text()

      return result
    })
    return res
  }

  async notify(args: {
    title: string
    message: string
    type: 'basic' | 'image' | 'list' | 'progress'
    iconUrl: string
  }) {
    await browser.notifications.create({
      type: args.type,
      iconUrl: args.iconUrl,
      title: args.title,
      message: args.message,
    })
    return true
  }

  async backgroundTest(type: 'success' | 'error') {
    if (type === 'error') {
      throw new Error(`background test error date: ${Date.now()}`)
    }
    return Date.now()
  }
}

interface MessageMeta {
  url: string
}

export class ProvideBackgroundAdapter implements Adapter<MessageMeta> {
  sendMessage: SendMessage<MessageMeta> = async (message) => {
    const tabs = await browser.tabs.query({ url: message.meta.url })
    await Promise.all(tabs.map(async (tab) => browser.tabs.sendMessage(tab.id!, message)))
  }

  onMessage: OnMessage<MessageMeta> = (callback) => {
    const handler = (message?: Partial<Message<MessageMeta>>) => {
      callback(message)
    }
    browser.runtime.onMessage.addListener(handler)
    return () => browser.runtime.onMessage.removeListener(handler)
  }
}

export const [provideBackgroundCounter] = defineProxy(() => new BackgroundCounter(), {
  namespace: '__boss-helper-background__',
})
