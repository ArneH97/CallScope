/**
 * Google Maps Geocoding wrapper met cache.
 *
 * Doel: addressen omzetten naar lat/lng + postcode + provincie. Zoals de
 * appointment-planner ze gebruikt: lead-upload → batch geocode → opslaan in
 * lead_pool. Provincie is de cruciale output, want daarop matchen we sales
 * reps die die dag in dezelfde provincie werken.
 *
 * Caching:
 *   - geocode_cache tabel bewaart elke unieke (genormaliseerde) input zodat
 *     re-uploads / duplicate addressen geen extra Google-calls kosten.
 *   - Cache-key = `${address.toLowerCase().trim()}` — eenvoudig maar dekt 90%
 *     van de duplicaten. Voor diepere normalisatie (afkortingen, spelling)
 *     vertrouwen we op Google zelf — Google returnt voor "Grote Markt 1, Gent"
 *     en "grote markt 1 9000 gent" hetzelfde resultaat.
 *
 * Niet inbegrepen:
 *   - Reverse geocoding (lat/lng → adres) — niet nodig voor planner-flow.
 *   - Place autocomplete — alleen Geocoding API, geen Places.
 */

import { createClient } from '@supabase/supabase-js'
import { pickRegion } from './regions'

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'

export type GeocodeResult = {
  formatted_address: string
  postal_code:       string | null
  city:              string | null
  province:          string | null
  /** Sub-regio (bv. 'WVL-NW') op basis van postcode + BE_REGIONS mapping.
   *  NULL wanneer er geen mapping is voor deze postcode. */
  region:            string | null
  country_code:      string | null
  latitude:          number
  longitude:         number
}

export type GeocodeOutcome =
  | { ok: true;  result: GeocodeResult }
  | { ok: false; error: string }

/**
 * Service-role client. Bypasst RLS om de cache te kunnen lezen + schrijven
 * zonder dat er user-context nodig is. Alleen server-side gebruiken.
 */
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

function normalizeAddress(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Hoofdfunctie: geocode een adres. Checkt eerst cache, anders Google.
 * Geen retries of rate-limit handling — caller bepaalt hoe vaak parallel.
 */
export async function geocodeAddress(rawAddress: string): Promise<GeocodeOutcome> {
  const key = normalizeAddress(rawAddress)
  if (!key) return { ok: false, error: 'Leeg adres' }

  const sb = getServiceClient()

  // 1. Cache lookup
  const { data: cached } = await sb
    .from('geocode_cache')
    .select('*')
    .eq('normalized_address', key)
    .maybeSingle()

  if (cached) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = cached as any
    if (c.status === 'ok' && c.latitude != null && c.longitude != null) {
      // region wordt niet in cache opgeslagen (BE_REGIONS kan wijzigen zonder
      // dat oude cache rows hoeven te updaten). We berekenen 'm telkens uit
      // de cached postcode — goedkoop en altijd up-to-date.
      return {
        ok: true,
        result: {
          formatted_address: c.formatted_address ?? rawAddress,
          postal_code:       c.postal_code,
          city:              c.city,
          province:          c.province,
          region:            pickRegion(c.postal_code)?.code ?? null,
          country_code:      c.country_code,
          latitude:          c.latitude,
          longitude:         c.longitude,
        },
      }
    }
    if (c.status === 'failed') {
      return { ok: false, error: c.error_message ?? 'Geocoding eerder mislukt' }
    }
  }

  // 2. Live Google call
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return { ok: false, error: 'GOOGLE_MAPS_API_KEY niet geconfigureerd' }
  }

  const params = new URLSearchParams({
    address:  rawAddress,
    key:      apiKey,
    language: 'nl',                 // voor BE-resultaten: Vlaamse benamingen
    region:   'be',                 // bias naar België
    // components: 'country:BE',    // strikter? laat dit weg zodat NL/FR ook werken
  })

  let outcome: GeocodeOutcome
  try {
    const res = await fetch(`${GOOGLE_GEOCODE_URL}?${params}`)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      outcome = { ok: false, error: `Google ${res.status}: ${body.slice(0, 200)}` }
    } else {
      const data = await res.json() as GoogleGeocodeResponse
      if (data.status === 'OK' && data.results.length > 0) {
        outcome = { ok: true, result: parseGoogleResult(data.results[0]) }
      } else if (data.status === 'ZERO_RESULTS') {
        outcome = { ok: false, error: 'Geen resultaat voor dit adres' }
      } else {
        outcome = { ok: false, error: `Google status: ${data.status}${data.error_message ? ' — ' + data.error_message : ''}` }
      }
    }
  } catch (e) {
    outcome = { ok: false, error: e instanceof Error ? e.message : 'Netwerkfout' }
  }

  // 3. Cache writen — ook bij failure, om herhaalde lookups te vermijden
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsert: any = outcome.ok
    ? {
        normalized_address: key,
        formatted_address:  outcome.result.formatted_address,
        postal_code:        outcome.result.postal_code,
        city:               outcome.result.city,
        province:           outcome.result.province,
        country_code:       outcome.result.country_code,
        latitude:           outcome.result.latitude,
        longitude:          outcome.result.longitude,
        status:             'ok',
        error_message:      null,
      }
    : {
        normalized_address: key,
        status:             'failed',
        error_message:      outcome.error,
      }
  // Best-effort — als cache write faalt, returnen we toch het resultaat.
  await sb.from('geocode_cache').upsert(upsert, { onConflict: 'normalized_address' })

  return outcome
}

