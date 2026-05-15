<script lang="ts" setup>
import type { TableV2Instance } from 'element-plus'
import {
  ElAutoResizer,
  ElButton,
  ElButtonGroup,
  ElCollapse,
  ElCollapseItem,
  ElDialog,
  ElInput,
  ElMessage,
  ElOption,
  ElSelect,
  ElSpace,
  ElTableV2,
  ElTabPane,
  ElTabs,
} from 'element-plus'
import { onMounted, ref } from 'vue'

import JobCard from '@/components/JobCard.vue'
import { useLog } from '@/stores/log'

const tableRef = ref<TableV2Instance>()
const { filterData, columns, dialogData, exportText, clear, init, loadDate, getAvailableDates } =
  useLog()

const aiFilterActiveNames = ref('response')
const aiGreetActiveNames = ref('response')

const exportDialogVisible = ref(false)
const exportContent = ref('')

const availableDates = ref<string[]>([])
const selectedDate = ref('')

onMounted(async () => {
  await init()
  availableDates.value = await getAvailableDates()
  if (availableDates.value.length > 0) {
    selectedDate.value = availableDates.value[0]
  }
})

async function onDateChange(date: string) {
  selectedDate.value = date
  await loadDate(date)
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success('已复制到剪贴板')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    ElMessage.success('已复制到剪贴板')
  }
}

function exportAll() {
  exportContent.value = exportText()
  exportDialogVisible.value = true
}

function copyDetail() {
  const d = dialogData.data
  if (!d) return
  const lines: string[] = []
  if (d.time) lines.push(`[时间] ${d.time}`)
  lines.push(`[状态] ${d.state_name}`)
  lines.push(`[标题] ${d.title}`)
  if (d.message) lines.push(`[信息] ${d.message}`)
  if (d.job?.brandName) lines.push(`[公司] ${d.job.brandName}`)
  if (d.job?.salaryDesc) lines.push(`[薪资] ${d.job.salaryDesc}`)
  if (d.data?.aiGreetingQ) lines.push(`[AI招呼Prompt]\n${d.data.aiGreetingQ}`)
  if (d.data?.aiGreetingA) lines.push(`[AI招呼回答]\n${d.data.aiGreetingA}`)
  if (d.data?.aiFilteringQ) lines.push(`[AI筛选Prompt]\n${d.data.aiFilteringQ}`)
  if (d.data?.aiFilteringAtext) lines.push(`[AI筛选回答]\n${d.data.aiFilteringAtext}`)
  if (d.data?.err) lines.push(`[错误详情]\n${d.data.err}`)
  if (d.debug) lines.push(`[调试信息]\n${d.debug}`)
  copy(lines.join('\n'))
}

function confirmClear() {
  if (filterData.value.length === 0) {
    ElMessage.info('日志已为空')
    return
  }
  clear()
  ElMessage.success('日志已清空')
}
</script>

