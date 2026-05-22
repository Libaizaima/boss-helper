import type { Column } from 'element-plus'
import { ElButton, ElCheckbox, ElCheckboxGroup, ElIcon, ElPopover, ElTag } from 'element-plus'
import { computed, reactive, ref } from 'vue'

import { counter } from '@/message'
import type {
  CompanyNameError,
  CompanySizeError,
  JobDescriptionError,
  JobTitleError,
  PublishError,
  SalaryError,
  UnknownError,
} from '@/types/deliverError'
import type { amapDistance, amapGeocode } from '@/utils/amap'

import type { MyJobListData } from './jobs'

export type logErr =
  | null
  | undefined
  | PublishError
  | JobTitleError
  | CompanyNameError
  | SalaryError
  | CompanySizeError
  | JobDescriptionError
  | UnknownError

export interface logData {
  listData: MyJobListData
  el?: Element
  amap?: {
    geocode?: Awaited<ReturnType<typeof amapGeocode>>
    distance?: Awaited<ReturnType<typeof amapDistance>>
  }
  bossData?: bossZpBossData
  message?: string
  state?: string
  err?: string
  aiFilteringQ?: string
  aiFilteringR?: string | null
  aiFilteringAjson?: object
  aiFilteringAtext?: string
  aiGreetingQ?: string
  aiGreetingR?: string | null
  aiGreetingA?: string
}

type logState = 'info' | 'success' | 'warning' | 'danger'

interface log {
  job?: MyJobListData
  title: string
  state: logState
  state_name: string
  message?: string
  data?: logData
  time?: string
  debug?: string
}

type HeaderCellProps<T> = {
  column: Column<T>
}

/** 可序列化的持久化日志结构（去掉不可序列化的字段） */
interface PersistedLog {
  title: string
  state: logState
  state_name: string
  message?: string
  time?: string
  debug?: string
  job?: {
    jobName?: string
    brandName?: string
    salaryDesc?: string
    encryptJobId?: string
  }
  data?: {
    err?: string
    message?: string
    aiFilteringQ?: string
    aiFilteringAtext?: string
    aiFilteringR?: string | null
    aiGreetingQ?: string
    aiGreetingA?: string
    aiGreetingR?: string | null
  }
}

// storage key 格式: local:log:2026-05-15
const LOG_KEY_PREFIX = 'local:log:'
const MAX_DAYS = 7
const MAX_PER_DAY = 500

function todayKey() {
  return LOG_KEY_PREFIX + new Date().toISOString().slice(0, 10)
}

function toPersistedLog(item: log): PersistedLog {
  return {
    title: item.title,
    state: item.state,
    state_name: item.state_name,
    message: item.message,
    time: item.time,
    debug: item.debug,
    job: item.job
      ? {
          jobName: item.job.jobName,
          brandName: item.job.brandName,
          salaryDesc: item.job.salaryDesc,
          encryptJobId: item.job.encryptJobId,
        }
      : undefined,
    data: item.data
      ? {
          err: item.data.err,
          message: item.data.message,
          aiFilteringQ: item.data.aiFilteringQ,
          aiFilteringAtext: item.data.aiFilteringAtext,
          aiFilteringR: item.data.aiFilteringR,
          aiGreetingQ: item.data.aiGreetingQ,
          aiGreetingA: item.data.aiGreetingA,
          aiGreetingR: item.data.aiGreetingR,
        }
      : undefined,
  }
}

/** 异步追加一条日志到 storage */
async function persistLog(item: log) {
  try {
    const key = todayKey()
    const existing = await counter.storageGet<PersistedLog[]>(key, [])
    existing.push(toPersistedLog(item))
    // 每天最多保留 MAX_PER_DAY 条，超出时删最旧的
    if (existing.length > MAX_PER_DAY) {
      existing.splice(0, existing.length - MAX_PER_DAY)
    }
    await counter.storageSet(key, existing)
  } catch {
    // storage 写入失败不影响主流程
  }
}

/** 清理超过 MAX_DAYS 天的旧日志 */
async function cleanOldLogs() {
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - MAX_DAYS)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    // 无法直接枚举 storage keys，用已知日期范围删除
    for (let i = MAX_DAYS + 1; i <= MAX_DAYS + 30; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = LOG_KEY_PREFIX + d.toISOString().slice(0, 10)
      try {
        await counter.storageSet(key, null as any)
      } catch {}
    }
    void cutoffStr // suppress unused warning
  } catch {}
}

