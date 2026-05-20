<script lang="ts" setup>
import {
  ElAlert,
  ElButton,
  ElButtonGroup,
  ElCol,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElIcon,
  ElMessage,
  ElProgress,
  ElRow,
  ElStatistic,
} from 'element-plus'
import { computed, onMounted, ref } from 'vue'

import Alert from '@/components/Alert'
import { useCommon } from '@/composables/useCommon'
import { useStatistics } from '@/composables/useStatistics'
import { useConf } from '@/stores/conf'
import { jobList } from '@/stores/jobs'
import { useLog } from '@/stores/log'
import { delay, notification } from '@/utils'
import { logger } from '@/utils/logger'

import { useDeliver } from '../hooks/useDeliver'
import { usePager } from '../hooks/usePager'

const log = useLog()
const statistics = useStatistics()
const common = useCommon()
const deliver = useDeliver()
const { next, page } = usePager()
const conf = useConf()
const statisticCycle = ref(1)
const statisticCycleData = [
  {
    label: '近三日投递',
    help: '愿你每一次投递都能得到回应',
    date: 3,
  },
  {
    label: '本周投递',
    help: '愿你早日找到心满意足的工作',
    date: 7,
  },
  {
    label: '本月投递',
    help: '愿你在面试中得到满意的结果',
    date: 30,
  },
  {
    label: '历史投递',
    help: '愿你能早九晚五还双休带五险',
    date: -1,
  },
]

const cycle = computed(() => {
  const date = statisticCycleData[statisticCycle.value].date
  let ans = 0
  for (
    let i = 0;
    // eslint-disable-next-line no-unmodified-loop-condition
    (date === -1 || i < date - 1) && i < statistics.statisticsData.length;
    i++
  ) {
    ans += statistics.statisticsData[i].success
  }
  return ans
})

const deliveryLimit = computed(() => {
  return conf.formData.deliveryLimit.value
})
function stopDeliver() {
  common.deliverStop = true
}
async function startBatch() {
  common.deliverLock = true
  common.deliverStop = false
  let stepMsg = '投递结束'
  try {
    logger.debug('start batch', page)
    let oldLen = 0
    let oldFirstJobId = ''
    while (!common.deliverStop) {
      await delay(conf.formData.delay.deliveryStarts)
      if (jobList._list.value.length === 0) {
        stepMsg = '投递结束, job列表为空'
        break
      }
      const currentFirstJobId = jobList._list.value[0]?.encryptJobId ?? ''
      if (
        (location.href.includes('/web/geek/job-recommend') ||
          location.href.includes('/web/geek/jobs')) &&
        oldLen === jobList._list.value.length &&
        oldFirstJobId === currentFirstJobId
      ) {
        stepMsg = '投递结束, 未能获取更多岗位(job列表无变化)'
        break
      }
      oldLen = jobList._list.value.length
      oldFirstJobId = currentFirstJobId
      await deliver.jobListHandle()
      if (common.deliverStop) {
        break
      }
      await delay(conf.formData.delay.deliveryPageNext)
      if (!next()) {
        stepMsg = '投递结束, 无法继续下一页'
        break
      }
    }
  } catch (e) {
    logger.error('获取失败', e)
    stepMsg = `获取失败! - ${e}`
  } finally {
    logger.debug('日志信息', log.data)
    conf.formData.notification.value && (await notification(stepMsg))
    ElMessage.info(stepMsg)
    common.deliverLock = false
  }
}

function resetFilter() {
  jobList._list.value.forEach((v) => {
    switch (v.status.status) {
      case 'success':
        break
      case 'pending':
      case 'wait':
      case 'running':
      case 'error':
      case 'warn':
      default:
        v.status.setStatus('wait', '等待中')
    }
  })
}

const filterPercentage = computed(() => {
  if (!statistics.todayData.total) return 0
  const filtered = statistics.todayData.total - statistics.todayData.success
  return Math.round((filtered / statistics.todayData.total) * 100)
})

const repeatPercentage = computed(() => {
  if (!statistics.todayData.total) return 0
  return Math.round((statistics.todayData.repeat / statistics.todayData.total) * 100)
})

const activePercentage = computed(() => {
  if (!statistics.todayData.total) return 0
  return Math.round((statistics.todayData.activityFilter / statistics.todayData.total) * 100)
})

onMounted(() => {
  statistics.updateStatistics()
})
</script>

