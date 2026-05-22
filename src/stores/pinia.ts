import { createPinia, setActivePinia } from 'pinia'

export const sharedPinia = createPinia()

export function ensureActivePinia() {
  setActivePinia(sharedPinia)
  return sharedPinia
}
