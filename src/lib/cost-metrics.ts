/**
 * Helper om kost-metrics te berekenen voor een project over een datumperiode.
 *
 * Gebruikt:
 *   - project_caller_rates: per (project, caller) preset + tarief
 *   - weekly_hour_confirmations: bevestigde uren per week (fallback = preset)
 *   - call_records: leads + afspraken
 *   - appointment_feedback: deals
 *
 * Returnt null als er geen tarieven zijn ingesteld voor dit project (= feature
 * is uitgeschakeld voor deze klant).
 */

import { createClient } from '@supabase/supabase-js'

export type CostMetrics = {
  total_hours:       number
  total_cost:        number
  currency:          string
  leads:             number
  appointments:      number
  deals:             number
  hours_per_appt:    number | null
  hours_per_deal:    number | null
  cost_per_lead:     number | null
  cost_per_appt:     number | null
  cost_per_deal:     number | null
  per_caller: Array<{
    caller_id:   string
    caller_name: string
    hours:       number
    cost:        number
    confirmed:   boolean        // false = fallback op preset, niet bevestigd
  }>
}

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

/**
 * Bereken kost-metrics voor één project tussen [fromIso, toIso] (inclusief).
 * `fromIso` en `toIso` zijn ISO-timestamps mét timezone (bv. ZULU "Z" of
 * "+02:00"). Een date-only string ("2026-05-01") werkt ook maar valt op UTC-
 * middernacht — wat een 1-2 uur shift kan geven voor users in andere TZ.
 * Voor maand-pickers MUST de caller daarom volledige ISO doorgeven.
 */
