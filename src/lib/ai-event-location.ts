/**
 * AI-extractie van BE-provincie uit Google Calendar events.
 *
 * Voor de appointment-planner moeten we weten in welke provincie een sales
 * rep op een gegeven dag werkt. Eerste manier: hij zet een all-day event
 * in z'n agenda met de provincie-naam in de titel (bv. "WORK: Antwerpen").
 * Tweede manier: hij heeft losse afspraken-events met een klant-adres in
 * de titel of location-veld — dan parsen we die via GPT-4o-mini om de
 * provincie te raden.
 *
 * Caching:
 *   - ai_event_location_cache bewaart (event_id → province + confidence).
 *   - event_hash = SHA256 van (title|location|day) zodat we invalideren
 *     wanneer de event-content wijzigt.
 *   - Een NULL provincie wordt ook gecached zodat we niet elke refresh
 *     opnieuw GPT laten gokken op events zonder locatie-hint.
 */

import OpenAI from 'openai'
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import type { CalendarEvent } from './calendar'
import { extractRegionCode, extractProvinceAlias, BE_REGIONS } from './regions'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const PROVINCES = [
  'antwerpen', 'limburg', 'oost-vlaanderen', 'vlaams-brabant', 'west-vlaanderen',
  'henegouwen', 'luik', 'luxemburg', 'namen', 'waals-brabant', 'brussel',
] as const

type Province = typeof PROVINCES[number]

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

function hashEvent(e: CalendarEvent): string {
  const day = e.start.slice(0, 10)
  const sig = `${e.summary ?? ''}|${e.location ?? ''}|${day}`
  return createHash('sha256').update(sig).digest('hex').slice(0, 32)
}

/**
 * Probeer eerst zonder GPT: zit een provincie-naam letterlijk in de titel
 * of location? Dat dekt het 'WORK: Antwerpen'-pattern + events met explicit
 * "Klantbezoek Gent" tekst.
 */
function fastDetect(e: CalendarEvent): Province | null {
  const hay = `${e.summary ?? ''} ${e.location ?? ''}`.toLowerCase()
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâ]/g,    'a')
    .replace(/[ïî]/g,    'i')
    .replace(/[ôö]/g,    'o')
    .replace(/[ûü]/g,    'u')
  if (/\bantwerp/.test(hay))                                                                                return 'antwerpen'
  if (/\blimburg\b/.test(hay))                                                                              return 'limburg'
  if (/\boost.vlaanderen\b|\beast.flanders\b|\bgent\b|\baalst\b/.test(hay))                                  return 'oost-vlaanderen'
  if (/\bvlaams.brabant\b|\bflemish.brabant\b|\bleuven\b/.test(hay))                                        return 'vlaams-brabant'
  if (/\bwest.vlaanderen\b|\bwest.flanders\b|\bbrugge\b|\bkortrijk\b|\boostende\b/.test(hay))                return 'west-vlaanderen'
  if (/\bhainaut\b|\bhenegouwen\b|\bmons\b|\bcharleroi\b|\bbergen\b/.test(hay))                              return 'henegouwen'
  if (/\bli[eè]ge\b|\bluik\b/.test(hay))                                                                    return 'luik'
  if (/\bluxembourg\b|\bluxemburg\b|\barlon\b|\baarlen\b/.test(hay))                                         return 'luxemburg'
  if (/\bnamur\b|\bnamen\b/.test(hay))                                                                      return 'namen'
  if (/\bbrabant.wallon\b|\bwaals.brabant\b|\bwavre\b|\bnivelles\b/.test(hay))                               return 'waals-brabant'
  if (/\bbrussel\b|\bbruxelles\b|\bbrussels\b/.test(hay))                                                    return 'brussel'
  return null
}

/**
 * Probeer de provincie + eventueel region te bepalen voor één event.
 * Cache-aware. Returnt null wanneer noch fast-detect noch GPT iets oplevert.
 *
 * Stappen:
 *   1) Hash event content → cache lookup
 *   2) Region fast-detect — eerste prioriteit. Als "WVL-NW" letterlijk in de
 *      titel staat, is dat een 100% certain match én geeft het ook de
 *      bijhorende provincie weg gratis.
 *   3) Province fast-detect via regex (steden, provincienamen)
 *   4) Anders: GPT-4o-mini call (alleen als event hint-tekst heeft)
 *   5) Schrijf naar cache (ook null) zodat we 'm niet opnieuw bevragen
 *
 * NB: region wordt NIET apart in de cache opgeslagen (BE_REGIONS-codes
 * staan letterlijk in event text en zijn dus deterministisch herleidbaar).
 * We slaan alleen province in de cache; de caller berekent region zelf via
 * extractRegionCode op de event-titel/locatie.
 */
