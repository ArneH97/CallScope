import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const VALID_LOCALES   = ['nl', 'en', 'fr', 'de']
const VALID_FORMATS   = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']

/**
 * POST /api/profile/preferences
 * Body: { locale, country, date_format, currency, timezone }
 *
 * Slaat de regionale voorkeuren op het profile op + markeert
 * preferences_set_at zodat de onboarding-modal niet meer opduikt.
 *
 * Wordt ook gebruikt vanuit account-instellingen voor latere wijzigingen.
 */
export async function POST(req: NextRequest) {
  const sb = createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const {
    locale,
    country,
    date_format,
    currency,
    timezone,
  } = body as Record<string, string>

  // Lichte validatie — Postgres CHECK-constraints vangen de rest
  if (!VALID_LOCALES.includes(locale)) {
    return NextResponse.json({ error: 'Ongeldige taal' }, { status: 400 })
  }
  if (!country || country.length !== 2) {
    return NextResponse.json({ error: 'Ongeldig land' }, { status: 400 })
  }
  if (!VALID_FORMATS.includes(date_format)) {
    return NextResponse.json({ error: 'Ongeldig datumformaat' }, { status: 400 })
  }
  if (!currency || currency.length !== 3) {
    return NextResponse.json({ error: 'Ongeldige munteenheid' }, { status: 400 })
  }
  if (!timezone) {
    return NextResponse.json({ error: 'Tijdzone vereist' }, { status: 400 })
  }

  const { error } = await sb
    .from('profiles')
    .update({
      locale,
      country:    country.toUpperCase(),
      date_format,
      currency:   currency.toUpperCase(),
      timezone,
      preferences_set_at: new Date().toISOString(),
    })
    .eq('id', user.id)

  if (error) {
    return NextResponse.json({ error: `Opslaan mislukt: ${error.message}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