export async function calcProjectCostMetrics(
  projectId: string,
  fromIso:   string,
  toIso:     string,
): Promise<CostMetrics | null> {
  const sb = getServiceClient()

  // 0. Project info — gebruiken om de from-date te clampen voor "alle tijd"
  //    queries (anders extrapoleren we preset-uren oneindig terug).
  const { data: projRow } = await sb
    .from('projects')
    .select('created_at')
    .eq('id', projectId)
    .single()
  const projectCreatedAtIso = (projRow as { created_at: string } | null)?.created_at
                            ?? '2020-01-01T00:00:00.000Z'

  // Clamp: als de gevraagde from vóór project-creation ligt → gebruik project-creation
  // Date-comparison i.p.v. string-comparison — TZ-formaten ("Z" vs "+00:00")
  // zijn lexicaal verschillend maar chronologisch gelijk.
  const effectiveFromIso = new Date(fromIso).getTime() < new Date(projectCreatedAtIso).getTime()
    ? projectCreatedAtIso
    : fromIso

  // Voor week-math en confirmations (DATE-kolom) hebben we een YYYY-MM-DD nodig
  // dat de LOKALE datum representeert. We slicen daarom de eerste 10 chars
  // van de ISO-string — die staat in dezelfde TZ als wat de caller verstuurde.
  const effectiveFrom = effectiveFromIso.slice(0, 10)

  // 1. Rates ophalen — als alles NULL is = feature uit
  // created_at gebruiken we als "moment dat deze caller op dit project kwam":
  // zo telt een net toegevoegde caller geen retroactive uren mee.
  type Rate = {
    caller_id:           string
    weekly_hours_preset: number | null
    hourly_rate:         number | null
    currency:            string
    created_at:          string | null
  }
  const { data: rateRows } = await sb
    .from('project_caller_rates')
    .select('caller_id, weekly_hours_preset, hourly_rate, currency, created_at')
    .eq('project_id', projectId)
  const rates = (rateRows ?? []) as Rate[]
  const hasAnyRate = rates.some(r => r.hourly_rate != null && r.hourly_rate > 0)
  if (!hasAnyRate) return null

  // 2. Caller-namen
  const callerIds = rates.map(r => r.caller_id)
  type Prof = { id: string; full_name: string | null }
  const { data: profRows } = await sb
    .from('profiles')
    .select('id, full_name')
    .in('id', callerIds)
  const profMap = new Map(((profRows ?? []) as Prof[]).map(p => [p.id, p.full_name ?? 'Onbekend']))


  // 3. Bevestigde uren binnen window
  // week_start_date is een DATE-kolom — gebruik YYYY-MM-DD strings.
  // Met per-dag uren (hours_mon..hours_fri) kunnen we ook PARTIELE weken
  // correct berekenen — bv. wanneer de filter op "deze week" staat en het is
  // maandag, telt alleen hours_mon mee, niet de volledige hours_actual.
  type Conf = {
    caller_id:       string
    week_start_date: string
    hours_actual:    number
    hours_mon:       number | null
    hours_tue:       number | null
    hours_wed:       number | null
    hours_thu:       number | null
    hours_fri:       number | null
  }
  const fromDate = effectiveFrom
  const toDate   = toIso.slice(0, 10)

  // Fetch-bereik: gebruik de MAANDAG van de periode-start (of eerder) en
  // de vrijdag van de periode-einde. Anders vallen weken die aan de rand
  // van de periode liggen eruit — bv. een week 29 juni - 5 juli valt bij
  // filter juli buiten `.gte(fromDate=2026-07-01)` want week_start_date =
  // 2026-06-29, terwijl er wel uren op 1-2-3-4-5 juli in die week zitten.
  // hoursInWindowFromConfirmation clampt dan alsnog op dag-niveau.
  const fetchFromWeek = mondayOfDateSafe(fromDate)
  const { data: confRows } = await sb
    .from('weekly_hour_confirmations')
    .select('caller_id, week_start_date, hours_actual, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri')
    .eq('project_id', projectId)
    .gte('week_start_date', fetchFromWeek)
    .lte('week_start_date', toDate)
  const confirmations = (confRows ?? []) as Conf[]

  // 4. Per-caller berekening van uren. We tellen enkel effectief bevestigde
  //    uren (per dag), en clampen die op het effectieve window:
  //
  //        callerWindow = [ max(effectiveFrom, callerJoinedAt),
  //                         min(toDate, today) ]
  //
  //    Waarbij callerJoinedAt = project_caller_rates.created_at. Zo tellen
  //    partiële weken correct: bij filter "deze week" op maandag krijg je
  //    alleen hours_mon, niet de hele week.
  //
  //    Preset dient enkel als default-hint op de uur-pagina — niet als
  //    kost-bron. Anders kregen weken zonder confirmation (ontslag, verlof,
  //    of gewoon nog niet ingevuld) fictieve uren, wat cijfers structureel
  //    te hoog maakte.
  const todayIso = new Date().toISOString().slice(0, 10)

  const perCaller: CostMetrics['per_caller'] = []
  let totalHours = 0
  let totalCost  = 0

  for (const r of rates) {
    if (r.hourly_rate == null || r.hourly_rate <= 0) continue

    const confirmedForCaller = confirmations.filter(c => c.caller_id === r.caller_id)
    const hasConfirmations = confirmedForCaller.length > 0

    // Per-caller effectief window
    const callerJoined = r.created_at
      ? r.created_at.slice(0, 10)
      : effectiveFrom
    const windowStart = callerJoined > effectiveFrom ? callerJoined : effectiveFrom
    const windowEnd   = todayIso < toDate ? todayIso : toDate

    // Bevestigde uren — gerespecteerd op dag-niveau zodat partiele weken
    // correct uitkomen. Als de filter "deze week" is en het is maandag, telt
    // alleen hours_mon mee voor de huidige (geconfirmeerde) week.
    let confirmedHours = 0
    for (const c of confirmedForCaller) {
      confirmedHours += hoursInWindowFromConfirmation(c, windowStart, windowEnd)
    }

    // Geen preset-fallback meer — we tellen alleen effectief bevestigde
    // uren. Preset blijft wel op de uur-pagina bestaan als "verwachte"
    // waarde bij eerste opening, maar mag nooit in kost-berekeningen
    // sluipen: dat gaf structureel te hoge cijfers voor weken zonder
    // confirmation (bv. na ontslag, verlof, of gewoon nog niet ingevuld).
    const presetHours = 0

    const hours = confirmedHours + presetHours
    const cost  = hours * r.hourly_rate

    totalHours += hours
    totalCost  += cost
    perCaller.push({
      caller_id:   r.caller_id,
      caller_name: profMap.get(r.caller_id) ?? 'Onbekend',
      hours,
      cost,
      confirmed:   hasConfirmations,
    })
  }

  // 5. Tellingen voor metrics — leads/afspraken/deals
  //
  // We tellen via `call_records.call_date` (niet `uploads.uploaded_at`) zodat
  // deze widget EXACT matcht met de KPI's bovenaan de team-page. Anders
  // ontstaan er discrepanties zodra:
  //   • één upload calls van meerdere dagen bevat (Lemlist/Sheets multi-day
  //     sync die vandaag draait voor gisteren's calls)
  //   • een sales rep pas deze week een deal markeert op een call van
  //     vorige maand → deal telde niet mee onder uploaded_at-filter
  // De call_date-filter is de "waarheid" van wanneer er gebeld werd.
  type CallRow = {
    id:         string
    status:     string | null
    upload_id:  string
    uploads:    { project_id: string } | { project_id: string }[] | null
  }
  // Pagineren want Supabase capt op 1000 rows per query. Zonder deze
  // loop krijgen drukke projecten stille truncation → onder-telling
  // van leads/afspraken/deals in de widget.
  const PAGE = 1000
  const calls: CallRow[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data: page } = await sb
      .from('call_records')
      .select('id, status, upload_id, uploads!inner(project_id)')
      .eq('uploads.project_id', projectId)
      .gte('call_date', effectiveFromIso)
      .lte('call_date', toIso)
      .range(offset, offset + PAGE - 1)
    const chunk = (page ?? []) as CallRow[]
    calls.push(...chunk)
    if (chunk.length < PAGE) break
  }

  const totalLeads        = calls.length
  const totalAppointments = calls.filter(c =>
    (c.status ?? '').toLowerCase().includes('afspraak') ||
    (c.status ?? '').toLowerCase().includes('appointment')
  ).length
  const callIds = calls.map(c => c.id)

  // Deals = appointment_feedback met outcome='deal' op deze calls.
  // Skip helemaal als er geen calls zijn — .in() faalt op lege array.
  // Batchen in chunks van 500: .in() met veel UUIDs bouwt een lange URL
  // (elk UUID = 36 chars) die Supabase's PostgREST kan afkappen. Bij
  // >~800 IDs krijg je stille truncation of een 414 URI Too Long. 500
  // is comfortabel binnen alle limieten.
  let totalDeals = 0
  const CHUNK = 500
  for (let i = 0; i < callIds.length; i += CHUNK) {
    const slice = callIds.slice(i, i + CHUNK)
    const { data: feedbackRows } = await sb
      .from('appointment_feedback')
      .select('call_record_id')
      .eq('outcome', 'deal')
      .in('call_record_id', slice)
    totalDeals += (feedbackRows ?? []).length
  }

  return {
    total_hours:    Math.round(totalHours * 10) / 10,
    total_cost:     Math.round(totalCost * 100) / 100,
    currency:       rates[0]?.currency ?? 'EUR',
    leads:          totalLeads,
    appointments:   totalAppointments,
    deals:          totalDeals,
    hours_per_appt: totalAppointments > 0 ? round(totalHours / totalAppointments, 2) : null,
    hours_per_deal: totalDeals > 0        ? round(totalHours / totalDeals, 1)        : null,
    cost_per_lead:  totalLeads > 0        ? round(totalCost / totalLeads, 2)         : null,
    cost_per_appt:  totalAppointments > 0 ? round(totalCost / totalAppointments, 2)  : null,
    cost_per_deal:  totalDeals > 0        ? round(totalCost / totalDeals, 2)         : null,
    per_caller:     perCaller.sort((a, b) => b.hours - a.hours),
  }
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals)
  return Math.round(n * f) / f
}

