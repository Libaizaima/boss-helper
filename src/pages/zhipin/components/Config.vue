<script lang="ts" setup>
import { reactiveComputed } from '@vueuse/core'
import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElCollapse,
  ElCollapseItem,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElLink,
  ElMessage,
  ElPopover,
  ElSpace,
  ElTooltip,
  ElSelect,
  ElOption,
} from 'element-plus'

import { ref } from '#imports'
import Alert from '@/components/Alert'
import formItem from '@/components/form/FormItem.vue'
import formSelect from '@/components/form/FormSelect.vue'
import SalaryRangeComponent from '@/components/form/SalaryRange.vue'
import { getCacheManager } from '@/composables/useApplying'
import { useCommon } from '@/composables/useCommon'
import { formInfoData, useConf } from '@/stores/conf'
import { ConfigLevel } from '@/types/formData'
import { amapGeocode } from '@/utils/amap'
import { logger } from '@/utils/logger'

import Ai from './Ai.vue'
import Appearance from './Appearance.vue'

const conf = useConf()
const common = useCommon()
const { deliverLock } = common
const amapGeocodeLoading = ref(false)
async function amapGeocodeHandler() {
  amapGeocodeLoading.value = true
  try {
    const res = await amapGeocode(conf.formData.amap.origins)
    if (res) {
      conf.formData.amap.origins = res.location
    } else {
      ElMessage.error('获取地址失败')
    }
  } catch (error) {
    ElMessage.error('获取地址失败')
    logger.error(error)
  } finally {
    amapGeocodeLoading.value = false
  }
}

function syncSalaryRange() {
  conf.formData.salaryRange.advancedValue.M[0] = Math.round(
    conf.formData.salaryRange.value[0] * 1000,
  )
  conf.formData.salaryRange.advancedValue.M[1] = Math.round(
    conf.formData.salaryRange.value[1] * 1000,
  )

  conf.formData.salaryRange.advancedValue.D[0] = Math.round(
    conf.formData.salaryRange.advancedValue.M[0] / 21.75,
  )
  conf.formData.salaryRange.advancedValue.D[1] = Math.round(
    conf.formData.salaryRange.advancedValue.M[1] / 21.75,
  )

  conf.formData.salaryRange.advancedValue.H[0] = Math.round(
    conf.formData.salaryRange.advancedValue.D[0] / 8,
  )
  conf.formData.salaryRange.advancedValue.H[1] = Math.round(
    conf.formData.salaryRange.advancedValue.D[1] / 8,
  )
}
</script>

