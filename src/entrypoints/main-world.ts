import axios from 'axios'
import { createApp } from 'vue'

import { defineUnlistedScript } from '#imports'
import App from '@/App.vue'
import { initAiReply } from '@/composables/useAiReply'
import { initAutoResume } from '@/composables/useAutoResume'
import { getRootVue } from '@/composables/useVue'
import { initGeekChatBridge } from '@/composables/useWebSocket/chatCore'
import { ensureActivePinia } from '@/stores/pinia'
import { loader } from '@/utils'
import { logger } from '@/utils/logger'

let staleDomCleaned = false
let floatingAppMounted = false

function cleanupStaleDom() {
  if (staleDomCleaned) return
  staleDomCleaned = true
  document.querySelector('#boss-helper')?.remove()
  document.querySelector('#boss-helper-job')?.remove()
  document.querySelector('#boss-helper-job-warp')?.remove()
  document.querySelector('#help-conf-box')?.remove()
}

function mountFloatingApp() {
  if (floatingAppMounted && document.querySelector('#boss-helper')) return
  document.querySelector('#boss-helper')?.remove()
  const app = createApp(App)
  app.use(ensureActivePinia())
  const appEl = document.createElement('div')
  appEl.id = 'boss-helper'
  document.body.append(appEl)
  app.mount(appEl)
  floatingAppMounted = true
}

async function main(router: any) {
  let module = {
    run() {
      logger.info('BossHelper加载成功')
      logger.debug('当前页面无对应hook脚本', router.path)
    },
  }
  switch (router.path) {
    case '/web/geek/job':
    case '/web/geek/job-recommend':
    case '/web/geek/jobs':
      module = await import('@/pages/zhipin')
      break
  }
  module.run()
  mountFloatingApp()
}

async function start() {
  cleanupStaleDom()
  initGeekChatBridge()

  //   document.documentElement.classList.toggle(
  //     "dark",
  //     GM_getValue("theme-dark", false)
  //   );

  let v: any
  try {
    v = await getRootVue()
  } catch (e) {
    logger.debug('skip non-Vue page', {
      path: location.pathname,
      message: e instanceof Error ? e.message : String(e),
    })
    return
  }
  v.$router.afterHooks.push(main)
  void main(v.$route)
  let axiosLoad: () => void
  axios.interceptors.request.use(
    (config) => {
      if (config.timeout != null) {
        axiosLoad = loader({ ms: config.timeout, color: '#F79E63' })
      }
      return config
    },
    async (error) => {
      axiosLoad()
      return Promise.reject(error)
    },
  )
  axios.interceptors.response.use(
    (response) => {
      axiosLoad()
      return response
    },
    async (error) => {
      axiosLoad()
      return Promise.reject(error)
    },
  )
}

export default defineUnlistedScript(() => {
  ensureActivePinia()
  cleanupStaleDom()
  start().catch((e) => {
    logger.error(e)
  })
  initAiReply()
  initAutoResume()
})
