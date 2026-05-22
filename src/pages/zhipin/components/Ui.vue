<script lang="ts" setup>
import { useMouse, useMouseInElement } from '@vueuse/core'
import {
  ElBadge,
  ElCheckbox,
  ElConfigProvider,
  ElLink,
  ElMessage,
  ElTabPane,
  ElTabs,
  ElTag,
  ElText,
  ElTooltip,
} from 'element-plus'
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { useCommon } from '@/composables/useCommon'
import { useModel } from '@/composables/useModel'
import { useStatistics } from '@/composables/useStatistics'
import { useConf } from '@/stores/conf'
import { jobList } from '@/stores/jobs'
import { useSignedKey } from '@/stores/signedKey'
import { useUser } from '@/stores/user'
import elmGetter from '@/utils/elmGetter'
import { logger } from '@/utils/logger'

import { useDeliver } from '../hooks/useDeliver'
import { usePager } from '../hooks/usePager'
import About from './About.vue'
import Ai from './Ai.vue'
import Card from './Card.vue'
import Config from './Config.vue'
import Logs from './Logs.vue'
import Service from './Service.vue'
import Statistics from './Statistics.vue'

const user = useUser()
const model = useModel()
const signedKey = useSignedKey()
const { initPager } = usePager()
const { x, y } = useMouse({ type: 'client' })
const { todayData } = useStatistics()
const conf = useConf()
const common = useCommon()
const deliver = useDeliver()

const helpVisible = computed({
  get: () => common.helpVisible,
  set: (val) => {
    common.helpVisible = val
  },
})
const searchRef = ref()
const tabsRef = ref()
const helpContent = ref('鼠标移到对应元素查看提示')
const { isOutside } = useMouseInElement(tabsRef)

const triggerRef = computed(() => {
  return {
    getBoundingClientRect() {
      return DOMRect.fromRect({
        width: 0,
        height: 0,
        x: x.value,
        y: y.value,
      })
    },
  }
})

const boxStyles = computed(() => {
  if (helpVisible.value && !isOutside.value) {
    const element = document.elementFromPoint(x.value, y.value)
    const el = findHelp(element as HTMLElement)
    if (el) {
      const bounding = el.getBoundingClientRect()
      return {
        width: `${bounding.width}px`,
        height: `${bounding.height}px`,
        left: `${bounding.left}px`,
        top: `${bounding.top}px`,
        display: 'block',
        backgroundColor: '#3eaf7c33',
        transition: 'all 0.08s linear',
      } as Record<string, string | number>
    }
  }
  return {
    display: 'none',
  }
})

function findHelp(dom: HTMLElement | null) {
  if (!dom) return
  const help = dom.dataset.help
  if (help) {
    helpContent.value = help
    return dom
  }
  return findHelp(dom.parentElement)
}

onMounted(async () => {
  void conf.confInit()
  void user.initUser()
  void user.initCookie()
  void model.initModel()
  void signedKey.initSignedKey()
  try {
    await jobList.initJobList(conf.formData)
  } catch (e) {
    logger.error('初始化职位列表失败', { error: e })
    ElMessage.error(`列表初始失败: ${e instanceof Error ? e.message : '未知错误'}`)
  }

  if (location.href.includes('/web/geek/job-recommend')) {
    elmGetter.get<HTMLDivElement>('.job-recommend-search').then((searchEl) => {
      searchEl.style.position = 'unset'
      searchRef.value.$el.appendChild(searchEl)
    })
  } else if (location.href.includes('/web/geek/jobs')) {
    const div = document.createElement('div')
    div.style.cssText = 'display: flex;flex-direction: column;gap: 15px;'
    searchRef.value.$el.appendChild(div)
    elmGetter
      .get<HTMLDivElement>([
        '.page-jobs-main .expect-and-search',
        '.page-jobs-main .filter-condition',
      ])
      .then(([searchEl, conditionEl]) => {
        searchEl.style.position = 'static'
        conditionEl.style.position = 'static'
        div.appendChild(conditionEl)
        elmGetter
          .get(['.c-search-input', '.c-expect-select'], searchEl)
          .then(([searchInputEl, expectSelectEl]) => {
            div.insertBefore(searchInputEl, conditionEl)
            div.insertBefore(expectSelectEl, conditionEl)
            searchEl.style.display = 'none'
          })
      })
  } else {
    elmGetter
      .get([
        '.job-search-wrapper .job-search-box.clearfix',
        '.job-search-wrapper .search-condition-wrapper.clearfix',
      ])
      .then(([searchEl, conditionEl]) => {
        searchRef.value.$el.appendChild(searchEl)
        searchRef.value.$el.appendChild(conditionEl)
        // 搜索栏去APP
        elmGetter.rm('.job-search-scan', searchEl)
      })
  }

  initPager().catch((e) => {
    logger.error('初始化分页器失败', { error: e })
    ElMessage.error(`分页器初始失败: ${e instanceof Error ? e.message : '未知错误'}`)
  })

  const t = setInterval(
    () => {
      void signedKey.refreshSignedKeyInfo()
    },
    1000 * 60 * 20,
  )
  onUnmounted(() => {
    clearInterval(t)
  })
})

