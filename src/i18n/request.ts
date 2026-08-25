import { getRequestConfig } from 'next-intl/server'
import { routing } from './routing'
import type { Locale } from './config'

/**
 * Per-request configuratie voor next-intl: welke messages moeten geladen
 * worden voor deze locale. Wordt automatisch aangeroepen door next-intl
 * (zie next.config.js plugin).
 *
 * We laden enkel het JSON-bestand dat bij de actieve locale hoort — niet
 * alle talen tegelijk — om de bundel-size klein te houden.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  // requestLocale komt van de middleware (URL-segment)
  let locale = await requestLocale
  if (!locale || !routing.locales.includes(locale as Locale)) {
    locale = routing.defaultLocale
  }

  return {
    locale,
    messages: (await import(`@/messages/${locale}.json`)).default,
  }
})