<template>
  <div class="config-banner-card">
    <div class="banner-left">
      <div class="banner-title-row">
        <span class="banner-title-icon">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </span>
        <span class="banner-title">合理配置，提升投递效率</span>
      </div>
      <div class="banner-desc">配置项均提供帮助说明，按需调整即可。</div>
      <div class="banner-actions">
        <ElButton
          size="default"
          class="banner-btn help-btn"
          @click="common.helpVisible = !common.helpVisible"
        >
          <template #icon>
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            </svg>
          </template>
          查看帮助
        </ElButton>
        <ElButton size="default" class="banner-btn recommend-btn" @click="conf.confRecommend">
          <template #icon>
            <svg
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
                d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"
              ></path>
            </svg>
          </template>
          使用推荐配置
        </ElButton>
      </div>
    </div>
    <div class="banner-right">
      <svg viewBox="0 0 120 120" width="80" height="80" style="color: #10b981">
        <circle cx="60" cy="60" r="50" fill="#f0fdf4" stroke="#d1fae5" stroke-width="2" />
        <path
          d="M38 65l12 12 32-32"
          fill="none"
          stroke="#10b981"
          stroke-width="6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx="90" cy="85" r="12" fill="#34d399" opacity="0.15" />
        <circle cx="25" cy="35" r="10" fill="#34d399" opacity="0.1" />
      </svg>
    </div>
  </div>
  <ElForm
    inline
    label-position="left"
    label-width="auto"
    :model="conf.formData"
    :disabled="deliverLock"
  >
    <ElCollapse accordion class="custom-config-collapse">
      <ElCollapseItem name="1">
        <template #title>
          <div class="collapse-header-row">
            <div class="header-icon-wrapper blue-icon">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
              </svg>
            </div>
            <div class="header-text-wrapper">
              <div class="header-title">筛选配置</div>
              <div class="header-desc">设置岗位筛选条件，过滤不符合要求的职位</div>
            </div>
          </div>
        </template>
        <Alert
          id="filter-config-alert-enable"
          title="复选框打钩才会启用，别忘记打钩启用哦。保存也别忘了"
          type="success"
          show-icon
          style="margin: 10px 0"
        />
        <Alert
          id="filter-config-alert-mode"
          title="排除和包含可点击切换，混合模式适用性过低不会考虑开发"
          type="success"
          show-icon
          style="margin: 10px 0"
        />

        <ElSpace class="config-input" wrap style="width: 100%">
          <form-item
            v-bind="formInfoData.company"
            v-model:enable="conf.formData.company.enable"
            v-model:include="conf.formData.company.include"
            :disabled="deliverLock"
          >
            <formSelect
              v-model:value="conf.formData.company.value"
              v-model:options="conf.formData.company.options"
            />
          </form-item>
          <form-item
            v-bind="formInfoData.jobTitle"
            v-model:enable="conf.formData.jobTitle.enable"
            v-model:include="conf.formData.jobTitle.include"
            :disabled="deliverLock"
          >
            <form-select
              v-model:value="conf.formData.jobTitle.value"
              v-model:options="conf.formData.jobTitle.options"
            />
          </form-item>
          <form-item
            v-bind="formInfoData.jobContent"
            v-model:enable="conf.formData.jobContent.enable"
            v-model:include="conf.formData.jobContent.include"
            :disabled="deliverLock"
          >
            <form-select
              v-model:value="conf.formData.jobContent.value"
              v-model:options="conf.formData.jobContent.options"
            />
          </form-item>
          <form-item
            v-if="conf.config_level.intermediate"
            v-bind="formInfoData.hrPosition"
            v-model:enable="conf.formData.hrPosition.enable"
            v-model:include="conf.formData.hrPosition.include"
            :disabled="deliverLock"
          >
            <form-select
              v-model:value="conf.formData.hrPosition.value"
              v-model:options="conf.formData.hrPosition.options"
            />
          </form-item>
          <form-item
            v-if="conf.config_level.intermediate"
            v-bind="formInfoData.jobAddress"
            v-model:enable="conf.formData.jobAddress.enable"
            :disabled="deliverLock"
          >
            <template #include>
              <ElLink type="primary" size="small"> 包含 </ElLink>
            </template>
            <form-select
              v-model:value="conf.formData.jobAddress.value"
              v-model:options="conf.formData.jobAddress.options"
            />
          </form-item>
          <form-item
            v-if="conf.config_level.intermediate"
            v-bind="formInfoData.salaryRange"
            v-model:enable="conf.formData.salaryRange.enable"
          >
            <SalaryRangeComponent
              :value="conf.formData.salaryRange.value"
              width="80px"
              unit="K"
              :show="false"
            />
            <ElPopover
              v-if="conf.config_level.advanced"
              placement="top"
              :width="400"
              trigger="click"
            >
              <template #reference>
                <ElButton style="margin-left: 5px"> 高级 </ElButton>
              </template>
              <div style="display: flex; flex-direction: column; gap: 10px">
                <ElAlert
                  title="宽松匹配: 薪资范围有任何重叠即匹配, 如10-20K: 15-20K, 15-21k, 20-26k 都满足, 21-22k 不满足"
                  type="info"
                  show-icon
                  :closable="false"
                />
                <ElAlert
                  title="严格匹配: 目标薪资需完全在职位范围内, 如10-20K: 10-15K 和15-20K 满足, 15-21k 不满足"
                  type="info"
                  show-icon
                  :closable="false"
                />
                <SalaryRangeComponent
                  :value="conf.formData.salaryRange.value"
                  unit="K"
                  :show="true"
                />
                <ElAlert
                  title="计算值进行同步，算法固定. 日薪: /21.75, 时薪: /21.75/8"
                  type="info"
                  show-icon
                  :closable="false"
                />
                <ElButton @click="syncSalaryRange"> 同步 </ElButton>
                <SalaryRangeComponent
                  :value="conf.formData.salaryRange.advancedValue.H"
                  unit="元/时"
                  :show="true"
                  :step="5"
                />
                <SalaryRangeComponent
                  :value="conf.formData.salaryRange.advancedValue.D"
                  unit="元/天"
                  :show="true"
                  :step="10"
                />
                <SalaryRangeComponent
                  :value="conf.formData.salaryRange.advancedValue.M"
                  unit="元/月"
                  :show="true"
                  :step="200"
                />
              </div>
            </ElPopover>
          </form-item>
          <form-item
            v-if="conf.config_level.intermediate"
            v-bind="formInfoData.companySizeRange"
            v-model:enable="conf.formData.companySizeRange.enable"
          >
            <SalaryRangeComponent
              :controls="false"
              :value="conf.formData.companySizeRange.value"
              width="90px"
              unit="人"
              :show="true"
            />
          </form-item>

          <form-item
            v-if="conf.config_level.intermediate"
            v-bind="formInfoData.customGreeting"
            v-model:enable="conf.formData.customGreeting.enable"
          >
            <ElInput v-model.lazy="conf.formData.customGreeting.value" type="textarea" />
            <ElButton style="margin-left: 5px"> 高级 </ElButton>
          </form-item>
        </ElSpace>
        <ElSpace wrap>
          <ElCheckbox
            v-if="conf.config_level.expert"
            v-bind="formInfoData.greetingVariable"
            v-model="conf.formData.greetingVariable.value"
            border
          />
          <ElCheckbox
            v-if="conf.config_level.intermediate"
            v-bind="formInfoData.activityFilter"
            v-model="conf.formData.activityFilter.value"
            border
          />
          <ElCheckbox
            v-bind="formInfoData.goldHunterFilter"
            v-model="conf.formData.goldHunterFilter.value"
            border
          />
          <ElCheckbox
            v-bind="formInfoData.friendStatus"
            v-model="conf.formData.friendStatus.value"
            border
          />
          <ElCheckbox
            v-if="conf.config_level.intermediate"
            v-bind="formInfoData.sameCompanyFilter"
            v-model="conf.formData.sameCompanyFilter.value"
            border
          />
          <ElCheckbox
            v-if="conf.config_level.intermediate"
            v-bind="formInfoData.sameHrFilter"
            v-model="conf.formData.sameHrFilter.value"
            border
          />
        </ElSpace>
      </ElCollapseItem>
      <ElCollapseItem name="5">
        <template #title>
          <div class="collapse-header-row">
            <div class="header-icon-wrapper purple-icon">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M12 2a7 7 0 0 0-7 7c0 4.3 7 13 7 13s7-8.7 7-7a7 7 0 0 0-7-7z"></path>
                <circle cx="12" cy="9" r="2"></circle>
              </svg>
            </div>
            <div class="header-text-wrapper">
              <div class="header-title">外观配置</div>
              <div class="header-desc">自定义主题、布局等界面展示设置</div>
            </div>
          </div>
        </template>
        <Appearance />
      </ElCollapseItem>
      <ElCollapseItem v-if="conf.config_level.advanced" name="4">
        <template #title>
          <div class="collapse-header-row">
            <div class="header-icon-wrapper map-icon">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                <circle cx="12" cy="10" r="3"></circle>
              </svg>
            </div>
            <div class="header-text-wrapper">
              <div class="header-title">地址配置</div>
              <div class="header-desc">设置地点偏好，优先投递目标城市/地区</div>
            </div>
          </div>
        </template>
        <Alert id="config-amap-2" style="margin-bottom: 10px" show-icon type="info">
          <template #title>
            使用高德地图前 推荐结合工作地址包含使用, 需自行申请key,
            <br />
            <ElLink href="https://lbs.amap.com/dev/" target="_blank" type="warning">
              https://lbs.amap.com/dev/
            </ElLink>
            创建应用 -> 添加key -> Web服务
            <br />
            每日免费配额足够使用
          </template>
        </Alert>
        <Alert
          id="config-amap-ai"
          style="margin-bottom: 10px"
          :closable="false"
          type="info"
          description="AI Prompt 参考如下语法(仅筛选可用):
            直线距离: {{ amap.straightDistance }}km
            驾车距离: {{ amap.drivingDistance }}km
            驾车时间: {{ amap.drivingDuration }}分钟
            步行距离: {{ amap.walkingDistance }}km
            步行时间: {{ amap.walkingDuration }}分钟
            "
        />
        <ElCheckbox
          v-bind="formInfoData.amap.enable"
          v-model="conf.formData.amap.enable"
          border
          style="margin-right: 10px"
        />
        <ElFormItem v-bind="formInfoData.amap.key">
          <ElInput v-model.lazy="conf.formData.amap.key" />
        </ElFormItem>
        <br />
        <ElFormItem v-bind="formInfoData.amap.origins">
          <ElInput v-model.lazy="conf.formData.amap.origins" :disabled="amapGeocodeLoading">
            <template #append>
              <ElTooltip content="根据完整地址获取经纬度" placement="top">
                <ElButton
                  type="primary"
                  :loading="amapGeocodeLoading"
                  @click="amapGeocodeHandler()"
                >
                  🤖
                </ElButton>
              </ElTooltip>
            </template>
          </ElInput>
        </ElFormItem>
        <ElFormItem v-bind="formInfoData.amap.straightDistance">
          <ElInputNumber
            v-model.lazy="conf.formData.amap.straightDistance"
            :precision="1"
            :max="1000"
            :min="0"
            :step="1"
          >
            <template #suffix>
              <span>km</span>
            </template>
          </ElInputNumber>
        </ElFormItem>
        <br />
        <ElFormItem v-bind="formInfoData.amap.drivingDistance">
          <ElInputNumber
            v-model.lazy="conf.formData.amap.drivingDistance"
            :precision="1"
            :max="1000"
            :min="0"
            :step="1"
          >
            <template #suffix>
              <span>km</span>
            </template>
          </ElInputNumber>
        </ElFormItem>
        <ElFormItem v-bind="formInfoData.amap.drivingDuration">
          <ElInputNumber
            v-model.lazy="conf.formData.amap.drivingDuration"
            :precision="2"
            :max="1440"
            :min="0"
            :step="30"
          >
            <template #suffix>
              <span>分钟</span>
            </template>
          </ElInputNumber>
        </ElFormItem>
        <br />
        <ElFormItem v-bind="formInfoData.amap.walkingDistance">
          <ElInputNumber
            v-model.lazy="conf.formData.amap.walkingDistance"
            :precision="1"
            :max="1000"
            :min="0"
            :step="1"
          >
            <template #suffix>
              <span>km</span>
            </template>
          </ElInputNumber>
        </ElFormItem>
        <ElFormItem v-bind="formInfoData.amap.walkingDuration">
          <ElInputNumber
            v-model.lazy="conf.formData.amap.walkingDuration"
            :precision="2"
            :max="1440"
            :min="0"
            :step="30"
          >
            <template #suffix>
              <span>分钟</span>
            </template>
          </ElInputNumber>
        </ElFormItem>
      </ElCollapseItem>
      <ElCollapseItem v-if="conf.config_level.advanced" name="2">
        <template #title>
          <div class="collapse-header-row">
            <div class="header-icon-wrapper ai-icon">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              </svg>
            </div>
            <div class="header-text-wrapper">
              <div class="header-title">AI配置</div>
              <div class="header-desc">配置 AI 模型与能力，提升匹配与生成效果</div>
            </div>
          </div>
        </template>
        <Ai />
      </ElCollapseItem>
      <ElCollapseItem v-if="conf.config_level.intermediate" name="3">
        <template #title>
          <div class="collapse-header-row">
            <div class="header-icon-wrapper timer-icon">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
            </div>
            <div class="header-text-wrapper">
              <div class="header-title">延迟配置</div>
              <div class="header-desc">设置操作延迟与间隔，降低平台风控风险</div>
            </div>
          </div>
        </template>
        <ElFormItem
          v-for="(item, key) in formInfoData.delay"
          :key
          :label="item.label"
          :data-help="item['data-help']"
        >
          <ElInputNumber
            v-model="conf.formData.delay[key]"
            :min="1"
            :max="99999"
            :disabled="item.disable"
          />
        </ElFormItem>
        <!-- ACK 超时配置（与反风控延迟同级，仅中级及以上可见） -->
        <ElFormItem
          label="招呼 ACK 超时"
          data-help="等待 Boss 服务端确认招呼语已接收的超时时间（毫秒）。超时后该次打招呼记为「未确认」。范围 1000–15000，默认 5000。"
        >
          <ElInputNumber
            v-model="conf.formData.greetingAckTimeoutMs"
            :min="1000"
            :max="15000"
            :step="500"
          />
        </ElFormItem>
      </ElCollapseItem>
    </ElCollapse>

    <div class="config-bottom-controls-row">
      <ElFormItem label="配置级别" :data-help="formInfoData.config_level['data-help']">
        <ElSelect v-model="conf.formData.config_level" style="width: 120px">
          <ElOption
            v-for="item in formInfoData.config_level.options"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          /> </ElSelect
      ></ElFormItem>
      <ElCheckbox
        v-bind="formInfoData.notification"
        v-model="conf.formData.notification.value"
        border
      />
      <ElCheckbox
        v-if="conf.config_level.expert || conf.formData.useCache.value"
        v-bind="formInfoData.useCache"
        v-model="conf.formData.useCache.value"
        border
      />
      <ElButton
        v-if="conf.formData.useCache.value"
        type="warning"
        @click="() => getCacheManager().clearCache()"
      >
        清空缓存
      </ElButton>
      <ElFormItem v-if="conf.config_level.intermediate" :label="formInfoData.deliveryLimit.label">
        <ElInputNumber
          v-bind="formInfoData.deliveryLimit"
          v-model="conf.formData.deliveryLimit.value"
          :min="1"
          :max="155"
          :step="10"
        />
      </ElFormItem>
    </div>
  </ElForm>

  <div class="bottom-actions-row">
    <ElButton
      class="bottom-action-btn save-btn"
      data-help="保存配置，会自动刷新页面。"
      @click="conf.confSaving"
    >
      <template #icon>
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
          <polyline points="17 21 17 13 7 13 7 21"></polyline>
          <polyline points="7 3 7 8 15 8"></polyline>
        </svg>
      </template>
      保存配置
    </ElButton>

    <ElButton
      class="bottom-action-btn outline-blue-btn"
      data-help="重新加载本地配置"
      @click="conf.confReload"
    >
      <template #icon>
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
        </svg>
      </template>
      重载配置
    </ElButton>

    <ElButton
      v-if="conf.config_level.intermediate"
      class="bottom-action-btn outline-blue-btn"
      data-help="导出本地配置"
      @click="conf.confExport"
    >
      <template #icon>
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"></path>
        </svg>
      </template>
      导出配置
    </ElButton>

    <ElButton
      v-if="conf.config_level.intermediate"
      class="bottom-action-btn outline-blue-btn"
      data-help="导入配置文件"
      @click="conf.confImport"
    >
      <template #icon>
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M12 15V2M16 11l-4 4-4-4"></path>
        </svg>
      </template>
      导入配置
    </ElButton>

    <ElButton
      v-if="conf.config_level.advanced"
      class="bottom-action-btn outline-red-btn"
      data-help="清空配置,不会帮你保存,可以重载恢复"
      @click="conf.confDelete"
    >
      <template #icon>
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="3 6 5 6 21 6"></polyline>
          <path
            d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
          ></path>
        </svg>
      </template>
      清空配置
    </ElButton>
  </div>