function tagOpen(url: string) {
  window.open(url)
}
const VITE_VERSION = __APP_VERSION__

const isDot = computed(() => {
  return (signedKey.netConf?.version ?? '0') > VITE_VERSION
})

function openStore() {
  window.__q_openStore?.()
}
</script>

<template>
  <ElConfigProvider namespace="ehp">
    <div class="boss-helper-header">
      <div class="header-left">
        <span class="header-logo">Helper</span>
        <ElBadge :is-dot="isDot" :offset="[-2, 7]" class="version-badge" @click="openStore">
          <ElTag class="version-tag" type="primary">
            v{{ VITE_VERSION }}{{ isDot ? ' 有更新' : '' }}
          </ElTag>
        </ElBadge>
      </div>
      <div v-if="todayData.total > 0" class="header-right-badges">
        <span class="header-badge deliver-badge">
          今日投递 {{ todayData.success }}/{{ conf.formData.deliveryLimit.value }}
        </span>
      </div>
    </div>
    <div
      style="z-index: 999; position: fixed; pointer-events: none; border-width: 1px"
      :style="boxStyles"
    />
    <div v-if="signedKey.netConf && signedKey.netConf.notification" class="netAlerts">
      <template
        v-for="item in signedKey.netConf.notification.filter((item) => item.type === 'alert')"
        :key="item.key ?? item.data.title"
      >
        <!-- <ElAlert
        v-if="now > GM_getValue(`netConf-${item.key}`, 0)"
        v-bind="item.data"
        @close="GM_setValue(`netConf-${item.key}`, now + 259200000)"
      /> -->
      </template>
    </div>
    <ElTooltip virtual-triggering :visible="helpVisible && !isOutside" :virtual-ref="triggerRef">
      <template #content>
        <div :style="`width: auto;max-width:${boxStyles.width};font-size:17px;`">
          {{ helpContent }}
        </div>
      </template>
    </ElTooltip>
    <ElTabs ref="tabsRef" data-help="鼠标移到对应元素查看提示" class="custom-app-tabs">
      <ElTabPane label="统计" data-help="失败是成功她妈">
        <template #label>
          <span class="custom-tab-label">
            <svg
              class="tab-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="20" x2="18" y2="10"></line>
              <line x1="12" y1="20" x2="12" y2="4"></line>
              <line x1="6" y1="20" x2="6" y2="14"></line>
            </svg>
            <span>统计</span>
          </span>
        </template>
        <Statistics />
      </ElTabPane>
      <ElTabPane ref="searchRef" label="筛选">
        <template #label>
          <span class="custom-tab-label">
            <svg
              class="tab-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
            </svg>
            <span>筛选</span>
          </span>
        </template>
      </ElTabPane>
      <ElTabPane label="配置" data-help="好好看，好好学">
        <template #label>
          <span class="custom-tab-label">
            <svg
              class="tab-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="3"></circle>
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
              ></path>
            </svg>
            <span>配置</span>
          </span>
        </template>
        <Config />
      </ElTabPane>
      <ElTabPane v-if="conf.config_level.advanced" label="AI" data-help="AI时代，脚本怎么能落伍!">
        <template #label>
          <span class="custom-tab-label">
            <svg
              class="tab-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
              ></path>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
              <line x1="12" y1="22.08" x2="12" y2="12"></line>
            </svg>
            <span>AI</span>
          </span>
        </template>
        <Service v-if="signedKey.signedKey" />
        <Ai v-else />
      </ElTabPane>
      <ElTabPane label="日志" data-help="反正你也不看">
        <template #label>
          <span class="custom-tab-label">
            <svg
              class="tab-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
              <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            <span>日志</span>
          </span>
        </template>
        <Logs />
      </ElTabPane>
      <ElTabPane label="关于" data-help="项目信息与反馈入口">
        <template #label>
          <span class="custom-tab-label">
            <svg
              class="tab-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
            <span>关于</span>
          </span>
        </template>
        <About />
      </ElTabPane>

      <ElTabPane v-if="signedKey.netConf && signedKey.netConf.feedback">
        <template #label>
          <span class="custom-tab-label" @click.stop="tagOpen(signedKey.netConf.feedback)">
            <svg
              class="tab-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
            <span>反馈</span>
          </span>
        </template>
      </ElTabPane>
      <ElTabPane>
        <template #label>
          <span class="custom-tab-label" @click.stop="helpVisible = !helpVisible">
            <svg
              class="tab-icon"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span>帮助</span>
          </span>
        </template>
        我去, 给你发现小彩蛋了哇! 不过这里啥都没有, 但还是要谢谢你来查看帮助. 虽然点歪了一些些...
        <br />
        文案不理解的可以提供建议进行调整
      </ElTabPane>
    </ElTabs>
    <Teleport to="#boss-helper-job-warp,.page-job-inner .page-job-content">
      <Card />
    </Teleport>
    <!-- <Teleport to=".page-job-wrapper">
    <chatVue
      style="
        position: fixed;
        top: 70px;
        left: 20px;
        height: calc(100vh - 80px);
        display: flex;
        flex-direction: column;
        width: 28%;
        max-width: 540px;
      "
    />
  </Teleport> -->
  </ElConfigProvider>
