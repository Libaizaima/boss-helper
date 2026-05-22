import { describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/user', () => ({
  useUser: () => ({ getUserId: () => '200' }),
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => ({ formData: { autoResume: {}, aiReply: {} } }),
}))

vi.mock('@/message', () => ({
  counter: {
    storageGet: vi.fn(),
    storageSet: vi.fn(),
    storageRm: vi.fn(),
  },
}))

vi.mock('@/composables/useApplying/utils', () => ({
  requestBossData: vi.fn(),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

import { toBossChatEvent } from '@/composables/useChatListener'
import {
  inferAutoResumeParamMapping,
  isAutoResumeKeywordMatched,
  isAutoResumeRequestCandidate,
} from '@/composables/useAutoResume'

describe('chat listener normalization', () => {
  it('normalizes a boss text message sent to the current user', () => {
    const event = toBossChatEvent(
      {
        from: { uid: '100' },
        to: { uid: '200' },
        mid: 'm-1',
        body: { type: 1, text: '方便发一份简历吗' },
      },
      '200',
    )

    expect(event).toMatchObject({
      fromUid: '100',
      toUid: '200',
      myUid: '200',
      text: '方便发一份简历吗',
      isFromBoss: true,
      isFromMe: false,
      hasResume: false,
      hasResumeShare: false,
    })
  })

  it('recognizes self-sent resume share messages', () => {
    const event = toBossChatEvent(
      {
        from: { uid: '200' },
        to: { uid: '100' },
        body: { type: 19, resumeShare: { id: 'r-1' } },
      },
      '200',
    )

    expect(event).toMatchObject({
      fromUid: '200',
      toUid: '100',
      isFromMe: true,
      hasResumeShare: true,
    })
  })

  it('drops messages without both user ids as system messages', () => {
    expect(toBossChatEvent({ body: { type: 1, text: 'notice' } }, '200')).toBeNull()
  })
})

describe('auto resume helpers', () => {
  it('matches configured resume keywords', () => {
    expect(isAutoResumeKeywordMatched('可以先发一份资料我看看', ['简历', '资料'])).toBe(true)
    expect(isAutoResumeKeywordMatched('你好，在吗', ['简历', '资料'])).toBe(false)
  })

  it('infers dynamic parameter mappings from request keys', () => {
    expect(
      inferAutoResumeParamMapping(['securityId', 'jobId', 'bossId', 'lid', 'encryptBossId']),
    ).toEqual({
      securityId: 'securityId',
      jobId: 'jobId',
      bossId: 'bossUid',
      lid: 'lid',
      encryptBossId: 'encryptBossId',
    })
  })

  it('accepts likely resume send requests and rejects telemetry', () => {
    expect(
      isAutoResumeRequestCandidate({
        method: 'POST',
        url: `${location.origin}/wapi/zpgeek/resume/send.json`,
        headers: {},
        bodyKind: 'form',
        bodyFields: { securityId: 'sec', jobId: 'job' },
      }),
    ).toBe(true)

    expect(
      isAutoResumeRequestCandidate({
        method: 'POST',
        url: `${location.origin}/wapi/zpCommon/actionLog/geek/chatremind.json`,
        headers: {},
        bodyKind: 'form',
        bodyFields: { resume: '1' },
      }),
    ).toBe(false)
  })
})
