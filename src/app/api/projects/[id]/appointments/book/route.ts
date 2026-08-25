import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createCalendarEvent, CalendarScopeError } from '@/lib/calendar'

/**
 * POST /api/projects/[id]/appointments/book
 *
 * Body: { lead_id, sales_rep_id, start (ISO), end (ISO), notes? }
 *
 * Werkwijze:
 *   1) Auth + lead/project validatie
 *   2) Race-check: bestaat er al een geboekte afspraak in dit tijdvenster
 *      voor de sales rep? Zo ja → 409 Conflict (UI vraagt opnieuw slots).
 *   3) Calendar event aanmaken in de Google Calendar van de sales rep.
 *      Bij scope-fout → 403 met reauth-hint terug naar client.
 *   4) DB-record schrijven met google_calendar_event_id.
 *   5) Lead.status → 'booked'.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: {
    lead_id?:      string
    sales_rep_id?: string
    start?:        string
    end?:          string
    notes?:        string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!body.lead_id || !body.sales_rep_id || !body.start || !body.end) {
    return NextResponse.json({ error: 'lead_id, sales_rep_id, start, end verplicht' }, { status: 400 })
  }

  const start = new Date(body.start)
  const end   = new Date(body.end)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return NextResponse.json({ error: 'Ongeldige datums' }, { status: 400 })
  }

  // Lead ophalen + project-validatie
  const { data: leadRow, error: leadErr } = await supabase
    .from('lead_pool')
    .select('id, project_id, business_name, address, status')
    .eq('id', body.lead_id)
    .single()
  if (leadErr || !leadRow) return NextResponse.json({ error: 'Lead niet gevonden' }, { status: 404 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = leadRow as any
  if (lead.project_id !== params.id) {
    return NextResponse.json({ error: 'Lead hoort niet bij dit project' }, { status: 400 })
  }
  if (lead.status === 'booked') {
    return NextResponse.json({ error: 'Deze lead heeft al een geboekte afspraak.' }, { status: 409 })
  }

  // Race-check: bestaande booking in overlap?
  const { data: conflicts } = await supabase
    .from('appointment_bookings')
    .select('id, scheduled_start, scheduled_end')
    .eq('sales_rep_id', body.sales_rep_id)
    .neq('status', 'cancelled')
    .lt('scheduled_start', end.toISOString())
    .gt('scheduled_end',   start.toISOString())
  if (conflicts && conflicts.length > 0) {
    return NextResponse.json(
      { error: 'Sales rep is intussen al geboekt voor dit slot. Probeer opnieuw.' },
      { status: 409 },
    )
  }

  // Calendar event aanmaken in de Google Calendar van de sales rep
  let calendarEventId: string | null = null
  try {
    const ev = await createCalendarEvent(body.sales_rep_id, {
      summary:     `Afspraak ${lead.business_name}`,
      description: [
        `Lead: ${lead.business_name}`,
        `Adres: ${lead.address}`,
        body.notes?.trim() ? '' : null,
        body.notes?.trim() ? `Notitie van cold caller:\n${body.notes.trim()}` : null,
        '',
        'Geboekt via CallScope.',
      ].filter(Boolean).join('\n'),
      location: lead.address,
      start,
      end,
    })
    calendarEventId = ev.id
  } catch (e) {
    if (e instanceof CalendarScopeError) {
      return NextResponse.json({
        error:        'De sales rep heeft de Google Calendar koppeling nog niet bijgewerkt.',
        scope_error:  true,
      }, { status: 403 })
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Calendar event aanmaken mislukt' },
      { status: 500 },
    )
  }

  // DB-record
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookingRow: any = {
    lead_id:                   body.lead_id,
    project_id:                params.id,
    sales_rep_id:              body.sales_rep_id,
    cold_caller_id:            user.id,
    scheduled_start:           start.toISOString(),
    scheduled_end:             end.toISOString(),
    caller_notes:              body.notes?.trim() || null,
    google_calendar_event_id:  calendarEventId,
    status:                    'booked',
  }
  const { data: booking, error: bErr } = await supabase
    .from('appointment_bookings')
    .insert(bookingRow)
    .select('id')
    .single()
  if (bErr) {
    // We hebben wel al een calendar event aangemaakt — dat blijft staan,
    // wat acceptabel is voor MVP (de rep heeft het op z'n agenda; cold
    // caller kan met de cc_manager handmatig de booking opslaan).
    return NextResponse.json(
      { error: `DB insert mislukt na calendar create: ${bErr.message}`, calendar_event_id: calendarEventId },
      { status: 500 },
    )
  }

  // Lead op 'booked' zetten
  await supabase.from('lead_pool')
    .update({ status: 'booked' })
    .eq('id', body.lead_id)

  return NextResponse.json({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    booking_id:        (booking as any).id,
    calendar_event_id: calendarEventId,
  })
}
