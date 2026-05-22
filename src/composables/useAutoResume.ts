import axios from 'axios'

import { counter } from '@/message'
import { useConf } from '@/stores/conf'
import type { MyJobListData } from '@/stores/jobs'
import { logger } from '@/utils/logger'

import { type BossChatEvent, initBossChatListener, subscribeBossChatEvents } from './useChatListener'
import { requestBossData } from './useApplying/utils'

type AutoResumeContactSource = 'applied' | 'incoming'
type AutoResumeAction = 'skip' | 'click' | 'api' | 'fallback'
type AutoResumeResult = 'success' | 'failed'
type AutoResumeParamSource =
  | 'bossUid'
  | 'encryptBossId'
  | 'jobId'
  | 'securityId'
  | 'lid'
  | 'jobName'
  | 'bossName'

interface AutoResumeContactJob {
  jobId?: string
  securityId?: string
  lid?: string
  jobName?: string
  greetedAt: number
}

interface AutoResumeContact {
  bossUid: string
  encryptBossId?: string
  bossName?: string
  source: AutoResumeContactSource
  jobs: AutoResumeContactJob[]
}

interface AutoResumeSentRecord {
  time: number
  reason: string
}

interface AutoResumeLogRecord {
  time: number
  bossUid: string
  jobId?: string
  reason: string
  action: AutoResumeAction
  result: AutoResumeResult
  message: string
}

export interface AutoResumeRequestTemplate {
  method: string
  urlPath: string
  queryKeys: string[]
  bodyKind: 'none' | 'json' | 'form' | 'formData'
  bodyKeys: string[]
  contentType?: string
  paramMapping: Record<string, AutoResumeParamSource>
}

interface AutoResumeContext {
  event: BossChatEvent
  contact: AutoResumeContact
  job?: AutoResumeContactJob
  key: string
  reason: string
}

interface RequestSnapshot {
  method: string
  url: string
  headers: Record<string, string>
  bodyKind: AutoResumeRequestTemplate['bodyKind']
  bodyFields: Record<string, string>
}

export const autoResumeContactsKey = 'local:autoResume:contacts'
export const autoResumeSentKey = 'local:autoResume:sent'
export const autoResumeLogKey = 'local:autoResume:log'
export const autoResumeRequestTemplateKey = 'local:autoResume:requestTemplate'

const pendingKeys = new Set<string>()
const protocolResumeSentBossUids = new Set<string>()

let initialized = false
let lastUserActivity = Date.now()
let lastAutoResumeSendAt = 0

function now() {
  return Date.now()
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, '').toLowerCase()
}

export function isAutoResumeKeywordMatched(text: string | undefined, keywords: string[]): boolean {
  if (!text) return false
  const normalized = normalizeText(text)
  return keywords.some((keyword) => keyword && normalized.includes(normalizeText(keyword)))
}

function sentKey(bossUid: string, jobId?: string) {
  return `${bossUid}:${jobId || 'unknown'}`
}

function getCurrentChatJobId(): string | undefined {
  try {
    const url = new URL(location.href)
    return url.searchParams.get('jobId') || undefined
  } catch {
    return undefined
  }
}

async function readContacts(): Promise<Record<string, AutoResumeContact>> {
  return counter.storageGet<Record<string, AutoResumeContact>>(autoResumeContactsKey, {})
}

async function writeContacts(data: Record<string, AutoResumeContact>) {
  await counter.storageSet(autoResumeContactsKey, data)
}

async function readSentRecords(): Promise<Record<string, AutoResumeSentRecord>> {
  return counter.storageGet<Record<string, AutoResumeSentRecord>>(autoResumeSentKey, {})
}

async function writeSentRecords(data: Record<string, AutoResumeSentRecord>) {
  await counter.storageSet(autoResumeSentKey, data)
}

async function addAutoResumeLog(record: Omit<AutoResumeLogRecord, 'time'>) {
  const item: AutoResumeLogRecord = { ...record, time: now() }
  logger.info('[AutoResume]', item)
  try {
    const existing = await counter.storageGet<AutoResumeLogRecord[]>(autoResumeLogKey, [])
    existing.unshift(item)
    await counter.storageSet(autoResumeLogKey, existing.slice(0, 50))
  } catch (e) {
    logger.warn('[AutoResume] log persist failed', e)
  }
}