</template>

<style lang="scss" scoped>
.config-banner-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f0fdf4;
  border: 1px solid #d1fae5;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 20px;

  .banner-left {
    display: flex;
    flex-direction: column;
    gap: 6px;

    .banner-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #065f46;

      .banner-title-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #d1fae5;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        color: #10b981;
      }

      .banner-title {
        font-size: 15px;
        font-weight: 700;
      }
    }

    .banner-desc {
      font-size: 13px;
      color: #047857;
    }

    .banner-actions {
      display: flex;
      gap: 10px;
      margin-top: 6px;

      .banner-btn {
        height: 32px;
        font-size: 12px;
        font-weight: 600;
        border-radius: 6px;

        &.help-btn {
          background: #ffffff;
          border: 1px solid #d1fae5;
          color: #047857;
          &:hover {
            background: #f9fbf9;
          }
        }

        &.recommend-btn {
          background: #ffffff;
          border: 1px solid #10b981;
          color: #047857;
          &:hover {
            background: #ecfdf5;
          }
        }
      }
    }
  }

  .banner-right {
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

.custom-config-collapse {
  border: none !important;
  background: transparent !important;

  :deep(.ehp-collapse-item) {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    margin-bottom: 12px;
    overflow: hidden;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.02);

    .ehp-collapse-item__header {
      height: 64px;
      padding: 0 20px;
      border: none;
      background: #ffffff;

      &.is-active {
        border-bottom: 1px solid #f1f5f9;
      }
    }

    .ehp-collapse-item__wrap {
      border: none;
      background: #ffffff;
    }

    .ehp-collapse-item__content {
      padding: 20px;
    }
  }

  .collapse-header-row {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    text-align: left;

    .header-icon-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 8px;

      &.blue-icon {
        background: #eff6ff;
        color: #2563eb;
      }
      &.purple-icon {
        background: #faf5ff;
        color: #9333ea;
      }
      &.map-icon {
        background: #fff1f2;
        color: #f43f5e;
      }
      &.ai-icon {
        background: #f0fdf4;
        color: #10b981;
      }
      &.timer-icon {
        background: #f0f9ff;
        color: #0284c7;
      }
    }

    .header-text-wrapper {
      display: flex;
      flex-direction: column;

      .header-title {
        font-size: 14px;
        font-weight: 700;
        color: #1e293b;
        line-height: 1.2;
      }

      .header-desc {
        font-size: 11px;
        color: #94a3b8;
        font-weight: 400;
        margin-top: 3px;
      }
    }
  }
}

