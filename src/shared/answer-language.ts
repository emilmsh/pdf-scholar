// The language an AI answer falls back to when the reader typed nothing that
// says which (issue #75: a Spanish student got every answer in English).
//
// Where the reader TYPED something — a chat message, a «Spør …» question — the
// language of their own words decides, and the prompts in
// src/renderer/src/ai.ts say so. This module is only the default behind that:
// the one-click chips (Forklar, Forenkle, Kritisk blikk, Referanse, Forklar
// område …), the structured summary and the passage search send no words of
// the reader's, and a message too short to tell («p. 4?») needs one too.
//
// The default is the interface language — except when the interface is
// English only because the system's language is one we have no dictionary for
// (a Spanish Windows gets an English UI): then the answer follows the system's
// language, named in English for the prompt ('es' → "Spanish"). An interface
// language the reader CHOSE is never overridden. Chinese has one dictionary,
// Simplified, which a Traditional-script system also gets; its answers follow
// the script the system asks for.
//
// Pure: the caller hands over the system's languages — desktop asks the OS
// (`app.getPreferredSystemLanguages`, which also sees a language Chromium
// ships no translation for), the browser and the extension read
// navigator.languages. Test: scripts/test-answer-language.mjs.

export type UiLanguage = 'nb' | 'en' | 'zh'
export type UiLanguagePreference = UiLanguage | 'auto'

const DEFAULT_NAMES: Record<UiLanguage, string> = {
  nb: 'Norwegian Bokmål',
  en: 'English',
  zh: 'Simplified Chinese'
}

interface Tag {
  language: string
  script: string | undefined
  region: string | undefined
}

/** A BCP 47 tag from the system, or null for anything that is not one. The
 *  list is the platform's, but a bad entry must never reach a prompt. */
function parseTag(raw: unknown): Tag | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim().replace(/_/g, '-')
  if (!text || text.length > 64) return null
  try {
    const loc = new Intl.Locale(text)
    if (!/^[a-z]{2,3}$/.test(loc.language)) return null
    return { language: loc.language, script: loc.script, region: loc.region }
  } catch {
    return null
  }
}

function isTraditionalChinese(tag: Tag): boolean {
  if (tag.script) return tag.script === 'Hant'
  return tag.region === 'TW' || tag.region === 'HK' || tag.region === 'MO'
}

/** The English name of a language («Spanish», «Serbian (Latin)»), or null
 *  when the platform cannot name it — an unnamed code would only confuse the
 *  model, and English is the better guess then. The region is left out on
 *  purpose: «Spanish (Mexico)» asks for a dialect where a language is meant. */
function englishName(tag: Tag): string | null {
  if (tag.language === 'zh') {
    return isTraditionalChinese(tag) ? 'Traditional Chinese' : 'Simplified Chinese'
  }
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
    const code = tag.script ? `${tag.language}-${tag.script}` : tag.language
    const name = names.of(code)
    return name && name.toLowerCase() !== code.toLowerCase() ? name : null
  } catch {
    return null
  }
}

/** The system's first language, parsed — the one its own interface is in */
function firstSystemLanguage(systemLanguages: unknown): Tag | null {
  if (!Array.isArray(systemLanguages)) return null
  for (const raw of systemLanguages) {
    if (typeof raw === 'string' && raw.trim()) return parseTag(raw)
  }
  return null
}

/**
 * The language, named in English, an answer is written in when nothing the
 * reader typed decides it.
 *
 * @param ui              the interface language the app resolved
 * @param preference      the language setting («auto» = follow the system)
 * @param systemLanguages the system's preferred languages, most preferred first
 */
export function defaultAnswerLanguage(
  ui: UiLanguage,
  preference: UiLanguagePreference,
  systemLanguages: unknown
): string {
  const system = firstSystemLanguage(systemLanguages)
  if (ui === 'zh') {
    // One Chinese dictionary for both scripts; the answer can do better
    return system?.language === 'zh' && isTraditionalChinese(system)
      ? 'Traditional Chinese'
      : DEFAULT_NAMES.zh
  }
  // A chosen interface language is the reader's answer; so is Norwegian,
  // which «auto» only resolves to from a Norwegian system
  if (ui === 'nb' || preference !== 'auto' || !system) return DEFAULT_NAMES[ui]
  if (system.language === 'en') return DEFAULT_NAMES.en
  // English by fallback: the system speaks a language we have no UI for
  return englishName(system) ?? DEFAULT_NAMES.en
}