async function markResumeSent(bossUid: string, jobId: string | undefined, reason: string) {
  const sent = await readSentRecords()
  sent[sentKey(bossUid, jobId)] = { time: now(), reason }
  await writeSentRecords(sent)
}

function chooseJob(contact: AutoResumeContact): AutoResumeContactJob | undefined {
  const currentJobId = getCurrentChatJobId()
  if (currentJobId) {
    const matched = contact.jobs.find((job) => job.jobId === currentJobId)
    if (matched) return matched
  }
  return [...contact.jobs].sort((a, b) => b.greetedAt - a.greetedAt)[0]
}

async function upsertIncomingContact(bossUid: string): Promise<AutoResumeContact> {
  const contacts = await readContacts()
  const existing = contacts[bossUid]
  if (existing) return existing
  const contact: AutoResumeContact = {
    bossUid,
    source: 'incoming',
    jobs: [],
  }
  contacts[bossUid] = contact
  await writeContacts(contacts)
  return contact
}

export async function recordAutoResumeAppliedContact(
  data: MyJobListData,
  bossData?: bossZpBossData,
) {
  if (!data.card) return
  let resolvedBossData = bossData
  if (!resolvedBossData) {
    try {
      resolvedBossData = await requestBossData(data.card)
    } catch (e) {
      logger.debug('[AutoResume] requestBossData failed while recording contact', e)
      return
    }
  }

  const bossUid = resolvedBossData?.data?.bossId?.toString()
  if (!bossUid) return

  const contacts = await readContacts()
  const contact: AutoResumeContact = contacts[bossUid] ?? {
    bossUid,
    source: 'applied',
    jobs: [],
  }
  contact.source = 'applied'
  contact.encryptBossId = resolvedBossData.data.encryptBossId || data.encryptBossId
  contact.bossName = resolvedBossData.data.name || data.bossName

  const jobId = data.encryptJobId || resolvedBossData.data.encryptJobId
  const nextJob: AutoResumeContactJob = {
    jobId,
    securityId: data.securityId || resolvedBossData.data.securityId,
    lid: data.lid,
    jobName: data.jobName,
    greetedAt: now(),
  }
  const existingIndex = contact.jobs.findIndex((job) => job.jobId === jobId)
  if (existingIndex >= 0) {
    contact.jobs[existingIndex] = { ...contact.jobs[existingIndex], ...nextJob }
  } else {
    contact.jobs.push(nextJob)
  }
  contact.jobs = contact.jobs.sort((a, b) => b.greetedAt - a.greetedAt).slice(0, 20)
  contacts[bossUid] = contact
  await writeContacts(contacts)
}

function installUserActivityTracker() {
  const update = () => {
    lastUserActivity = now()
  }
  for (const eventName of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) {
    window.addEventListener(eventName, update, { passive: true })
  }
}

async function hasLocalSentRecord(bossUid: string, jobId?: string): Promise<boolean> {
  const sent = await readSentRecords()
  return Boolean(sent[sentKey(bossUid, jobId)] || sent[sentKey(bossUid, undefined)])
}

function isVisibleElement(element: Element): boolean {
  const el = element as HTMLElement
  if (!el.isConnected) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
    return false
  }
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function isDisabledElement(element: Element): boolean {
  const el = element as HTMLButtonElement
  return Boolean(
    el.disabled ||
      element.getAttribute('disabled') != null ||
      element.getAttribute('aria-disabled') === 'true',
  )
}

function textOf(element: Element): string {
  return (element.textContent || '').replace(/\s+/g, '')
}

function getClickableElement(element: Element): HTMLElement | null {
  const clickable = element.closest('button,a,[role="button"]') as HTMLElement | null
  if (clickable) return clickable
  return element instanceof HTMLElement ? element : null
}

function findButtonByTexts(texts: string[]): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll('button,a,[role="button"],span,div'))
  for (const candidate of candidates) {
    const text = textOf(candidate)
    if (!texts.some((item) => text === item || text.includes(item))) continue
    const clickable = getClickableElement(candidate)
    if (!clickable || !isVisibleElement(clickable) || isDisabledElement(clickable)) continue
    return clickable
  }
  return null
}

