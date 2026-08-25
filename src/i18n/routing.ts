import { defineRouting } from 'next-intl/routing'
import { createNavigation } from 'next-intl/navigation'
import { locales, defaultLocale, localePrefix } from './config'

/**
 * Centrale routing-config voor next-intl. Wordt gebruikt door de middleware
 * (locale-detection + redirect) én door de Link/redirect helpers in
 * client/server-componenten zodat ze automatisch de correcte locale-prefix
 * toevoegen.
 *
 * `localeDetection: false`:
 *   - GEEN auto-redirect op basis van Accept-Language header of NEXT_LOCALE-
 *     cookie. De URL is altijd de waarheid.
 *   - Een Belgische bezoeker (browser stuurt vaak en-US) op /dashboard blijft
 *     dus gewoon op NL. Wil hij EN? Dan klikt hij de language-switcher of
 *     typt /en/dashboard expliciet.
 *   - Voorkomt het irritante "midden in m'n sessie verspringt mijn URL naar
 *     /en/" gedrag wanneer Chrome zijn Accept-Language wijzigt of de cookie
 *     uit een eerdere /en/-test blijft hangen.
 */
export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix,
  localeDetection: false,
})

/**
 * Drop-in vervangers voor next/navigation die locale-aware zijn.
 *
 * Gebruik:
 *   import { Link, useRouter, redirect } from '@/i18n/routing'
 *
 * Dit zorgt dat een NL-user op /dashboard blijft en een EN-user op
 * /en/dashboard, zonder dat we overal handmatig prefixes moeten plakken.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing)
