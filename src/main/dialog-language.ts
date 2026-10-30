import { app } from 'electron'
import { getState } from './storage'

/** The language main's own text speaks — native dialogs, and the page the
 *  ChatGPT sign-in hands the browser. The renderer's i18n cannot be reached
 *  from main, so the handful of strings main writes resolve the same language
 *  setting themselves — this is the one place that decision is made (mirrors
 *  resolveLanguage in the renderer's i18n.ts). */
export function dialogLanguage(): 'nb' | 'en' | 'zh' {
  const pref = getState().settings.language
  if (pref !== 'auto') return pref
  const sys = app.getLocale().toLowerCase()
  return sys.startsWith('n') ? 'nb' : sys.startsWith('zh') ? 'zh' : 'en'
}