function findResumeButton(): HTMLElement | null {
  return findButtonByTexts(['发简历', '发送简历'])
}

function hasDisabledResumeButton(): boolean {
  const candidates = Array.from(document.querySelectorAll('button,a,[role="button"],span,div'))
  return candidates.some((candidate) => {
    const text = textOf(candidate)
    if (!text.includes('发简历') && !text.includes('发送简历')) return false
    const clickable = getClickableElement(candidate)
    return clickable != null && isVisibleElement(clickable) && isDisabledElement(clickable)
  })
}

function hasResumeDomEvidence(): boolean {
  const text = document.body instanceof HTMLElement ? document.body.innerText : ''
  return (
    text.includes('已发送简历') ||
    text.includes('简历已发送') ||
    text.includes('已投递简历') ||
    hasDisabledResumeButton()
  )
}

async function hasSentResume(ctx: AutoResumeContext): Promise<boolean> {
  if (await hasLocalSentRecord(ctx.contact.bossUid, ctx.job?.jobId)) return true
  if (protocolResumeSentBossUids.has(ctx.contact.bossUid)) return true
  await delay(200)
  return hasResumeDomEvidence()
}

async function clickConfirmIfNeeded() {
  await delay(300)
  const confirm = findButtonByTexts(['确认', '发送', '确定'])
  if (confirm) {
    confirm.click()
    await delay(300)
  }
}

async function sendByClick(ctx: AutoResumeContext): Promise<boolean> {
  const button = findResumeButton()
  if (!button) {
    await addAutoResumeLog({
      bossUid: ctx.contact.bossUid,
      jobId: ctx.job?.jobId,
      reason: ctx.reason,
      action: 'click',
      result: 'failed',
      message: '未找到可点击的发简历按钮',
    })
    return false
  }
  button.click()
  await clickConfirmIfNeeded()
  await delay(1500)
  const verified = hasResumeDomEvidence() || protocolResumeSentBossUids.has(ctx.contact.bossUid)
  await markResumeSent(ctx.contact.bossUid, ctx.job?.jobId, verified ? 'click-verified' : 'click')
  await addAutoResumeLog({
    bossUid: ctx.contact.bossUid,
    jobId: ctx.job?.jobId,
    reason: ctx.reason,
    action: 'click',
    result: 'success',
    message: verified ? '已点击并验证简历发送' : '已点击发简历按钮，未拿到明确 DOM 验证',
  })
  return true
}

function getMappedValue(source: AutoResumeParamSource, ctx: AutoResumeContext): string | undefined {
  switch (source) {
    case 'bossUid':
      return ctx.contact.bossUid
    case 'encryptBossId':
      return ctx.contact.encryptBossId || ctx.contact.bossUid
    case 'jobId':
      return ctx.job?.jobId
    case 'securityId':
      return ctx.job?.securityId
    case 'lid':
      return ctx.job?.lid
    case 'jobName':
      return ctx.job?.jobName
    case 'bossName':
      return ctx.contact.bossName
  }
}

function buildTemplateParams(template: AutoResumeRequestTemplate, ctx: AutoResumeContext) {
  const result: Record<string, string> = {}
  const keys = [...template.queryKeys, ...template.bodyKeys]
  for (const key of keys) {
    const source = template.paramMapping[key]
    if (!source) continue
    const value = getMappedValue(source, ctx)
    if (value == null) return null
    result[key] = value
  }
  return result
}

async function readRequestTemplate(): Promise<AutoResumeRequestTemplate | null> {
  return counter.storageGet<AutoResumeRequestTemplate | null>(autoResumeRequestTemplateKey, null)
}

