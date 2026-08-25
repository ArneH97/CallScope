import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { findTopSlotsForLead } from '@/lib/slot-finder'

/**
 * POST /api/projects/[id]/appointments/find-slots
 *
 * Body: { lead_id: string }
 *
 * Pakt de provincie van de lead en delegeert naar de slot-finder. Returns
 * top 3 voorgestelde slots + lijst van sales reps die hun calendar-scope
 * nog niet toegekend hebben (UI gebruikt dat voor de reauth-banner).
 *
 * RLS in lead_pool zorgt dat de caller alleen leads van een project waar
 * hij member van is kan ophalen — geen aparte auth-check nodig hier.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { lead_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body.lead_id) {
    return NextResponse.json({ error: 'lead_id verplicht' }, { status: 400 })
  }

  const { data: leadRow, error: leadErr } = await supabase
    .from('lead_pool')
    .select('id, project_id, business_name, address, province, region, geocode_status')
    .eq('id', body.lead_id)
    .single()
  if (leadErr || !leadRow) {
    return NextResponse.json({ error: 'Lead niet gevonden' }, { status: 404 })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = leadRow as any
  if (lead.project_id !== params.id) {
    return NextResponse.json({ error: 'Lead hoort niet bij dit project' }, { status: 400 })
  }
  if (lead.geocode_status !== 'ok' || !lead.province) {
    return NextResponse.json({
      error:    'Lead heeft nog geen geldige provincie (geocoding niet gelukt).',
      diagnostic: { geocode_status: lead.geocode_status, province: lead.province },
    }, { status: 422 })
  }

  try {
    const result = await findTopSlotsForLead({
      projectId:    lead.project_id,
      leadProvince: lead.province,
      leadRegion:   lead.region,    // bv. 'WVL-NW' (null buiten BE_REGIONS)
      topN:         3,
    })
    return NextResponse.json({
      lead: {
        id:            lead.id,
        business_name: lead.business_name,
        address:       lead.address,
        province:      lead.province,
        region:        lead.region,
      },
      slots: result.slots.map(s => ({
        sales_rep_id:    s.salesRepId,
        sales_rep_name:  s.salesRepName,
        sales_rep_email: s.salesRepEmail,
        start:           s.start.toISOString(),
        end:             s.end.toISOString(),
        province:        s.province,
        match_reason:    s.matchReason,
      })),
      reps_missing_calendar_scope: result.repsMissingCalendarScope,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Slot-finder error' },
      { status: 500 },
    )
  }
}