<template>
  <Alert
    id="config-statistics"
    style="margin-bottom: 16px"
    title="数据并不完全准确，投递上限根据自身情况调整，建议 120-140，boss 限制最高 150"
    type="warning"
  />

  <div class="statistics-card">
    <div class="card-title">投递进度概览</div>

    <div class="metrics-grid">
      <!-- 岗位总数 -->
      <div class="metric-item" data-help="统计当天脚本扫描过的所有岗位">
        <div class="metric-icon-wrapper blue-bg">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
          </svg>
        </div>
        <div class="metric-info">
          <span class="metric-label">岗位总数</span>
          <span class="metric-value">{{ statistics.todayData.total }}</span>
        </div>
      </div>

      <!-- 过滤比例 -->
      <div class="metric-item" data-help="统计当天岗位过滤的比例,被过滤/总数">
        <div class="metric-icon-wrapper green-bg">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
          </svg>
        </div>
        <div class="metric-info">
          <span class="metric-label">过滤比例</span>
          <span class="metric-value">{{ filterPercentage }}%</span>
        </div>
      </div>

      <!-- 沟通比例 -->
      <div class="metric-item" data-help="统计当天岗位中已沟通的比例,已沟通/总数">
        <div class="metric-icon-wrapper purple-bg">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <div class="metric-info">
          <span class="metric-label">沟通比例</span>
          <span class="metric-value">{{ repeatPercentage }}%</span>
        </div>
      </div>

      <!-- 活跃比例 -->
      <div class="metric-item" data-help="统计当天岗位中的活跃情况,不活跃/总数">
        <div class="metric-icon-wrapper orange-bg">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
            ></path>
          </svg>
        </div>
        <div class="metric-info">
          <span class="metric-label">活跃比例</span>
          <span class="metric-value">{{ activePercentage }}%</span>
        </div>
      </div>

      <!-- 周期投递 (e.g. 本周投递) -->
      <div class="metric-item" :data-help="statisticCycleData[statisticCycle].help">
        <div class="metric-icon-wrapper blue-bg">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </div>
        <div class="metric-info">
          <span class="metric-label-dropdown">
            <ElDropdown
              trigger="click"
              @command="
                (arg) => {
                  statisticCycle = arg
                }
              "
            >
              <span class="el-dropdown-link">
                {{ statisticCycleData[statisticCycle].label }}
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  style="margin-left: 2px"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </span>
              <template #dropdown>
                <ElDropdownMenu>
                  <ElDropdownItem
                    v-for="(item, index) in statisticCycleData"
                    :key="index"
                    :command="index"
                  >
                    {{ item.label }}
                  </ElDropdownItem>
                </ElDropdownMenu>
              </template>
            </ElDropdown>
          </span>
          <span class="metric-value">{{ cycle + statistics.todayData.success }}</span>
        </div>
      </div>
    </div>

    <!-- Progress Bar -->
    <div class="progress-section">
      <ElProgress
        :percentage="Number(((statistics.todayData.success / deliveryLimit) * 100).toFixed(1))"
        :stroke-width="8"
        class="custom-progress"
      />
    </div>

    <!-- Actions -->
    <div class="actions-section">
      <ElButton
        type="primary"
        size="large"
        class="action-btn start-btn"
        :loading="common.deliverLock"
        @click="startBatch"
      >
        <template #icon>
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </template>
        {{ common.deliverLock ? '正在投递' : '开始投递' }}
      </ElButton>

      <ElButton
        v-if="common.deliverLock && !common.deliverStop"
        type="warning"
        size="large"
        class="action-btn pause-btn"
        @click="stopDeliver"
      >
        <template #icon>
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="6" y="4" width="4" height="16"></rect>
            <rect x="14" y="4" width="4" height="16"></rect>
          </svg>
        </template>
        暂停投递
      </ElButton>

      <ElButton
        v-if="!common.deliverLock && common.deliverStop"
        type="default"
        size="large"
        class="action-btn reset-btn"
        @click="resetFilter"
      >
        <template #icon>
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
          </svg>
        </template>
        重置筛选
      </ElButton>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.statistics-card {
  background: #ffffff;
  padding: 4px 0 0;

  .card-title {
    font-size: 15px;
    font-weight: 700;
    color: #1e293b;
    margin-bottom: 20px;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }

  .metric-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 8px;
    background: #f8fafc;
    border: 1px solid #f1f5f9;

    .metric-icon-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;

      &.blue-bg {
        background: #eff6ff;
        color: #2563eb;
      }
      &.green-bg {
        background: #f0fdf4;
        color: #16a34a;
      }
      &.purple-bg {
        background: #faf5ff;
        color: #9333ea;
      }
      &.orange-bg {
        background: #fff7ed;
        color: #ea580c;
      }
    }

    .metric-info {
      display: flex;
      flex-direction: column;

      .metric-label {
        font-size: 12px;
        color: #64748b;
        font-weight: 500;
      }

      .metric-label-dropdown {
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;

        .el-dropdown-link {
          display: flex;
          align-items: center;
          gap: 2px;
          color: #64748b;
          font-size: 12px;
        }
      }

      .metric-value {
        font-size: 20px;
        font-weight: 700;
        color: #0f172a;
        margin-top: 2px;
      }
    }
  }

  .progress-section {
    margin-bottom: 24px;

    :deep(.ehp-progress-bar__inner) {
      background-color: #2563eb;
    }
    :deep(.ehp-progress__text) {
      font-weight: 600;
      color: #1e293b;
    }
  }

  .actions-section {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;

    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      padding: 10px 20px;
      border-radius: 8px;
      height: 40px;
      font-size: 14px;
      border-width: 1px;

      &.start-btn {
        background-color: #2563eb;
        border-color: #2563eb;
        color: #ffffff;
        &:hover {
          background-color: #1d4ed8;
          border-color: #1d4ed8;
        }
      }

      &.reset-btn {
        background-color: #ffffff;
        border-color: #2563eb;
        color: #2563eb;
        &:hover {
          background-color: #eff6ff;
        }
      }

      &.pause-btn {
        background-color: #f59e0b;
        border-color: #f59e0b;
        color: #ffffff;
        &:hover {
          background-color: #d97706;
        }
      }
    }
  }
}
</style>