async function sendByLearnedApi(ctx: AutoResumeContext): Promise<boolean> {
  const template = await readRequestTemplate()
  if (!template) return false
  const params = buildTemplateParams(template, ctx)
  if (!params) return false

  const token = (window as any).Cookie?.get?.('bst')
  if (!token) return false

  const query = new URLSearchParams()
  for (const key of template.queryKeys) {
    if (params[key] != null) query.set(key, params[key])
  }
  const url = `${location.origin}${template.urlPath}${query.toString() ? `?${query}` : ''}`

  let data: unknown
  if (template.bodyKind === 'json') {
    data = template.bodyKeys.reduce<Record<string, string>>((acc, key) => {
      if (params[key] != null) acc[key] = params[key]
      return acc
    }, {})
  } else if (template.bodyKind === 'form' || template.bodyKind === 'formData') {
    const form = template.bodyKind === 'form' ? new URLSearchParams() : new FormData()
    for (const key of template.bodyKeys) {
      if (params[key] != null) form.append(key, params[key])
    }
    data = form
  }

  try {
    const res = await axios({
      method: template.method,
      url,
      data,
      headers: {
        Zp_token: token,
        ...(template.bodyKind === 'form'
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      timeout: 8000,
    })
    const ok = res.status >= 200 && res.status < 300 && (res.data?.code == null || res.data.code === 0)
    await addAutoResumeLog({
      bossUid: ctx.contact.bossUid,
      jobId: ctx.job?.jobId,
      reason: ctx.reason,
      action: 'api',
      result: ok ? 'success' : 'failed',
      message: ok ? '接口发送成功' : `接口返回异常: ${String(res.data?.message ?? res.status)}`,
    })
    if (ok) await markResumeSent(ctx.contact.bossUid, ctx.job?.jobId, 'api')
    return ok
  } catch (e) {
    await addAutoResumeLog({
      bossUid: ctx.contact.bossUid,
      jobId: ctx.job?.jobId,
      reason: ctx.reason,
      action: 'api',
      result: 'failed',
      message: e instanceof Error ? e.message : String(e),
    })
    return false
  }
}

async function sendAutoResume(ctx: AutoResumeContext): Promise<boolean> {
  const conf = useConf()
  if (conf.formData.autoResume.preferLearnedApi && (await sendByLearnedApi(ctx))) {
    return true
  }
  if (conf.formData.autoResume.fallbackClick) {
    if (conf.formData.autoResume.preferLearnedApi) {
      await addAutoResumeLog({
        bossUid: ctx.contact.bossUid,
        jobId: ctx.job?.jobId,
        reason: ctx.reason,
        action: 'fallback',
        result: 'failed',
        message: '接口不可用，尝试点击按钮',
      })
    }
    return sendByClick(ctx)
  }
  return false
}

function randomDelayMs(minSec: number, maxSec: number) {
  const min = Math.max(0, Math.min(minSec, maxSec))
  const max = Math.max(min, maxSec)
  return (min + Math.random() * (max - min)) * 1000
}

async function handleBossMessage(event: BossChatEvent) {
  if (event.isFromMe && (event.hasResume || event.hasResumeShare)) {
    protocolResumeSentBossUids.add(event.toUid)
    void markResumeSent(event.toUid, undefined, 'protocol')
    return
  }
  if (!event.isFromBoss) return

  const conf = useConf()
  const autoResume = conf.formData.autoResume
  if (!autoResume.enable) return

  const contacts = await readContacts()
  let contact = contacts[event.fromUid]
  let reason = 'applied-reply'

  if (!contact) {
    if (!autoResume.allowIncomingBoss) return
    if (autoResume.incomingKeywordOnly && !isAutoResumeKeywordMatched(event.text, autoResume.keywords)) {
      await addAutoResumeLog({
        bossUid: event.fromUid,
        reason: 'incoming-keyword-miss',
        action: 'skip',
        result: 'failed',
        message: 'Boss 主动消息未命中简历关键词',
      })
      return
    }
    contact = await upsertIncomingContact(event.fromUid)
    reason = 'incoming-boss'
  } else if (!autoResume.replyAfterGreeting) {
    return
  }

  const job = chooseJob(contact)
  const key = sentKey(contact.bossUid, job?.jobId)
  if (pendingKeys.has(key)) return

  const ctx: AutoResumeContext = { event, contact, job, key, reason }
  if (await hasSentResume(ctx)) {
    await addAutoResumeLog({
      bossUid: contact.bossUid,
      jobId: job?.jobId,
      reason,
      action: 'skip',
      result: 'success',
      message: '已检测到发过简历，跳过',
    })
    return
  }
  if (autoResume.requirePageVisible && document.visibilityState !== 'visible') {
    await addAutoResumeLog({
      bossUid: contact.bossUid,
      jobId: job?.jobId,
      reason,
      action: 'skip',
      result: 'failed',
      message: '页面不在前台，跳过自动发简历',
    })
    return
  }
  if (autoResume.requireUserIdleSec > 0) {
    const idleMs = now() - lastUserActivity
    if (idleMs < autoResume.requireUserIdleSec * 1000) {
      await addAutoResumeLog({
        bossUid: contact.bossUid,
        jobId: job?.jobId,
        reason,
        action: 'skip',
        result: 'failed',
        message: '用户刚刚操作过页面，跳过自动发简历',
      })
      return
    }
  }
  if (now() - lastAutoResumeSendAt < 60_000) {
    await addAutoResumeLog({
      bossUid: contact.bossUid,
      jobId: job?.jobId,
      reason,
      action: 'skip',
      result: 'failed',
      message: '触发每分钟 1 次频率限制',
    })
    return
  }

  pendingKeys.add(key)
  try {
    await delay(randomDelayMs(autoResume.delayMinSec, autoResume.delayMaxSec))
    if (await hasSentResume(ctx)) return
    const ok = await sendAutoResume(ctx)
    if (ok) lastAutoResumeSendAt = now()
  } finally {
    pendingKeys.delete(key)
  }
}

function snapshotHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!headers) return result
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value
    })
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) result[String(key).toLowerCase()] = String(value)
  } else {
    for (const [key, value] of Object.entries(headers)) result[key.toLowerCase()] = String(value)
  }
  return result
}

