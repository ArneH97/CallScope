import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import type { AppointmentStatus, DealstageCategory, Outcome } from '@/types/database'

/**
 * Mapping van canonical dealstage → (outcome, appointment_status).
 * Sheet is single source of truth — bij sync overschrijven we deze twee
 * velden op appointment_feedback. Notes, rating en sales_rep_id blijven
 * intact zodat manuele input van de rep niet verloren gaat.
 *
 * 'other' wordt bewust NIET gemapt: we laten outcome/status met rust zodat
 * de rep zelf kan invullen.
 */
const DEALSTAGE_TO_FEEDBACK: Partial<Record<DealstageCategory, {
  outcome: Outcome
  appointment_status: AppointmentStatus
}>> = {
  won:         { outcome: 'deal',      appointment_status: 'uitgevoerd' },
  lost:        { outcome: 'verloren',  appointment_status: 'uitgevoerd' },
  offerte:     { outcome: 'offerte',   appointment_status: 'uitgevoerd' },
  in_progress: { outcome: 'follow_up', appointment_status: 'uitgevoerd' },
  no_show:     { outcome: 'geen',      appointment_status: 'no_show'    },
}

/**
 * POST /api/projects/[id]/classify-dealstages
 *
 * Pakt alle distinct dealstage_raw waardes voor dit project waar
 * dealstage_classified_at IS NULL, vraagt GPT om elke waarde te classificeren
 * naar een van { won, lost, in_progress, no_show, other }, en update zowel
 * call_records (dealstage_category) als appointment_feedback (outcome +
 * appointment_status) zodat de sheet de single source of truth is.
 */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const CANONICAL: DealstageCategory[] = ['won', 'lost', 'offerte', 'in_progress', 'no_show', 'other']