export async function detectProvinceForEvent(e: CalendarEvent): Promise<{ province: Province | null; confidence: number; signal: string; region: string | null }> {
  const hash = hashEvent(e)
  const sb   = getServiceClient()

  // Region check is altijd gratis (regex), doen we eerst zodat ook gecachte
  // events de region terugkrijgen.
  const regionFromText = extractRegionCode(`${e.summary ?? ''} ${e.location ?? ''}`)

  // 1. Cache
  const { data: cached } = await sb
    .from('ai_event_location_cache')
    .select('province, confidence, raw_signal, event_hash')
    .eq('event_id', e.id)
    .maybeSingle()

  if (cached) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = cached as any
    if (c.event_hash === hash) {
      return {
        province:   isProvince(c.province) ? c.province : null,
        confidence: c.confidence ?? 0,
        signal:     c.raw_signal ?? 'cache',
        region:     regionFromText,
      }
    }
    // Hash mismatch → event is bijgewerkt sinds laatste cache; we vervangen.
  }

  // 2. Region-code → de provincie volgt automatisch (uit BE_REGIONS config)
  if (regionFromText) {
    const cfg = BE_REGIONS.find(r => r.code === regionFromText)
    if (cfg && isProvince(cfg.province)) {
      await writeCache(e.id, hash, cfg.province, 1.0, 'region')
      return { province: cfg.province, confidence: 1.0, signal: 'region', region: regionFromText }
    }
  }

  // 3. Province fast-detect via regex
  const fast = fastDetect(e)
  if (fast) {
    await writeCache(e.id, hash, fast, 0.95, 'regex')
    return { province: fast, confidence: 0.95, signal: 'regex', region: regionFromText }
  }

  // 3b. Provincie-alias detect (vangt "WVL" / "OVL" / "ANT" / … standalone).
  // Loopt na de fastDetect omdat die specifieker is (stadnamen), maar vóór
  // GPT zodat we voor een rep die letterlijk "WVL" als titel zet geen
  // tokens verbruiken.
  const aliasText  = `${e.summary ?? ''} ${e.location ?? ''}`
  const aliasMatch = extractProvinceAlias(aliasText)
  if (aliasMatch && isProvince(aliasMatch)) {
    await writeCache(e.id, hash, aliasMatch, 0.9, 'alias')
    return { province: aliasMatch, confidence: 0.9, signal: 'alias', region: regionFromText }
  }

  // 4. GPT enkel als er tekst is om over te raden
  const text = `${e.summary ?? ''} ${e.location ?? ''}`.trim()
  if (text.length < 3) {
    await writeCache(e.id, hash, null, 0, 'empty')
    return { province: null, confidence: 0, signal: 'empty', region: regionFromText }
  }

  let aiProvince: Province | null = null
  let aiConfidence = 0
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 60,
      messages: [
        {
          role: 'system',
          content:
            'Je krijgt de titel + locatie van een Google Calendar event. Bepaal in welke Belgische provincie het event plaatsvindt. ' +
            'Antwoord ENKEL als JSON: {"province": "<slug>"|null, "confidence": 0-1}. ' +
            `Toegestane slugs: ${PROVINCES.join(', ')}. ` +
            'Als er geen duidelijke Belgische locatie in zit (bv. "Standup", "Lunch", "Vakantie", buitenlandse stad), zet province: null en confidence: 0. ' +
            'Gebruik geografische kennis: een gemeente zoals Hasselt → limburg, Antwerpen → antwerpen, Brugge → west-vlaanderen, enz.',
        },
        {
          role: 'user',
          content: `Title: ${e.summary ?? '(none)'}\nLocation: ${e.location ?? '(none)'}\nDate: ${e.start.slice(0, 10)}`,
        },
      ],
      response_format: { type: 'json_object' },
    })
    const raw = completion.choices[0]?.message?.content?.trim() ?? '{}'
    const parsed = JSON.parse(raw) as { province?: string | null; confidence?: number }
    if (parsed.province && isProvince(parsed.province)) {
      aiProvince   = parsed.province
      aiConfidence = typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : 0.5
    }
  } catch (err) {
    // Niet kritisch — provincie blijft null, slot-finder filtert die dag eruit.
    console.error('[ai-event-location] OpenAI error voor event', e.id, err)
  }

  await writeCache(e.id, hash, aiProvince, aiConfidence, 'gpt')
  return { province: aiProvince, confidence: aiConfidence, signal: 'gpt', region: regionFromText }
}

/**
 * Batch helper: detect voor meerdere events. Volgorde van resultaten matched
 * de input. Roept detectProvinceForEvent sequentieel — voor MVP fijn, voor
 * grote batches (>50 events zonder regex-hit) overwegen we parallel met
 * Promise.all + concurrency limit.
 */
export async function detectProvincesForEvents(events: CalendarEvent[]) {
  const results: { event: CalendarEvent; province: Province | null; confidence: number; region: string | null }[] = []
  for (const e of events) {
    const r = await detectProvinceForEvent(e)
    results.push({ event: e, province: r.province, confidence: r.confidence, region: r.region })
  }
  return results
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function writeCache(
  eventId:    string,
  eventHash:  string,
  province:   Province | null,
  confidence: number,
  signal:     string,
) {
  const sb = getServiceClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = {
    event_id:   eventId,
    event_hash: eventHash,
    province,
    confidence,
    raw_signal: signal,
  }
  await sb.from('ai_event_location_cache').upsert(row, { onConflict: 'event_id' })
}

function isProvince(s: unknown): s is Province {
  return typeof s === 'string' && (PROVINCES as readonly string[]).includes(s)
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}