/** 加载指定日期的持久化日志（转回内存格式） */
function fromPersistedLog(p: PersistedLog): log {
  return {
    title: p.title,
    state: p.state,
    state_name: p.state_name,
    message: p.message,
    time: p.time,
    debug: p.debug,
    job: p.job as any,
    data: p.data
      ? ({
          listData: { jobName: p.job?.jobName, brandName: p.job?.brandName } as any,
          err: p.data.err,
          message: p.data.message,
          aiFilteringQ: p.data.aiFilteringQ,
          aiFilteringAtext: p.data.aiFilteringAtext,
          aiFilteringR: p.data.aiFilteringR,
          aiGreetingQ: p.data.aiGreetingQ,
          aiGreetingA: p.data.aiGreetingA,
          aiGreetingR: p.data.aiGreetingR,
        } as logData)
      : undefined,
  }
}

const dialogData = reactive<{ show: boolean; data?: log }>({ show: false })

const data = ref<log[]>([])

const stateNames: [logState, string][] = [
  ['info', '消息'],
  ['success', '投递成功'],
  ['warning', '重复沟通'],
  ['warning', '岗位名筛选'],
  ['warning', '公司名筛选'],
  ['warning', '薪资筛选'],
  ['warning', '公司规模筛选'],
  ['warning', '工作内容筛选'],
  ['warning', 'Hr职位筛选'],
  ['warning', 'AI筛选'],
  ['warning', '好友状态'],
  ['warning', '活跃度过滤'],
  ['warning', '猎头过滤'],
  ['danger', '未知错误'],
  ['danger', '投递出错'],
  ['danger', '打招呼出错'],
]

const filterStatus = ref(stateNames.map((item) => item[1]))

const filterData = computed(() => {
  if (filterStatus.value.length !== stateNames.length) {
    return data.value.filter((item) => filterStatus.value.includes(item.state_name))
  }
  return data.value
})

const columns: Column<log>[] = [
  {
    key: 'title',
    title: '标题',
    dataKey: 'title',
    width: 200,
    cellRenderer: ({ rowData }) => (
      <a
        onClick={() => {
          dialogData.show = true
          dialogData.data = rowData
        }}
      >
        {rowData.title}
      </a>
    ),
  },
  {
    key: 'state',
    title: '状态',
    width: 150,
    align: 'center',
    cellRenderer: ({ rowData }) => (
      <ElTag type={rowData.state ?? 'primary'}>{rowData.state_name}</ElTag>
    ),
    headerCellRenderer: (props: HeaderCellProps<log>) => {
      return (
        <div class="flex items-center justify-center">
          <span class="mr-2 text-xs">{props.column.title}</span>
          <ElPopover trigger="click" {...{ width: 200 }}>
            {{
              default: () => (
                <div class="filter-wrapper">
                  <ElCheckboxGroup v-model={filterStatus.value}>
                    {stateNames.map((item) => (
                      <ElCheckbox value={item[1]}>
                        <ElTag type={item[0]}>{item[1]}</ElTag>
                      </ElCheckbox>
                    ))}
                  </ElCheckboxGroup>
                  <div class="el-table-v2__demo-filter">
                    <ElButton
                      text
                      onClick={() => {
                        filterStatus.value = stateNames
                          .map((item) => item[1])
                          .filter((status) => !filterStatus.value.includes(status))
                      }}
                    >
                      反选
                    </ElButton>
                  </div>
                </div>
              ),
              reference: () => (
                <ElIcon class="cursor-pointer">
                  <svg
                    class="icon"
                    viewBox="0 0 1024 1024"
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    p-id="2612"
                    width="200"
                    height="200"
                  >
                    <path
                      d="M608.241895 960.010751c-17.717453 0-31.994625-14.277171-31.994625-31.994625l0-479.919368c0-7.912649 2.92424-15.653284 8.256677-21.501764l208.82513-234.455233L230.498908 192.139761l209.169158 234.627247c5.160423 5.84848 8.084663 13.417101 8.084663 21.32975l0 288.811692 50.916177 41.111372c13.761129 11.180917 15.825298 31.306568 4.816395 45.067697s-31.306568 15.825298-45.067697 4.816395L395.632454 776.815723c-7.568621-6.020494-11.868974-15.309256-11.868974-24.942046L383.763481 460.137746 135.203091 181.302873c-8.428691-9.460776-10.492861-22.877877-5.332437-34.402822 5.160423-11.524945 16.685369-18.921552 29.242399-18.921552l706.289938 0c12.729044 0 24.081975 7.396607 29.242399 19.093566 5.160423 11.524945 2.92424 25.11406-5.504452 34.402822L640.236519 460.30976l0 467.706367C640.236519 945.73358 625.959348 960.010751 608.241895 960.010751z"
                      fill="#575B66"
                      p-id="2613"
                    ></path>
                  </svg>
                </ElIcon>
              ),
            }}
          </ElPopover>
        </div>
      )
    },
  },
  {
    key: 'message',
    title: '信息',
    dataKey: 'message',
    width: 360,
    minWidth: 360,
    align: 'left',
  },
]

