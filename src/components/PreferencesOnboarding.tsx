'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/routing'

type Props = {
  /** Worden gebruikt als initial values — vaak de defaults uit het profile. */
  initialLocale:     string
  initialCountry:    string
  initialDateFormat: string
  initialCurrency:   string
  initialTimezone:   string
}

/**
 * One-shot onboarding-modal die de user vraagt om zijn regionale voorkeuren
 * te bevestigen. Wordt getoond bij eerste dashboard-bezoek wanneer
 * profile.preferences_set_at NULL is.
 *
 * Smart defaults: bij wijzigen van LAND vullen we automatisch date_format,
 * currency en timezone in op de meest waarschijnlijke waarde. De user kan
 * elk veld nog handmatig overrulen.
 */
export default function PreferencesOnboarding({
  initialLocale,
  initialCountry,
  initialDateFormat,
  initialCurrency,
  initialTimezone,
}: Props) {
  const t = useTranslations('onboarding.preferences')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [locale,     setLocale]     = useState(initialLocale)
  const [country,    setCountry]    = useState(initialCountry)
  const [dateFormat, setDateFormat] = useState(initialDateFormat)
  const [currency,   setCurrency]   = useState(initialCurrency)
  const [timezone,   setTimezone]   = useState(initialTimezone)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  // Bij land-wijziging: auto-fill de andere velden met smart defaults.
  // De user kan ze daarna nog manueel veranderen voor afwijkende cases.
  function handleCountryChange(newCountry: string) {
    setCountry(newCountry)
    const defaults = COUNTRY_DEFAULTS[newCountry]
    if (defaults) {
      setDateFormat(defaults.dateFormat)
      setCurrency(defaults.currency)
      setTimezone(defaults.timezone)
      // Taal volgt enkel als ze nog niet expliciet werd gekozen — anders
      // is het irritant dat je taal-keuze overschreven wordt door land-keuze.
      if (defaults.locale && locale === initialLocale) {
        setLocale(defaults.locale)
      }
    }
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/profile/preferences', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, country, date_format: dateFormat, currency, timezone }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Save failed')
        return
      }
      // Bij locale-wijziging moeten we de pagina herladen in de nieuwe taal,
      // anders blijft de huidige render (met de oude messages) staan.
      router.refresh()
    } catch {
      setError('Network error — please try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-1">{t('title')}</h2>
        <p className="text-sm text-gray-500 mb-5">{t('subtitle')}</p>

        <div className="space-y-3">
          <Field label={t('language')}>
            <select
              value={locale}
              onChange={e => setLocale(e.target.value)}
              className="form-select w-full"
            >
              <option value="nl">Nederlands</option>
              <option value="en">English</option>
            </select>
          </Field>

          <Field label={t('country')}>
            <select
              value={country}
              onChange={e => handleCountryChange(e.target.value)}
              className="form-select w-full"
            >
              {Object.entries(COUNTRIES).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </Field>

          <Field label={t('dateFormat')}>
            <select
              value={dateFormat}
              onChange={e => setDateFormat(e.target.value)}
              className="form-select w-full"
            >
              <option value="DD/MM/YYYY">DD/MM/YYYY (06/05/2026)</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY (05/06/2026)</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD (2026-05-06)</option>
            </select>
          </Field>

          <Field label={t('currency')}>
            <select
              value={currency}
              onChange={e => setCurrency(e.target.value)}
              className="form-select w-full"
            >
              <option value="EUR">EUR (€)</option>
              <option value="USD">USD ($)</option>
              <option value="GBP">GBP (£)</option>
              <option value="CHF">CHF</option>
            </select>
          </Field>

          <Field label={t('timezone')}>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="form-select w-full"
            >
              {TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </Field>
        </div>

        {error && (
          <div className="mt-3 px-3 py-2 rounded-md bg-red-50 border border-red-100 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary disabled:opacity-50"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  )
}

// ── Smart defaults per land ───────────────────────────────────────────────

type CountryDefaults = {
  locale?:     string
  dateFormat:  string
  currency:    string
  timezone:    string
}

const COUNTRY_DEFAULTS: Record<string, CountryDefaults> = {
  BE: { locale: 'nl', dateFormat: 'DD/MM/YYYY', currency: 'EUR', timezone: 'Europe/Brussels' },
  NL: { locale: 'nl', dateFormat: 'DD/MM/YYYY', currency: 'EUR', timezone: 'Europe/Amsterdam' },
  GB: { locale: 'en', dateFormat: 'DD/MM/YYYY', currency: 'GBP', timezone: 'Europe/London' },
  IE: { locale: 'en', dateFormat: 'DD/MM/YYYY', currency: 'EUR', timezone: 'Europe/Dublin' },
  US: { locale: 'en', dateFormat: 'MM/DD/YYYY', currency: 'USD', timezone: 'America/New_York' },
  CA: { locale: 'en', dateFormat: 'YYYY-MM-DD', currency: 'CAD', timezone: 'America/Toronto' },
  FR: { locale: 'en', dateFormat: 'DD/MM/YYYY', currency: 'EUR', timezone: 'Europe/Paris' },
  DE: { locale: 'en', dateFormat: 'DD/MM/YYYY', currency: 'EUR', timezone: 'Europe/Berlin' },
  ES: { locale: 'en', dateFormat: 'DD/MM/YYYY', currency: 'EUR', timezone: 'Europe/Madrid' },
  IT: { locale: 'en', dateFormat: 'DD/MM/YYYY', currency: 'EUR', timezone: 'Europe/Rome' },
  CH: { locale: 'en', dateFormat: 'DD/MM/YYYY', currency: 'CHF', timezone: 'Europe/Zurich' },
}

const COUNTRIES: Record<string, string> = {
  BE: 'België',
  NL: 'Nederland',
  GB: 'United Kingdom',
  IE: 'Ireland',
  US: 'United States',
  CA: 'Canada',
  FR: 'France',
  DE: 'Deutschland',
  ES: 'España',
  IT: 'Italia',
  CH: 'Schweiz',
}

const TIMEZONES = [
  'Europe/Brussels',
  'Europe/Amsterdam',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Zurich',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'UTC',
]
