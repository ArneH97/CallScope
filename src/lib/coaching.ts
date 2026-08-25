/**
 * AI-coaching voor cold callers.
 *
 * Verzamelt de laatste 30 dagen aan call-data van één caller (uit alle
 * projecten waaraan hij meewerkt), aggregaten + sample notes, en stuurt dat
 * naar GPT-4o-mini voor een gepersonaliseerd advies. Het resultaat wordt in
 * caller_coaching_insights gecached zodat we niet bij elke dashboard-bezoek
 * opnieuw aanroepen.
 */

import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export type CoachingContext = {
  total_calls:      number
  reached:          number
  appointments:     number
  reach_rate:       number    // percentage
  conv_rate:        number    // afspraken / bereikt
  top_objections:   { label: string; count: number }[]
  sample_notes:     string[]
  period_days:      number
}

export type CoachingResult = {
  advice_text: string
  context:     CoachingContext
}

/**
 * Genereer een coaching-advies voor één caller. Doet drie dingen:
 *   1. Pull caller's call_records van de laatste 30 dagen
 *   2. Aggreggeer (reach %, conv %, top bezwaren via bestaande analyses, sample notes)
 *   3. Vraag GPT-4o-mini om een advies van ±200 woorden
 *
 * Returnt het advies + de context waarop het gebaseerd is.
 * Slaat NIET automatisch op — caller is responsible: callsite kiest zelf
 * wanneer/of het in DB landt.
 */
export async function generateCallerCoaching(callerId: string): Promise<CoachingResult | null> {
  const sb = getServiceClient()

  const fromIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const toIso   = new Date().toISOString().slice(0, 10)

  // 1. Pak alle uploads van deze caller en hun call_records
  const { data: uploadsData } = await sb
    .from('uploads')
    .select('id')
    .eq('caller_id', callerId)
  const uploadIds = ((uploadsData ?? []) as { id: string }[]).map(u => u.id)

  if (uploadIds.length === 0) return null

  const { data: callRows } = await sb
    .from('call_records')
    .select('status, notes, call_date')
    .in('upload_id', uploadIds)
    .gte('call_date', fromIso)
    .lte('call_date', toIso)

  type CR = { status: string | null; notes: string | null; call_date: string | null }
  const records = (callRows ?? []) as CR[]

  if (records.length === 0) return null

  // 2. Aggregeer
  const total = records.length
  const reached = records.filter(r => {
    const s = (r.status ?? '').toLowerCase()
    return s && !['niet bereikt', 'no answer', 'voicemail', 'vm', 'geen gehoor', 'nv'].some(k => s.includes(k))
  }).length
  const appointments = records.filter(r => /afspraak|appointment/i.test(r.status ?? '')).length

  const reach_rate = total > 0   ? Math.round((reached      / total)   * 100) : 0
  const conv_rate  = reached > 0 ? Math.round((appointments / reached) * 100) : 0

  // Top bezwaren — uit bestaande analyses op zijn uploads
  const { data: anaRows } = await sb
    .from('analyses')
    .select('objections')
    .in('upload_id', uploadIds)

  type Ana = { objections: { label: string; count: number }[] | null }
  const objMap = new Map<string, number>()
  for (const a of (anaRows ?? []) as Ana[]) {
    for (const o of a.objections ?? []) {
      objMap.set(o.label, (objMap.get(o.label) ?? 0) + (o.count ?? 0))
    }
  }
  const top_objections = Array.from(objMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }))

  // Sample notes — neem 8 willekeurige niet-lege notes voor de prompt
  const allNotes = records.map(r => r.notes).filter((n): n is string => !!n && n.trim().length > 5)
  const sample_notes = pickRandom(allNotes, 8)

  const context: CoachingContext = {
    total_calls:    total,
    reached,
    appointments,
    reach_rate,
    conv_rate,
    top_objections,
    sample_notes,
    period_days:    30,
  }

  // 3. Vraag GPT om gepersonaliseerd advies
  const prompt = buildPrompt(context)

  let advice_text = ''
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: 'Je bent een ervaren cold-call coach met empathie. Geef praktische, specifieke en concrete adviezen aan B2B cold callers. Schrijf in het Nederlands, in de jij-vorm. Wees direct maar nooit hard. Geen platitudes, geen "blijf positief"-cliché.',
        },
        { role: 'user', content: prompt },
      ],
    })
    advice_text = completion.choices[0]?.message?.content?.trim() ?? ''
  } catch (e) {
    console.error('[coaching] OpenAI error:', e)
    return null
  }

  if (!advice_text) return null

  return { advice_text, context }
}

