/**
 * Locale-aware formatters voor datums, getallen, en valuta.
 *
 * Werkt server-side (RSC) én client-side. Accepteert per-call overrides voor
 * `dateFormat`, `currency`, `locale`, `timezone` zodat de caller kan kiezen
 * tussen "gebruik mijn profile-defaults" of "render in deze specifieke
 * formaat" (bv. voor PDF-rapporten naar een klant in een ander land).
 *
 * Gebruik:
 *   import { formatDate, formatCurrency } from '@/lib/format'
 *
 *   formatDate(new Date(), { profile })
 *   formatCurrency(1234.5, { profile })
 *   formatDate('2026-05-06', { dateFormat: 'YYYY-MM-DD', locale: 'en' })
 */

type FormatOptions = {
  profile?: {
    locale?:      string | null
    date_format?: string | null
    currency?:    string | null
    timezone?:    string | null
  } | null
  /** Override profile.date_format */
  dateFormat?: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD'
  /** Override profile.currency */
  currency?:   string
  /** Override profile.locale */
  locale?:     string
  /** Override profile.timezone */
  timezone?:   string
}

const DEFAULTS = {
  locale:      'nl-BE',
  dateFormat:  'DD/MM/YYYY' as const,
  currency:    'EUR',
  timezone:    'Europe/Brussels',
}

/**
 * Map onze interne locale-code naar een BCP47-tag voor Intl-API. We gebruiken
 * regional variants zodat getallen + datums correct lokaliseren (bv. 'nl-BE'
 * gebruikt komma als decimaal-separator, 'en-GB' gebruikt punt + DD/MM).
 */
function toBcp47(locale: string | null | undefined, country?: string | null): string {
  const base = (locale ?? DEFAULTS.locale).toLowerCase()
  if (base.includes('-')) return base                          // al een tag
  // Map base → meest waarschijnlijke regional variant
  const region = country?.toUpperCase() ?? (base === 'en' ? 'GB' : 'BE')
  return `${base}-${region}`
}

/**
 * Format een datum volgens de gebruikers-voorkeur. Accepteert Date, ISO-string
 * of timestamp. Returnt een leesbare string in het juiste formaat.
 *
 * Voor `dateFormat` doen we een eigen pad-implementatie omdat Intl niet
 * standaard 'YYYY-MM-DD' kent en we precieze controle willen.
 */
export function formatDate(
  input: Date | string | number,
  opts: FormatOptions = {},
): string {
  const date = input instanceof Date ? input : new Date(input)
  if (isNaN(date.getTime())) return ''

  const dateFormat = opts.dateFormat ?? opts.profile?.date_format ?? DEFAULTS.dateFormat
  const timezone   = opts.timezone   ?? opts.profile?.timezone    ?? DEFAULTS.timezone

  // Pak de date-parts in de juiste timezone via Intl
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  })
  const parts = fmt.formatToParts(date)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const y = get('year')
  const m = get('month')
  const d = get('day')

  switch (dateFormat) {
    case 'YYYY-MM-DD': return `${y}-${m}-${d}`
    case 'MM/DD/YYYY': return `${m}/${d}/${y}`
    case 'DD/MM/YYYY':
    default:           return `${d}/${m}/${y}`
  }
}

/**
 * Format datum + tijd. Gebruikt de profile-locale voor "5 mei 2026 14:30"
 * stijl renders. Voor pure datum-zonder-tijd → gebruik `formatDate`.
 */
export function formatDateTime(
  input: Date | string | number,
  opts: FormatOptions = {},
): string {
  const date = input instanceof Date ? input : new Date(input)
  if (isNaN(date.getTime())) return ''

  const locale   = toBcp47(opts.locale ?? opts.profile?.locale)
  const timezone = opts.timezone ?? opts.profile?.timezone ?? DEFAULTS.timezone

  return new Intl.DateTimeFormat(locale, {
    timeZone:  timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

/**
 * Format een geldbedrag volgens de gebruikers-munt en locale. Standaard zonder
 * decimalen voor "ronde" prijzen (€49) en met 2 decimalen voor specifieke
 * bedragen (€49,50). Override via `decimals`.
 */
export function formatCurrency(
  amount: number,
  opts: FormatOptions & { decimals?: number } = {},
): string {
  if (!Number.isFinite(amount)) return ''
  const locale   = toBcp47(opts.locale ?? opts.profile?.locale)
  const currency = opts.currency ?? opts.profile?.currency ?? DEFAULTS.currency
  const decimals = opts.decimals ?? (Number.isInteger(amount) ? 0 : 2)

  return new Intl.NumberFormat(locale, {
    style:                 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount)
}

/**
 * Format een gewoon getal (geen valuta) volgens de locale. Bv. "1.234,5" voor
 * NL/BE en "1,234.5" voor US.
 */
export function formatNumber(
  value: number,
  opts: FormatOptions & { decimals?: number } = {},
): string {
  if (!Number.isFinite(value)) return ''
  const locale   = toBcp47(opts.locale ?? opts.profile?.locale)
  const decimals = opts.decimals ?? 1

  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value)
}