/**
 * Batch helper: geocode meerdere addressen sequentieel met een kleine delay
 * om Google's rate limit (50qps default) ruim onder te blijven. Returnt
 * één outcome per input in dezelfde volgorde.
 */
export async function geocodeAddressesBatch(
  addresses: string[],
  delayMs = 50,
): Promise<GeocodeOutcome[]> {
  const results: GeocodeOutcome[] = []
  for (const addr of addresses) {
    results.push(await geocodeAddress(addr))
    if (delayMs > 0) await sleep(delayMs)
  }
  return results
}

// ── Google response parsing ────────────────────────────────────────────────

type GoogleGeocodeResponse = {
  status:        string
  error_message?: string
  results: {
    formatted_address: string
    geometry: { location: { lat: number; lng: number } }
    address_components: {
      long_name:  string
      short_name: string
      types:      string[]
    }[]
  }[]
}

function parseGoogleResult(r: GoogleGeocodeResponse['results'][number]): GeocodeResult {
  let postalCode:   string | null = null
  let city:         string | null = null
  let province:     string | null = null
  let countryCode:  string | null = null

  for (const c of r.address_components) {
    if (c.types.includes('postal_code'))                                   postalCode  = c.long_name
    if (c.types.includes('locality'))                                       city        = c.long_name
    if (c.types.includes('administrative_area_level_2'))                    province    = mapProvinceName(c.long_name)
    if (c.types.includes('country'))                                        countryCode = c.short_name
  }

  return {
    formatted_address: r.formatted_address,
    postal_code:       postalCode,
    city,
    province,
    // Map postcode → region (bv. '8000' → 'WVL-NW'). NULL als geen
    // sub-regio bekend voor deze postcode.
    region:            pickRegion(postalCode)?.code ?? null,
    country_code:      countryCode,
    latitude:          r.geometry.location.lat,
    longitude:         r.geometry.location.lng,
  }
}

/**
 * Google geeft provincie-namen terug in NL of EN afhankelijk van language=
 * parameter. We normaliseren naar lowercase slugs zodat matching met sales
 * rep availability werkt zonder accent/case-gedoe.
 *
 * Output: 'antwerpen', 'limburg', 'oost-vlaanderen', 'vlaams-brabant',
 *         'west-vlaanderen', 'henegouwen', 'luik', 'luxemburg', 'namen',
 *         'waals-brabant', 'brussel' — of de raw lowercase als geen match.
 */
function mapProvinceName(raw: string): string {
  const s = raw.toLowerCase().trim()
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâ]/g,    'a')
    .replace(/[ïî]/g,    'i')
    .replace(/[ôö]/g,    'o')
    .replace(/[ûü]/g,    'u')
  // Mapping van Nederlandstalige + Franstalige varianten naar onze canonieke slug
  if (/antwerp/.test(s))                                                    return 'antwerpen'
  if (/limburg/.test(s))                                                    return 'limburg'
  if (/east.flanders|oost.vlaanderen/.test(s))                              return 'oost-vlaanderen'
  if (/flemish.brabant|vlaams.brabant/.test(s))                             return 'vlaams-brabant'
  if (/west.flanders|west.vlaanderen/.test(s))                              return 'west-vlaanderen'
  if (/hainaut|henegouwen/.test(s))                                         return 'henegouwen'
  if (/liege|luik/.test(s))                                                 return 'luik'
  if (/luxembourg|luxemburg/.test(s))                                       return 'luxemburg'
  if (/namur|namen/.test(s))                                                return 'namen'
  if (/walloon.brabant|brabant.wallon|waals.brabant/.test(s))               return 'waals-brabant'
  if (/brussel|bruxelles|brussels/.test(s))                                 return 'brussel'
  return s
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
