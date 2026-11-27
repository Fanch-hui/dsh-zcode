import { zh } from './zh.js'
import { en } from './en.js'
import { ru } from './ru.js'

export type Locale = 'zh' | 'en' | 'ru'
export type MessageKey = keyof typeof zh

const catalogs: Record<Locale, Record<MessageKey, string>> = { zh, en, ru }

function normalize(tag: string | undefined): Locale | undefined {
  if (!tag) return undefined
  const primary = tag.trim().toLowerCase().split(/[-_.@]/u, 1)[0]
  return primary === 'zh' || primary === 'en' || primary === 'ru' ? primary : undefined
}

/**
 * Resolve the UI locale: explicit ZCODE_LOCALE override, then the POSIX
 * locale variables, then (in a real browser) the navigator language.
 * Chinese is the primary locale and the fallback for anything
 * unrecognized; Node's built-in navigator is ignored on purpose.
 */
export function detectLocale(): Locale {
  const env = typeof process === 'undefined' ? {} : process.env
  const explicit = normalize(env.ZCODE_LOCALE)
  if (explicit) return explicit
  const fromEnv = normalize(env.LC_ALL) ?? normalize(env.LC_MESSAGES) ?? normalize(env.LANG)
  if (fromEnv) return fromEnv
  if (typeof document !== 'undefined') {
    const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator
    const fromNavigator = normalize(nav?.languages?.[0] ?? nav?.language)
    if (fromNavigator) return fromNavigator
  }
  return 'zh'
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text: string = catalogs[detectLocale()][key]
  if (params) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  return text
}