/**
 * Genereer + sla op in DB (UPSERT op caller_id). Return het opgeslagen object
 * inclusief generated_at zodat de UI kan tonen "laatst bijgewerkt op X".
 */
export async function generateAndStoreCoaching(callerId: string): Promise<{
  advice_text:     string
  context_summary: CoachingContext
  generated_at:    string
} | null> {
  const result = await generateCallerCoaching(callerId)
  if (!result) return null

  const sb = getServiceClient()
  const generatedAt = new Date().toISOString()

  await sb.from('caller_coaching_insights').upsert({
    caller_id:       callerId,
    advice_text:     result.advice_text,
    context_summary: result.context,
    generated_at:    generatedAt,
  }, { onConflict: 'caller_id' })

  return {
    advice_text:     result.advice_text,
    context_summary: result.context,
    generated_at:    generatedAt,
  }
}

// ── Prompt-builder ────────────────────────────────────────────────────────

function buildPrompt(c: CoachingContext): string {
  const objectionsList = c.top_objections.length > 0
    ? c.top_objections.map((o, i) => `  ${i + 1}. "${o.label}" (${o.count}×)`).join('\n')
    : '  (geen bezwaren gedetecteerd in de notities)'

  const notesList = c.sample_notes.length > 0
    ? c.sample_notes.map((n, i) => `  ${i + 1}. ${n.slice(0, 200)}`).join('\n')
    : '  (geen detaileerde notities meegegeven)'

  return `Een cold caller heeft de afgelopen 30 dagen gewerkt en wil concrete coaching. Hier is zijn data:

PRESTATIES:
- Aantal gebelde leads: ${c.total_calls}
- Bereikt (iemand aan de lijn): ${c.reached} (${c.reach_rate}%)
- Afspraken gemaakt: ${c.appointments} (${c.conv_rate}% conversie van bereikt)

TOP BEZWAREN (uit zijn callnotities, AI-gedetecteerd):
${objectionsList}

VOORBEELDEN VAN ZIJN CALLNOTITIES:
${notesList}

SCHRIJF NU EEN COACHING-ADVIES van ongeveer 200 woorden, opgesplitst in 2-3 alinea's. Format:

1. Begin met één observatie wat hij/zij goed doet of waar er groei zit (kort, 1-2 zinnen).
2. Geef 1-2 ZEER concrete tips om zijn conversie te verbeteren, gebaseerd op de bezwaren én de notities. Wees specifiek: noem échte zinnen die hij kan gebruiken bij het meest voorkomende bezwaar. Geen vaagheid, geen "verbeter je openingszin" zonder voorbeeld.
3. Sluit af met één moedgevende, niet-clichématige observatie of vraag.

Als de data te dun is voor scherp advies (weinig calls, geen notities) — zeg dat dan eerlijk en geef advies in plaats daarvan voor het verzamelen van betere data (uitgebreidere notities tijdens het bellen).

Schrijf direct, geen koppen, geen bullet points, geen "Beste cold caller". Begin met een directe observatie.`
}

// ── Utilities ────────────────────────────────────────────────────────────

function pickRandom<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice()
  const result: T[] = []
  const used = new Set<number>()
  while (result.length < n && used.size < arr.length) {
    const idx = Math.floor(Math.random() * arr.length)
    if (used.has(idx)) continue
    used.add(idx)
    result.push(arr[idx])
  }
  return result
}