/** Geef de maandag (YYYY-MM-DD, UTC-safe) van de week waarin de gegeven
    datum valt. Zondag = maandag daarvoor (ISO week). Gebruikt om de
    fetch-range voor weekly_hour_confirmations uit te breiden zodat weken
    aan de rand van de periode niet stilletjes uitvallen. */
function mondayOfDateSafe(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  const day = d.getUTCDay()                        // 0=Sun … 6=Sat
  const offset = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

/**
 * Hoeveel werkdagen (Ma-Vr) van de week die start op `weekMonday` vallen
 * binnen [windowStart, windowEnd] (inclusief beide einden)?
 *
 * Returns 0..5. Gebruikt voor pro-rata preset:
 *   - Toekomstige week (Mon > windowEnd) → 0
 *   - Voorbije week volledig in window   → 5
 *   - Huidige week tot vandaag (Tue)     → 2
 *   - Caller toegevoegd op woe → die week alleen woe/do/vr in window → 3
 */
function workdaysOfWeekWithin(weekMonday: string, windowStart: string, windowEnd: string): number {
  // Werkdagen van deze week = Ma t/m Vr (4 dagen na de maandag)
  const friday = addDaysIso(weekMonday, 4)
  const start  = weekMonday > windowStart ? weekMonday : windowStart
  const end    = friday     < windowEnd   ? friday     : windowEnd
  if (start > end) return 0
  let count = 0
  const cur = new Date(start + 'T00:00:00Z')
  const stop = new Date(end + 'T00:00:00Z')
  while (cur.getTime() <= stop.getTime()) {
    const day = cur.getUTCDay()
    if (day >= 1 && day <= 5) count++
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return count
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Geeft de som terug van de geconfirmeerde uren voor één weekly_hour_confirmation
 * die binnen `[windowStart, windowEnd]` vallen. Loopt over de 5 werkdagen
 * (Ma-Vr) en telt alleen de dagen mee waarvan de echte datum in het window
 * ligt. Voor weken die VOLLEDIG in het window vallen krijg je effectief
 * `hours_actual` terug; voor partiele weken krijg je een subset.
 *
 * Fallback: als alle hours_per_day NULL/0 zijn maar hours_actual > 0 (oude
 * data van vóór de per-dag migratie), wordt hours_actual evenredig verdeeld
 * over de werkdagen die in het window vallen. Zo blijft legacy data
 * consistent met de nieuwe partiele-week logica.
 */
function hoursInWindowFromConfirmation(
  c: {
    week_start_date: string
    hours_actual:    number
    hours_mon:       number | null
    hours_tue:       number | null
    hours_wed:       number | null
    hours_thu:       number | null
    hours_fri:       number | null
  },
  windowStart: string,
  windowEnd:   string,
): number {
  const days: Array<['mon' | 'tue' | 'wed' | 'thu' | 'fri', number | null]> = [
    ['mon', c.hours_mon],
    ['tue', c.hours_tue],
    ['wed', c.hours_wed],
    ['thu', c.hours_thu],
    ['fri', c.hours_fri],
  ]

  // Hoeveel werkdagen vallen in window?
  const workdaysInWindow = workdaysOfWeekWithin(c.week_start_date, windowStart, windowEnd)
  if (workdaysInWindow === 0) return 0

  // Heeft deze rij echte per-dag waarden? (= minstens één >0)
  const hasPerDay = days.some(([, v]) => v != null && v > 0)

  if (hasPerDay) {
    // Per-dag pad: loop dagen, tel alleen wat in window valt
    let total = 0
    for (let i = 0; i < 5; i++) {
      const dayIso = addDaysIso(c.week_start_date, i)
      if (dayIso < windowStart) continue
      if (dayIso > windowEnd)   continue
      total += days[i][1] ?? 0
    }
    return total
  }

  // Fallback: legacy bevestiging zonder per-dag splitsing. Verdeel
  // hours_actual evenredig over de werkdagen die in window vallen.
  return c.hours_actual * (workdaysInWindow / 5)
}