function parseBody(body: unknown): Pick<RequestSnapshot, 'bodyKind' | 'bodyFields'> {
  if (body == null) return { bodyKind: 'none', bodyFields: {} }
  if (body instanceof URLSearchParams) {
    return { bodyKind: 'form', bodyFields: Object.fromEntries(body.entries()) }
  }
  if (body instanceof FormData) {
    const bodyFields: Record<string, string> = {}
    body.forEach((value, key) => {
      if (typeof value === 'string') bodyFields[key] = value
    })
    return { bodyKind: 'formData', bodyFields }
  }
  if (typeof body === 'string') {
    try {
      const json = JSON.parse(body)
      if (json && typeof json === 'object') return { bodyKind: 'json', bodyFields: json }
    } catch {
      const params = new URLSearchParams(body)
      if (Array.from(params.keys()).length > 0) {
        return { bodyKind: 'form', bodyFields: Object.fromEntries(params.entries()) }
      }
    }
  }
  if (body && typeof body === 'object' && !(body instanceof Blob)) {
    return { bodyKind: 'json', bodyFields: body as Record<string, string> }
  }
  return { bodyKind: 'none', bodyFields: {} }
}

function makeRequestSnapshot(
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestSnapshot | null {
  try {
    const request = input instanceof Request ? input : null
    const url = request?.url ?? input.toString()
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const headers = {
      ...snapshotHeaders(request?.headers),
      ...snapshotHeaders(init?.headers),
    }
    const parsed = parseBody(init?.body)
    return { method, url, headers, ...parsed }
  } catch {
    return null
  }
}

export function inferAutoResumeParamMapping(
  keys: string[],
): Record<string, AutoResumeParamSource> {
  const result: Record<string, AutoResumeParamSource> = {}
  for (const key of keys) {
    const lower = key.toLowerCase()
    if (lower.includes('security')) result[key] = 'securityId'
    else if (lower === 'lid' || lower.endsWith('lid')) result[key] = 'lid'
    else if (lower.includes('job')) result[key] = 'jobId'
    else if (lower.includes('encryptboss') || lower.includes('encryptuserid')) {
      result[key] = 'encryptBossId'
    } else if (lower.includes('boss') || lower.includes('uid') || lower.includes('userid')) {
      result[key] = 'bossUid'
    }
  }
  return result
}

function isExcludedLearningUrl(url: URL): boolean {
  return /actionlog|notify|setting|login|heartbeat|collect|trace|log|report/i.test(url.pathname)
}

export function isAutoResumeRequestCandidate(snapshot: RequestSnapshot): boolean {
  try {
    const url = new URL(snapshot.url, location.origin)
    if (url.origin !== location.origin) return false
    if (snapshot.method !== 'POST') return false
    if (isExcludedLearningUrl(url)) return false
    const haystack = [
      url.pathname,
      url.search,
      ...Object.keys(snapshot.bodyFields),
      ...Object.values(snapshot.bodyFields),
    ]
      .join('&')
      .toLowerCase()
    return /resume|jianli|geek\/.*send|send.*geek/.test(haystack)
  } catch {
    return false
  }
}

async function responseLooksSuccessful(response: Response): Promise<boolean> {
  try {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const json = await response.clone().json()
      return response.ok && (json?.code == null || json.code === 0)
    }
    const text = await response.clone().text()
    return response.ok && (text.includes('"code":0') || text.includes('"code": 0'))
  } catch {
    return response.ok
  }
}