function isCategory(s: unknown): s is DealstageCategory {
  return typeof s === 'string' && CANONICAL.includes(s as DealstageCategory)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id

  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') ?? ''
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`

  if (!isCron) {
    const supabase = createSbClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }
    const { data: prof } = await supabase
      .from('profiles').select('role').eq('id', user.id).single()
    const role = (prof as { role?: string } | null)?.role
    if (role !== 'cc_manager' && role !== 'sales_manager') {
      return NextResponse.json({ error: 'Onvoldoende rechten' }, { status: 403 })
    }
  }

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  const { data: rawRows, error: rErr } = await sb
    .from('call_records')
    .select('dealstage_raw')
    .eq('project_id', projectId)
    .not('dealstage_raw', 'is', null)
    .is('dealstage_classified_at', null)

  if (rErr) {
    return NextResponse.json({ error: `Records ophalen mislukt: ${rErr.message}` }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const distinct = Array.from(new Set(((rawRows ?? []) as any[]).map(r => r.dealstage_raw).filter(Boolean))) as string[]

  if (distinct.length === 0) {
    return NextResponse.json({ ok: true, classified: 0, message: 'Niets te classificeren' })
  }

  let mapping: Record<string, DealstageCategory> = {}
  try {
    const prompt = [
      'Je krijgt een lijst sales-pipeline labels uit een Google Sheet, in het Nederlands of Engels.',
      'Deze labels staan op AFSPRAKEN — afspraken zijn al ingepland en gebeuren of zijn gebeurd.',
      'In deze context wijst het label dus op de UITKOMST van de afspraak, niet op een lopende pipeline-stage.',
      '',
      'Classificeer elk label naar exact een canonieke categorie:',
      '',
      '  - "won":         de deal is GEWONNEN / afgesloten ten gunste van ons.',
      '                   Voorbeelden: "Deal", "Closed Won", "Won", "Gesloten", "Verkocht", "Getekend",',
      '                   "Akkoord", "Contract", "Sale", "Sold", "Closed", "Bevestigd"',
      '',
      '  - "lost":        de deal is VERLOREN / afgewezen / niet doorgegaan om commerciele reden.',
      '                   Voorbeelden: "Verloren", "Closed Lost", "Lost", "No-go", "Afgewezen",',
      '                   "Niet geinteresseerd", "Niet door", "Geen interesse", "Niet akkoord"',
      '',
      '  - "offerte":     er is een OFFERTE / VOORSTEL verstuurd. Specifiek voor labels die',
      '                   expliciet naar een offerte- of voorsteldocument verwijzen.',
      '                   Voorbeelden: "Offerte", "Offerte verstuurd", "Voorstel", "Voorstel verstuurd",',
      '                   "Quote", "Quote sent", "Proposal", "Proposal Sent", "Aanbod"',
      '',
      '  - "in_progress": deal is nog lopend, maar GEEN OFFERTE expliciet vermeld. Generieke opvolging.',
      '                   Voorbeelden: "Negotiation", "In opvolging", "Follow-up", "Bedenkperiode",',
      '                   "Pending", "Lopend", "In behandeling", "Opvolgen"',
      '',
      '  - "no_show":     de afspraak GING NIET DOOR omdat de klant niet kwam opdagen.',
      '                   Voorbeelden: "No Show", "Niet verschenen", "Niet komen opdagen", "No-show"',
      '',
      '  - "other":       past echt in geen van bovenstaande (bv. "test", "n/a", "?", administratie).',
      '                   Bij twijfel of een label voor wonnen of verloren staat, kies de meest waarschijnlijke',
      '                   van die twee — niet "other".',
      '',
      'Antwoord ALLEEN als JSON-object met de input-strings als keys en de categorie als waarde.',
      'Geen extra tekst, uitleg of markdown.',
      '',
      'Input labels:',
      JSON.stringify(distinct, null, 2),
    ].join('\n')

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Je bent een sales-data classifier. Antwoord altijd in geldig JSON.' },
        { role: 'user',   content: prompt },
      ],
      temperature: 0,
    })

    const content = completion.choices[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(content) as Record<string, unknown>

    for (const raw of distinct) {
      const v = parsed[raw]
      mapping[raw] = isCategory(v) ? v : 'other'
    }
  } catch (e) {
    console.error('[classify-dealstages] OpenAI error:', e)
    mapping = Object.fromEntries(distinct.map(r => [r, 'other' as DealstageCategory]))
  }

  const grouped = new Map<DealstageCategory, string[]>()
  for (const [raw, cat] of Object.entries(mapping)) {
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(raw)
  }

  let totalClassified = 0
  let totalFeedbackUpdated = 0
  for (const [category, rawValues] of Array.from(grouped.entries())) {
    // 1) call_records bijwerken: category + classified_at zetten zodat de
    //    classifier deze rijen niet opnieuw oppakt.
    const { data: updated, error: uErr } = await sb
      .from('call_records')
      .update({
        dealstage_category:      category,
        dealstage_classified_at: new Date().toISOString(),
      })
      .eq('project_id', projectId)
      .in('dealstage_raw', rawValues)
      .is('dealstage_classified_at', null)
      .select('id')

    if (uErr) {
      console.error('[classify-dealstages] update error for', category, ':', uErr)
      continue
    }
    totalClassified += updated?.length ?? 0

    // 2) appointment_feedback bijwerken: outcome + appointment_status zetten
    //    op basis van de mapping. Sheet wint, dus we overschrijven onvoorwaardelijk
    //    (notes/rating/sales_rep_id blijven via de update-set intact omdat we
    //    die kolommen niet meegeven). Geen mapping voor 'other' → skip.
    const fbMapping = DEALSTAGE_TO_FEEDBACK[category]
    if (!fbMapping) continue

    const { data: crIds } = await sb
      .from('call_records')
      .select('id')
      .eq('project_id', projectId)
      .in('dealstage_raw', rawValues)

    const ids = (crIds ?? []).map((r: { id: string }) => r.id)
    if (ids.length === 0) continue

    const { data: fbUpdated, error: fbErr } = await sb
      .from('appointment_feedback')
      .update({
        outcome:            fbMapping.outcome,
        appointment_status: fbMapping.appointment_status,
        updated_at:         new Date().toISOString(),
      })
      .in('call_record_id', ids)
      .select('id')

    if (fbErr) {
      console.error('[classify-dealstages] feedback update error for', category, ':', fbErr)
    } else {
      totalFeedbackUpdated += fbUpdated?.length ?? 0
    }
  }

  return NextResponse.json({
    ok:               true,
    distinctRaw:      distinct.length,
    classified:       totalClassified,
    feedbackUpdated:  totalFeedbackUpdated,
    mapping,
  })
}