</template>

<style lang="scss">
#boss-helper-job {
  margin-bottom: 8px;
  *:not(.ehp-tab-pane *) {
    user-select: none;
  }
}

.ehp-checkbox {
  color: #5e5e5e;
  &.is-checked .ehp-checkbox__label {
    color: #000000 !important;
  }
  .dark &.is-checked .ehp-checkbox__label {
    color: #cfd3dc !important;
  }
}

.ehp-form {
  .ehp-link {
    font-size: 12px;
  }
  .ehp-form-item__label {
    display: flex;
    align-items: center;
  }
  .ehp-checkbox__label {
    padding-left: 4px;
  }
}
.ehp-tabs__content {
  overflow: unset !important;
}

.custom-tab-label {
  display: flex;
  align-items: center;
  gap: 6px;

  .tab-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: inherit;
  }
}

.ehp-tabs__header {
  border-bottom: 1.5px solid #f1f5f9 !important;
  margin-bottom: 20px !important;
}

.ehp-tabs__nav {
  gap: 4px !important;
}

.ehp-tabs__active-bar {
  display: none !important;
}

.ehp-tabs__item {
  font-size: 13px !important;
  font-weight: 500 !important;
  color: #64748b !important;
  padding: 6px 12px !important;
  height: 32px !important;
  line-height: 20px !important;
  border-radius: 6px !important;
  transition: all 0.2s !important;

  &:hover {
    color: #2563eb !important;
    background: #f8fafc !important;
  }

  &.is-active {
    color: #2563eb !important;
    background: #eff6ff !important;
    font-weight: 600 !important;
  }
}

.boss-helper-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  padding-bottom: 14px;
  border-bottom: 1.5px solid #f1f5f9;

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;

    .header-logo {
      font-size: 20px;
      font-weight: 700;
      color: #0f172a;
    }

    .version-badge {
      cursor: pointer;
      display: inline-flex;
    }

    .version-tag {
      font-size: 11px;
      color: #2563eb;
      background: #eff6ff;
      border: 1px solid #dbeafe;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 600;
    }
  }

  .header-right-badges {
    display: flex;
    align-items: center;
    gap: 10px;

    .header-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;

      .badge-icon {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      &.deliver-badge {
        background: #eff6ff;
        border: 1px solid #dbeafe;
        color: #1e40af;
        .badge-icon {
          color: #2563eb;
        }
      }

      &.page-badge {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        color: #475569;
        .badge-icon {
          color: #64748b;
        }
      }
    }
  }
}

@media (max-width: 560px) {
  .boss-helper-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;

    .header-right-badges {
      flex-wrap: wrap;
    }
  }

  .ehp-tabs__nav {
    flex-wrap: wrap;
  }
}
</style>
