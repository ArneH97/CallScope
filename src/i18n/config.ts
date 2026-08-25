/**
 * Centrale i18n configuratie. Eén plek waar we de ondersteunde talen
 * declareren — wordt geïmporteerd door de middleware, layout, en routing-helpers.
 *
 * Toevoegen van een nieuwe taal:
 *   1. Voeg de locale-code toe aan `locales` (bv. 'fr')
 *   2. Maak een nieuw bestand `src/messages/<locale>.json` met de vertalingen
 *   3. Voeg eventueel een mapping toe in countryToLocale als de taal aan een
 *      specifiek land gekoppeld moet worden bij onboarding
 */

export const locales = ['nl', 'en'] as const
export type Locale = typeof locales[number]

export const defaultLocale: Locale = 'nl'

/**
 * Met `as-needed` krijgt de default locale (nl) GEEN URL-prefix:
 *   /dashboard          → Nederlands
 *   /en/dashboard       → Engels
 * Dit houdt bestaande NL-URLs intact (geen redirect-storm) en geeft EN
 * gebruikers een herkenbare /en/-prefix voor sharing.
 */
export const localePrefix = 'as-needed' as const

/**
 * Mensvriendelijke labels voor de language-picker.
 */
export const localeLabels: Record<Locale, string> = {
  nl: 'Nederlands',
  en: 'English',
}

/**
 * Default-mapping van land naar app-taal voor onboarding. Klanten kunnen
 * altijd handmatig overschrijven.
 */
export const countryToLocale: Record<string, Locale> = {
  BE: 'nl',          // België default NL (West-Vl + cc-managers daar)
  NL: 'nl',
  GB: 'en',
  US: 'en',
  IE: 'en',
  // Niet-aangewezen landen vallen op defaultLocale
}