export function useLog() {
  /** 初始化：从 storage 加载今天的日志 */
  async function init() {
    try {
      const key = todayKey()
      const saved = await counter.storageGet<PersistedLog[]>(key, [])
      if (saved.length > 0 && data.value.length === 0) {
        data.value = saved.map(fromPersistedLog)
      }
      // 异步清理旧日志
      void cleanOldLogs()
    } catch {}
  }

  const add = (job: MyJobListData, err: logErr, logdata?: logData, msg?: string) => {
    const state = !err ? 'success' : err.state
    const message = msg ?? (err ? err.message : undefined)
    const item: log = {
      job,
      title: job.jobName,
      state,
      state_name: err?.name ?? '投递成功',
      message,
      data: logdata,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      debug: err
        ? `Error: ${err.name}\nMessage: ${err.message}\nStack: ${err.stack ?? '(无)'}`
        : undefined,
    }
    data.value.push(item)
    void persistLog(item)
  }

  const info = (title: string, message: string, debug?: string) => {
    const item: log = {
      title,
      state: 'info',
      state_name: '消息',
      message,
      data: undefined,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      debug,
    }
    data.value.push(item)
    void persistLog(item)
  }

  const debug = (title: string, message: string, payload?: any) => {
    let dbg: string | undefined
    if (payload != null) {
      try {
        dbg = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
      } catch {
        dbg = String(payload)
      }
    }
    const item: log = {
      title,
      state: 'info',
      state_name: '消息',
      message,
      data: undefined,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      debug: dbg,
    }
    data.value.push(item)
    void persistLog(item)
  }

  const clear = () => {
    data.value = []
    // 同时清除今天的 storage
    void counter.storageSet(todayKey(), [])
  }

  /** 加载指定日期的历史日志（格式 2026-05-15） */
  const loadDate = async (dateStr: string) => {
    const key = LOG_KEY_PREFIX + dateStr
    const saved = await counter.storageGet<PersistedLog[]>(key, [])
    data.value = saved.map(fromPersistedLog)
  }

  /** 获取有日志记录的日期列表（最近 MAX_DAYS 天） */
  const getAvailableDates = async (): Promise<string[]> => {
    const dates: string[] = []
    for (let i = 0; i < MAX_DAYS; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().slice(0, 10)
      const key = LOG_KEY_PREFIX + dateStr
      const saved = await counter.storageGet<PersistedLog[]>(key, [])
      if (saved.length > 0) {
        dates.push(dateStr)
      }
    }
    return dates
  }

  const exportText = () => {
    return data.value
      .map((item) => {
        const lines: string[] = []
        lines.push('===========')
        if (item.time) lines.push(`[时间] ${item.time}`)
        lines.push(`[状态] ${item.state_name}`)
        lines.push(`[标题] ${item.title}`)
        if (item.message) lines.push(`[信息] ${item.message}`)
        if (item.job?.brandName) lines.push(`[公司] ${item.job.brandName}`)
        if (item.job?.salaryDesc) lines.push(`[薪资] ${item.job.salaryDesc}`)
        if (item.data?.aiGreetingQ) lines.push(`[AI招呼Prompt]\n${item.data.aiGreetingQ}`)
        if (item.data?.aiGreetingA) lines.push(`[AI招呼回答]\n${item.data.aiGreetingA}`)
        if (item.data?.aiFilteringQ) lines.push(`[AI筛选Prompt]\n${item.data.aiFilteringQ}`)
        if (item.data?.aiFilteringAtext) lines.push(`[AI筛选回答]\n${item.data.aiFilteringAtext}`)
        if (item.data?.err) lines.push(`[错误详情]\n${item.data.err}`)
        if (item.debug) lines.push(`[调试信息]\n${item.debug}`)
        return lines.join('\n')
      })
      .join('\n\n')
  }

  return {
    columns,
    data,
    filterData,
    init,
    clear,
    add,
    info,
    debug,
    exportText,
    loadDate,
    getAvailableDates,
    dialogData,
  }
}

window.__q_log = data
;(window as any).__q_useLog = useLog