async function saveRequestTemplate(snapshot: RequestSnapshot) {
  const url = new URL(snapshot.url, location.origin)
  const queryKeys = Array.from(url.searchParams.keys())
  const bodyKeys = Object.keys(snapshot.bodyFields)
  const keys = [...queryKeys, ...bodyKeys]
  const template: AutoResumeRequestTemplate = {
    method: snapshot.method,
    urlPath: url.pathname,
    queryKeys,
    bodyKind: snapshot.bodyKind,
    bodyKeys,
    contentType: snapshot.headers['content-type'],
    paramMapping: inferAutoResumeParamMapping(keys),
  }
  await counter.storageSet(autoResumeRequestTemplateKey, template)
  return template
}

export async function startAutoResumeApiLearning(timeoutMs = 30_000): Promise<AutoResumeRequestTemplate> {
  const originalFetch = window.fetch.bind(window)
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader

  let settled = false
  let timeoutHandle: ReturnType<typeof setTimeout>

  function restore() {
    if (settled) return
    settled = true
    window.fetch = originalFetch
    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
    XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader
    clearTimeout(timeoutHandle)
  }

  return new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      restore()
      reject(new Error('学习发简历接口超时'))
    }, timeoutMs)

    async function maybeSave(snapshot: RequestSnapshot, success: boolean) {
      if (settled || !success || !isAutoResumeRequestCandidate(snapshot)) return
      const template = await saveRequestTemplate(snapshot)
      restore()
      resolve(template)
    }

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const snapshot = makeRequestSnapshot(input, init)
      const response = await originalFetch(input, init)
      if (snapshot) {
        void responseLooksSuccessful(response).then((success) => maybeSave(snapshot, success))
      }
      return response
    }

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest & { __autoResumeSnapshot?: Partial<RequestSnapshot> },
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ) {
      this.__autoResumeSnapshot = {
        method: method.toUpperCase(),
        url: url.toString(),
        headers: {},
      }
      return originalOpen.call(this, method, url, async ?? true, username, password)
    }

    XMLHttpRequest.prototype.setRequestHeader = function (
      this: XMLHttpRequest & { __autoResumeSnapshot?: Partial<RequestSnapshot> },
      name: string,
      value: string,
    ) {
      this.__autoResumeSnapshot ??= {}
      this.__autoResumeSnapshot.headers ??= {}
      this.__autoResumeSnapshot.headers[name.toLowerCase()] = value
      return originalSetRequestHeader.call(this, name, value)
    }

    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest & { __autoResumeSnapshot?: Partial<RequestSnapshot> },
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      const parsed = parseBody(body)
      const snapshot = {
        method: this.__autoResumeSnapshot?.method ?? 'GET',
        url: this.__autoResumeSnapshot?.url ?? '',
        headers: this.__autoResumeSnapshot?.headers ?? {},
        ...parsed,
      }
      this.addEventListener(
        'loadend',
        () => {
          const success = this.status >= 200 && this.status < 300
          void maybeSave(snapshot, success)
        },
        { once: true },
      )
      return originalSend.call(this, body ?? null)
    }
  })
}

export async function clearAutoResumeApiTemplate() {
  await counter.storageRm(autoResumeRequestTemplateKey)
}

export function initAutoResume() {
  if (initialized) return
  initialized = true
  installUserActivityTracker()
  initBossChatListener()
  subscribeBossChatEvents((event) => {
    void handleBossMessage(event).catch((e) => {
      logger.debug('[AutoResume] handle message failed', e)
    })
  })
}
