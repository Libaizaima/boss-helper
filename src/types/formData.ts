import type { prompt } from '@/composables/useModel/type'

export interface Statistics {
  date: string
  success: number
  total: number
  company: number
  jobTitle: number
  jobContent: number
  hrPosition: number
  jobAddress: number
  salaryRange: number
  amap: number
  companySizeRange: number
  activityFilter: number
  goldHunterFilter: number
  repeat: number
  /** 打招呼未确认次数（ACK 超时 / 渠道不可验证 / cmid 冲突）。可选以兼容旧存档。 */
  greetUnverified?: number
  /** 打招呼明确失败次数（服务端拒绝 / 渠道异常 / 无渠道 / EventBus 失败）。可选以兼容旧存档。 */
  greetRejected?: number
}
const ConfigLevels = ['beginner', 'intermediate', 'advanced', 'expert'] as const
export type ConfigLevel = (typeof ConfigLevels)[number]

export interface FormData {
  config_level: ConfigLevel
  company: FormDataSelect
  jobTitle: FormDataSelect
  jobContent: FormDataSelect
  hrPosition: FormDataSelect
  jobAddress: Omit<FormDataSelect, 'include'>
  salaryRange: FormSalaryRangeInput
  companySizeRange: FormDataRangeInput
  customGreeting: FormDataInput
  deliveryLimit: FormDataInputNumber
  greetingVariable: FormDataCheckbox
  activityFilter: FormDataCheckbox
  friendStatus: FormDataCheckbox
  sameCompanyFilter: FormDataCheckbox
  sameHrFilter: FormDataCheckbox
  goldHunterFilter: FormDataCheckbox
  notification: FormDataCheckbox
  useCache: FormDataCheckbox
  aiGreeting: FormDataAi
  aiFiltering: FormDataAi & { score: number }
  aiReply: FormDataAi
  autoResume: FormAutoResume
  amap: {
    key: string
    origins: string
    straightDistance: number
    drivingDistance: number
    drivingDuration: number
    walkingDistance: number
    walkingDuration: number
    enable: boolean
  }
  record: { model?: string[]; enable: boolean }
  // animation?: "frame" | "card" | "together";
  delay: ConfDelay
  /**
   * ACK 等待超时（毫秒）。`Message.send` 会把该值 clamp 到 [1000, 15000]。
   * 默认 5000。可选以兼容旧存档（缺省时 handles.ts 回落 5000）。
   */
  greetingAckTimeoutMs?: number
  version: string
  userId?: number | string
}

export type FormInfoData = {
  [key in keyof Omit<
    FormData,
    | 'config_level'
    | 'aiGreeting'
    | 'aiFiltering'
    | 'aiReply'
    | 'autoResume'
    | 'delay'
    | 'userId'
    | 'version'
    | 'amap'
  >]: {
    label: string
    'data-help'?: string
  }
} & {
  config_level: { options: Array<{ value: ConfigLevel; label: string }>; 'data-help'?: string }
  aiGreeting: FormInfoAi
  aiFiltering: FormInfoAi
  aiReply: FormInfoAi
  delay: ConfInfoDelay
  amap: {
    [key in keyof FormData['amap']]: {
      label: string
      'data-help'?: string
    }
  }
}

export interface FormInfoAi {
  label: string
  'data-help'?: string
  example: [string, prompt]
}

export interface FormDataSelect {
  include: boolean
  value: string[]
  options: string[]
  enable: boolean
}

export interface FormDataInput {
  value: string
  enable: boolean
}

export type FormDataRange = [number, number, boolean]

export interface FormDataRangeInput {
  value: FormDataRange
  enable: boolean
}

export interface FormSalaryRangeInput {
  // 宽松/严格 默认宽松false
  value: FormDataRange // 8-13K
  advancedValue: {
    H: FormDataRange // 45-75元/时
    D: FormDataRange // 360-600元/天
    M: FormDataRange // 8000-13000元/月
  }
  enable: boolean
}

export interface FormDataInputNumber {
  value: number
}

export interface FormDataCheckbox {
  value: boolean
}

export interface FormDataAi {
  model?: string
  vip?: boolean
  prompt: string | prompt
  enable: boolean
}

export interface FormAutoResume {
  enable: boolean
  replyAfterGreeting: boolean
  allowIncomingBoss: boolean
  incomingKeywordOnly: boolean
  keywords: string[]
  delayMinSec: number
  delayMaxSec: number
  requirePageVisible: boolean
  requireUserIdleSec: number
  preferLearnedApi: boolean
  fallbackClick: boolean
}

interface ConfDelay {
  deliveryStarts: number
  deliveryInterval: number
  deliveryPageNext: number
  messageSending: number
}

type ConfInfoDelay = {
  [Key in keyof ConfDelay]: {
    label: string
    'data-help'?: string
    disable?: boolean
  }
}