.config-bottom-controls-row {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  background: #ffffff;
  padding: 16px 20px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  margin-top: 16px;
  margin-bottom: 20px;
}

.bottom-actions-row {
  display: flex;
  gap: 12px;
  margin-top: 16px;

  .bottom-action-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    height: 38px;
    padding: 0 16px;
    border-radius: 8px;
    font-size: 13px;
    border-width: 1px;

    &.save-btn {
      background-color: #2563eb;
      border-color: #2563eb;
      color: #ffffff;
      &:hover {
        background-color: #1d4ed8;
        border-color: #1d4ed8;
      }
    }

    &.outline-blue-btn {
      background-color: #ffffff;
      border-color: #dbeafe;
      color: #2563eb;
      &:hover {
        background-color: #f1f5f9;
        border-color: #bfdbfe;
      }
    }

    &.outline-red-btn {
      background-color: #ffffff;
      border-color: #fee2e2;
      color: #ef4444;
      &:hover {
        background-color: #fef2f2;
        border-color: #fca5a5;
      }
    }
  }
}

.ehp-space.config-input :deep(.ehp-space__item) {
  width: 48%;
}

@media (max-width: 720px) {
  .config-banner-card {
    align-items: flex-start;

    .banner-right {
      display: none;
    }
  }

  .config-bottom-controls-row,
  .bottom-actions-row,
  .config-banner-card .banner-actions {
    gap: 10px;
    flex-wrap: wrap;
  }

  .ehp-space.config-input :deep(.ehp-space__item) {
    width: 100%;
  }
}
</style>
