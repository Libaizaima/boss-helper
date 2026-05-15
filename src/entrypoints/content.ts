import { defineContentScript, injectScript } from '#imports'
import { ProvideContentAdapter, provideContentCounter } from '@/message/contentScript'

import '@/main.scss'
import 'element-plus/theme-chalk/src/message-box.scss'
import 'element-plus/theme-chalk/src/message.scss'

export default defineContentScript({
  matches: ['*://zhipin.com/*', '*://*.zhipin.com/*'],
  runAt: 'document_start',
  async main(_ctx) {
    provideContentCounter(new ProvideContentAdapter())

    await injectScript('/main-world.js', {
      keepInDom: true,
    })
  },
})
