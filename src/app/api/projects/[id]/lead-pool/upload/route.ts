import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { geocodeAddress } from '@/lib/geocoding'

/**
 * POST /api/projects/[id]/lead-pool/upload
 *
 * Body: { leads: [{ business_name, address }, ...] } — max 500 per request.
 * De client doet CSV/Excel parsing en stuurt al gestructureerde rijen.
 *
 * Werkwijze:
 *   1) Auth + project-toegang check
 *   2) Insert rijen met geocode_status='pending'
 *   3) Parallel geocoding (concurrency 10) — voor 500 leads ≈ 10-25 sec
 *      afhankelijk van cache hit rate.
 *   4) Update rijen met geocode resultaat (ok/failed) + lat/lng + provincie
 *   5) Return summary { inserted, geocoded_ok, geocoded_failed }
 *
 * Vercel timeout: we vragen 60 sec aan (Vercel Pro respecteert dit; op Hobby
 * blijft het 10 sec). Google Maps Geocoding API rate limit is 50 QPS — met
 * concurrency 10 zitten we ruim onder dat plafond.
 */

// Vraag Vercel om tot 60 sec voor deze route (Pro plan benut dit; Hobby
// blijft op 10 sec en zal bij grote batches een 504 geven — splits dan).
export const maxDuration = 60

const MAX_LEADS_PER_REQUEST = 500
const GEOCODE_CONCURRENCY  = 10

type LeadInput = { business_name: string; address: string }

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const projectId = params.id

  let body: { leads?: LeadInput[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const leads = Array.isArray(body.leads) ? body.leads : []
  if (leads.length === 0) {
    return NextResponse.json({ error: 'Geen leads aangeleverd' }, { status: 400 })
  }
  if (leads.length > MAX_LEADS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Te veel leads in één keer (max ${MAX_LEADS_PER_REQUEST}). Splits in batches.` },
      { status: 400 },
    )
  }

  // Sanity: business_name + address verplicht
  for (const l of leads) {
    if (!l.business_name?.trim() || !l.address?.trim()) {
      return NextResponse.json({ error: 'Elke lead heeft business_name + address nodig' }, { status: 400 })
    }
  }

  // Insert als 'pending'. RLS-policy check loopt automatisch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertRows: any[] = leads.map(l => ({
    project_id:     projectId,
    business_name:  l.business_name.trim(),
    address:        l.address.trim(),
    geocode_status: 'pending',
    created_by:     user.id,
  }))
  const { data: inserted, error: insertErr } = await supabase
    .from('lead_pool')
    .insert(insertRows)
    .select('id, address')
  if (insertErr) {
    return NextResponse.json({ error: `DB insert mislukt: ${insertErr.message}` }, { status: 500 })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const insertedRows = (inserted ?? []) as any[]

  // Parallel geocoding met concurrency-limit. Voor 500 leads: 500/10 batches
  // van 10 parallel = ~50 batches. Bij ~200ms gemiddelde geocode response
  // duurt dit ~10 sec. Bij veel cache-hits (re-upload) zit het onder 2 sec.
  //
  // Google Maps Geocoding API rate limit = 50 QPS. 10 parallel zit ruim onder
  // dat plafond — geen 429-errors verwacht. Per call schrijven we direct het
  // resultaat naar DB zodat we niet 500 results in memory hoeven te buffer'en.
  let okCount = 0
  let failCount = 0
  for (let i = 0; i < insertedRows.length; i += GEOCODE_CONCURRENCY) {
    const chunk = insertedRows.slice(i, i + GEOCODE_CONCURRENCY)
    await Promise.all(chunk.map(async row => {
      const outcome = await geocodeAddress(row.address)
      if (outcome.ok) {
        okCount++
        await supabase
          .from('lead_pool')
          .update({
            postal_code:    outcome.result.postal_code,
            city:           outcome.result.city,
            province:       outcome.result.province,
            region:         outcome.result.region,
            country_code:   outcome.result.country_code,
            latitude:       outcome.result.latitude,
            longitude:      outcome.result.longitude,
            geocode_status: 'ok',
            geocode_error:  null,
            geocoded_at:    new Date().toISOString(),
          })
          .eq('id', row.id)
      } else {
        failCount++
        await supabase
          .from('lead_pool')
          .update({
            geocode_status: 'failed',
            geocode_error:  outcome.error,
            geocoded_at:    new Date().toISOString(),
          })
          .eq('id', row.id)
      }
    }))
  }

  return NextResponse.json({
    inserted:         insertedRows.length,
    geocoded_ok:      okCount,
    geocoded_failed:  failCount,
  })
}