<template>
  <ElSpace style="margin-bottom: 10px" wrap>
    <ElSelect
      v-if="availableDates.length > 0"
      :model-value="selectedDate"
      style="width: 150px"
      placeholder="选择日期"
      @update:model-value="onDateChange"
    >
      <ElOption v-for="d in availableDates" :key="d" :label="d" :value="d" />
    </ElSelect>
    <ElButton type="primary" @click="exportAll"> 导出全部日志 </ElButton>
    <ElButton type="warning" @click="confirmClear"> 清空日志 </ElButton>
    <span style="color: #909399; font-size: 12px">
      共 {{ filterData.length }} 条 · 点击标题查看详情
    </span>
  </ElSpace>
  <ElAutoResizer :disable-height="true">
    <template #default="{ width }">
      <ElTableV2 ref="tableRef" :columns="columns" :data="filterData" :height="360" :width />
    </template>
  </ElAutoResizer>
  <ElDialog v-model="dialogData.show" title="日志详情" width="80%">
    <div class="log-detail">
      <div class="log-detail-left">
        <JobCard v-if="dialogData.data?.job" :job="dialogData.data.job" />
      </div>
      <div class="log-detail-right">
        <ElTabs class="demo-tabs">
          <ElTabPane label="基本信息" name="base">
            <div class="log-base">
              <div v-if="dialogData.data?.time"><b>时间：</b>{{ dialogData.data.time }}</div>
              <div><b>状态：</b>{{ dialogData.data?.state_name }}</div>
              <div><b>标题：</b>{{ dialogData.data?.title }}</div>
              <div v-if="dialogData.data?.message">
                <b>信息：</b>
                <div class="ai-text">{{ dialogData.data.message }}</div>
              </div>
              <div v-if="dialogData.data?.debug">
                <b>调试信息：</b>
                <div class="ai-text">{{ dialogData.data.debug }}</div>
              </div>
            </div>
          </ElTabPane>
          <ElTabPane v-if="dialogData.data?.data?.aiFilteringQ" label="AI过滤" name="first">
            <ElCollapse v-model="aiFilterActiveNames" accordion>
              <ElCollapseItem title="Prompt" name="prompt">
                <div class="ai-text">{{ dialogData.data.data.aiFilteringQ }}</div>
              </ElCollapseItem>
              <ElCollapseItem
                v-if="dialogData.data.data.aiFilteringR"
                title="思考过程"
                name="thinking"
              >
                <div class="ai-text">{{ dialogData.data.data.aiFilteringR }}</div>
              </ElCollapseItem>
              <ElCollapseItem title="响应" name="response" class="active">
                <div class="ai-text">{{ dialogData.data.data.aiFilteringAtext }}</div>
              </ElCollapseItem>
            </ElCollapse>
          </ElTabPane>
          <ElTabPane v-if="dialogData.data?.data?.aiGreetingQ" label="AI打招呼" name="second">
            <ElCollapse v-model="aiGreetActiveNames" accordion>
              <ElCollapseItem title="Prompt" name="prompt">
                <div class="ai-text">{{ dialogData.data.data.aiGreetingQ }}</div>
              </ElCollapseItem>
              <ElCollapseItem
                v-if="dialogData.data.data.aiGreetingR"
                title="思考过程"
                name="thinking"
              >
                <div class="ai-text">{{ dialogData.data.data.aiGreetingR }}</div>
              </ElCollapseItem>
              <ElCollapseItem title="响应" name="response" class="active">
                <div class="ai-text">{{ dialogData.data.data.aiGreetingA }}</div>
              </ElCollapseItem>
            </ElCollapse>
          </ElTabPane>
          <ElTabPane v-if="dialogData.data?.data?.err" label="错误信息" name="fourth">
            <div class="ai-text">{{ dialogData.data.data.err }}</div>
            <div v-if="dialogData.data?.data?.message" class="ai-text">
              {{ dialogData.data.data.message }}
            </div>
          </ElTabPane>
        </ElTabs>
      </div>
    </div>
    <template #footer>
      <ElButtonGroup>
        <ElButton type="primary" @click="copyDetail"> 复制本条详情 </ElButton>
        <ElButton @click="dialogData.show = false"> 关闭 </ElButton>
      </ElButtonGroup>
    </template>
  </ElDialog>

  <ElDialog v-model="exportDialogVisible" title="导出全部日志" width="70%">
    <ElInput v-model="exportContent" type="textarea" :rows="20" readonly placeholder="日志内容" />
    <template #footer>
      <ElButtonGroup>
        <ElButton type="primary" @click="copy(exportContent)"> 复制全部 </ElButton>
        <ElButton @click="exportDialogVisible = false"> 关闭 </ElButton>
      </ElButtonGroup>
    </template>
  </ElDialog>
</template>

<style lang="scss">
.ehp-table-v2__row-depth-0 {
  height: 50px;
}

.ehp-table-v2__cell-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-detail {
  display: flex;
  gap: 20px;
  min-height: 500px;

  &-left {
    flex: 0 0 350px;
  }

  &-right {
    flex: 1;
    overflow-y: auto;
  }
}

.log-base > div {
  margin-bottom: 10px;
  user-select: text;
}

.log-section {
  padding: 16px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 16px;

  h4 {
    margin: 0 0 12px;
    color: #606266;
  }
}

.ai-qa {
  .ai-q {
    color: #606266;
    margin-bottom: 8px;
  }
  .ai-a {
    color: #303133;
    white-space: pre-wrap;
  }
}

.ai-text {
  white-space: pre-wrap;
  user-select: text;
  padding: 8px;
  line-height: 1.5;
  background: #f5f7fa;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}

.ehp-collapse-item.active {
  .ehp-collapse-item__header {
    border-bottom-color: transparent;
  }
}
</style>
