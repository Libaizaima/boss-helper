<script lang="ts" setup>
import { ElLink, ElSpace } from 'element-plus'
</script>

<template>
  <div class="about-panel">
    <div class="about-copy">
      <div class="hp-about" data-help="谢谢你的关心">
        <div class="about-row" data-help="愿为理想执着行，前路漫漫自铸金。">
          <span class="about-label">作者</span>
          <ElLink href="https://github.com/Ocyss" target="_blank">Ocyss_04</ElLink>
        </div>
        <div class="about-row" data-help="记得来个Star或者好评吧">
          <span class="about-label">项目</span>
          <ElLink href="https://github.com/ocyss/boos-helper" target="_blank"> GitHub </ElLink>
          <ElLink href="https://greasyfork.org/zh-CN/scripts/491340" target="_blank">
            GreasyFork
          </ElLink>
        </div>
        <div class="about-row" data-help="感谢每一个人的付出">
          <span class="about-label">鸣谢</span>
          <ElSpace wrap :size="10">
            <ElLink href="https://github.com/yangfeng20" target="_blank">yangfeng20</ElLink>
            <ElLink href="https://github.com/engvuchen" target="_blank">engvuchen</ElLink>
          </ElSpace>
        </div>
        <div class="about-row" data-help="反馈结果会在对应记录中评论回复">
          <span class="about-label">反馈</span>
          <ElLink
            href="https://gai06vrtbc0.feishu.cn/share/base/form/shrcnmEq2fxH9hM44hqEnoeaj8g"
            target="_blank"
          >
            飞书问卷
          </ElLink>
          <ElLink
            href="https://gai06vrtbc0.feishu.cn/share/base/view/shrcnrg8D0cbLQc89d7Jj7AZgMc"
            target="_blank"
          >
            问卷结果
          </ElLink>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.about-panel {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  padding: 18px 20px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #ffffff;
}

.about-copy {
  min-width: 0;
}

.hp-about {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.about-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-height: 24px;
}

.about-label {
  min-width: 42px;
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
}

@media (max-width: 560px) {
  .about-panel {
    flex-direction: column;
  }
}
</style>
