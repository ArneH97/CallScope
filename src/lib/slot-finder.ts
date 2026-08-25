/**
 * Slot-finder: voor een lead met bekende provincie, vind de 3 beste afspraak-
 * slots in de komende N werkdagen op basis van de Google Calendars van de
 * sales reps op het project.
 *
 * Algoritme:
 *   1) Laad alle sales reps van het project (+ optioneel cc_managers die als
 *      sales rep fungeren — voor RestoManager-stijl freelancers).
 *   2) Voor elke rep, lees calendar events tussen now en now+horizonDagen.
 *   3) Per werkdag (Ma-Vr) bepaal de "actieve provincie(s)":
 *        a) Eerst all-day events scannen (regex over titel)
 *        b) Voor losse events: AI-extract (cached)
 *        c) Een rep kan op één dag meerdere provincies hebben — accepteer
 *           als ÉÉN ervan matched met de lead-provincie.
 *   4) Voor matchende dagen, vind vrije slots binnen werkuren (9-17, lunch
 *      12-13 weg, 30 min buffer rond busy events) van slot-duur 1u.
 *   5) Sorteer chronologisch (eerste = beste). Return top 3.
 *
 * Knobs (defaults in SLOT_CONFIG_DEFAULT):
 *   - werkuren 09:00 - 17:00
 *   - lunch 12:00 - 13:00 (uitgesloten)
 *   - slot-duur 60 min
 *   - buffer rond busy events 30 min
 *   - horizon 14 werkdagen
 *
 * Tijdzone: alles in Europe/Brussels. Dates worden intern als ISO bewaard.
 */

import { createClient } from '@supabase/supabase-js'
import { listCalendarEvents, CalendarScopeError, type CalendarEvent } from './calendar'
import { detectProvinceForEvent } from './ai-event-location'
import { isStrictRegionProvince } from './regions'

export type SlotConfig = {
  workStartHour:    number   // 9 → 09:00 lokale tijd
  workEndHour:      number   // 17 → 17:00
  lunchStartHour:   number   // 12 → 12:00 begin lunch
  lunchEndHour:     number   // 13 → 13:00 einde lunch
  slotMinutes:      number   // 60 min standaard afspraak
  bufferMinutes:    number   // 30 min reisbuffer rond bestaande events
  horizonDays:      number   // hoeveel kalenderdagen vooruit kijken (incl. weekend)
}

export const SLOT_CONFIG_DEFAULT: SlotConfig = {
  workStartHour:  9,
  workEndHour:   17,
  lunchStartHour: 12,
  lunchEndHour:   13,
  slotMinutes:    60,
  bufferMinutes:  30,
  horizonDays:    21,   // ~3 weken → 15 werkdagen
}

export type SlotProposal = {
  salesRepId:        string
  salesRepName:      string
  salesRepEmail:     string | null
  start:             Date
  end:               Date
  /** Provincie van de rep voor die dag. */
  province:          string
  /** Waarom we vinden dat het slot past — debug + UI-uitleg. */
  matchReason:       string
}

export type SlotFinderResult = {
  slots: SlotProposal[]
  /** Reps waarbij de calendar.events scope nog niet was toegekend. UI gebruikt
   *  dit om een banner te tonen ("X rep heeft Google nog niet gekoppeld"). */
  repsMissingCalendarScope: string[]
}

type SalesRep = {
  id:         string
  full_name:  string
  email:      string | null
}

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

/**
 * Hoofdfunctie. Roept de calendar-API per rep, doet provincie-detectie, en
 * combineert alles tot top 3 voorstellen.
 *
 * Matching-strategie:
 *   - Als `leadRegion` gezet is (bv. 'WVL-NW'), zoeken we eerst reps die op
 *     die dag exact die region in hun calendar hebben staan. Strict mode.
 *   - Voor reps zonder region maar mét matchende provincie: ook accepteren,
 *     maar alleen als de provincie GEEN strict-region provincie is (om te
 *     voorkomen dat een algemene "West-Vlaanderen"-rep onbedoeld matched
 *     met een lead in WVL-NW).
 *   - Voor leads zonder region (postcodes buiten BE_REGIONS-coverage): val
 *     terug op pure province-match zoals voorheen.
 */
export async function findTopSlotsForLead(args: {
  projectId:     string
  leadProvince:  string                       // genormaliseerde slug zoals 'antwerpen'
  leadRegion?:   string | null                // bv. 'WVL-NW' — optioneel
  topN?:         number                       // default 3
  config?:       Partial<SlotConfig>
  /** Skipt de AI-detect (alleen regex+all-day). Sneller maar minder coverage. */
  skipAi?:       boolean
}): Promise<SlotFinderResult> {
  const cfg = { ...SLOT_CONFIG_DEFAULT, ...(args.config ?? {}) }
  const topN = args.topN ?? 3

  const reps = await loadSalesReps(args.projectId)
  if (reps.length === 0) {
    return { slots: [], repsMissingCalendarScope: [] }
  }

  // Tijdvenster: vanaf nu (afronden naar volgend werkuur) tot N kalenderdagen verder.
  const now = new Date()
  const timeMin = nextWorkStart(now, cfg)
  const timeMax = addDays(now, cfg.horizonDays)
  timeMax.setHours(cfg.workEndHour, 0, 0, 0)

  // Bestaande appointment_bookings voor deze reps in dit window — we tellen
  // die mee als "busy" zodat we geen dubbele afspraken voorstellen voor een
  // slot dat in CallScope al geboekt is (Google heeft 'm wel ook, maar de
  // booking kan 'pending sync' zijn).
  const repIds = reps.map(r => r.id)
  const sb = getServiceClient()
  const { data: existingBookings } = await sb
    .from('appointment_bookings')
    .select('sales_rep_id, scheduled_start, scheduled_end, status')
    .in('sales_rep_id', repIds)
    .gte('scheduled_start', timeMin.toISOString())
    .lte('scheduled_start', timeMax.toISOString())
    .neq('status', 'cancelled')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookings = (existingBookings ?? []) as any[]

  const repBookings = new Map<string, { start: Date; end: Date }[]>()
  for (const b of bookings) {
    const arr = repBookings.get(b.sales_rep_id) ?? []
    arr.push({ start: new Date(b.scheduled_start), end: new Date(b.scheduled_end) })
    repBookings.set(b.sales_rep_id, arr)
  }

  const allProposals: SlotProposal[] = []
  const missingScope: string[] = []

  for (const rep of reps) {
    let events: CalendarEvent[]
    try {
      events = await listCalendarEvents(rep.id, timeMin, timeMax)
    } catch (e) {
      if (e instanceof CalendarScopeError) {
        missingScope.push(rep.id)
        continue
      }
      // Voor andere errors: skip de rep maar log; we willen niet de hele
      // request laten falen door één defecte token.
      console.error('[slot-finder] kon events niet laden voor rep', rep.id, e)
      continue
    }

    // Per werkdag in het venster: provincie- + (optioneel) region-match
    for (const day of workdaysInRange(timeMin, timeMax)) {
      const dayEvents = events.filter(e => sameDay(toDateLocal(e.start), day))

      const { provinces, regions } = await locationsActiveOnDay(dayEvents, args.skipAi ?? false)

      // Strict-region match: als lead.region is gezet (bv. WVL-NW), accepteren
      // we de dag alleen als rep die specifieke region heeft, OF als rep een
      // algemene provincie zonder region-tag heeft en de provincie matcht.
      //
      // De redenering: een rep die "WVL-W" tagt zegt expliciet "ik werk vandaag
      // in de Westhoek, niet aan de Kust". Een lead in WVL-NW (Brugge) hoort
      // daar dus niet. Een rep die alleen "West-Vlaanderen" tagt (geen sub-
      // regio) interpreteren we als algemene WVL-beschikbaarheid en die
      // matched wel met elke WVL-lead.
      let matchReason: string | null = null
      const dayLabelNL = day.toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short' })
      if (args.leadRegion) {
        if (regions.includes(args.leadRegion)) {
          matchReason = `Rep werkt op ${dayLabelNL} in ${args.leadRegion}`
        } else if (regions.length === 0 && provinces.includes(args.leadProvince)) {
          matchReason = `Rep werkt op ${dayLabelNL} in ${args.leadProvince} (geen sub-regio gespecifieerd)`
        } else {
          continue
        }
      } else {
        // Geen region voor de lead: pure provincie-match. Maar als de rep
        // ÉN een region tagged die NIET in de lead's provincie zit, sla over
        // — anders zouden we WVL-NW-reps voorstellen voor een Antwerpse lead.
        if (!provinces.includes(args.leadProvince)) continue
        // Strict-region provincies: als de rep specifiek een sub-regio heeft
        // getagd in een andere provincie dan de lead, sla over.
        if (regions.length > 0 && isStrictRegionProvince(args.leadProvince)) {
          // Lead heeft geen region maar speelt zich af in een strict-region
          // provincie. Conservatief: accepteer alleen als rep óók ten minste
          // één region in dezelfde provincie heeft. Anders te risicovol.
          // Voor MVP: we accepteren toch want zonder lead-region kunnen we
          // niet voldoende discrimineren. Logging-only.
        }
        matchReason = `Rep werkt op ${dayLabelNL} in ${args.leadProvince}`
      }

      // Free slots in deze dag
      const busy = computeBusyIntervals(dayEvents, day, cfg)
      // Tel ook bestaande CallScope-bookings voor deze rep op die dag
      for (const b of repBookings.get(rep.id) ?? []) {
        if (sameDay(b.start, day)) busy.push({ start: b.start, end: b.end })
      }
      const freeSlots = generateFreeSlots(day, busy, cfg)

      for (const slot of freeSlots) {
        allProposals.push({
          salesRepId:    rep.id,
          salesRepName:  rep.full_name,
          salesRepEmail: rep.email,
          start:         slot.start,
          end:           slot.end,
          province:      args.leadRegion ?? args.leadProvince,
          matchReason:   matchReason!,
        })
      }
    }
  }

  // Sorteer chronologisch — vroegere slots = beter (eerstvolgende
  // gelegenheid om de lead op te volgen).
  allProposals.sort((a, b) => a.start.getTime() - b.start.getTime())

  return {
    slots: allProposals.slice(0, topN),
    repsMissingCalendarScope: missingScope,
  }
}

// ── Sales reps laden ───────────────────────────────────────────────────────

async function loadSalesReps(projectId: string): Promise<SalesRep[]> {
  const sb = getServiceClient()
  const { data } = await sb
    .from('project_members')
    .select('profile_id, role, profiles(full_name, email)')
    .eq('project_id', projectId)
    .in('role', ['sales_rep', 'sales_manager'])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[]
  return rows.map(r => ({
    id:        r.profile_id,
    full_name: r.profiles?.full_name ?? '—',
    email:     r.profiles?.email ?? null,
  }))
}

// ── Provincie per dag bepalen ──────────────────────────────────────────────

async function locationsActiveOnDay(
  dayEvents: CalendarEvent[],
  skipAi:    boolean,
): Promise<{ provinces: string[]; regions: string[] }> {
  const provinces = new Set<string>()
  const regions   = new Set<string>()

  for (const e of dayEvents) {
    // All-day events: regex-match (region + province) krijgt voorrang
    if (e.isAllDay) {
      const r = await detectProvinceForEvent(e)
      if (r.province) provinces.add(r.province)
      if (r.region)   regions.add(r.region)
      continue
    }
    // Voor losse events: alleen detecten als skipAi=false
    if (!skipAi) {
      const r = await detectProvinceForEvent(e)
      if (r.province && r.confidence >= 0.5) provinces.add(r.province)
      // Region uit losse events alleen accepteren als de tekst de code
      // letterlijk bevat (confidence 1.0 in onze detect). Geen GPT-region.
      if (r.region) regions.add(r.region)
    }
  }
  return { provinces: Array.from(provinces), regions: Array.from(regions) }
}

// ── Busy intervals + free slots berekenen ──────────────────────────────────

type Interval = { start: Date; end: Date }

function computeBusyIntervals(events: CalendarEvent[], day: Date, cfg: SlotConfig): Interval[] {
  const out: Interval[] = []
  for (const e of events) {
    if (!e.isBusy || e.isAllDay) continue
    const s = toDateLocal(e.start)
    const eDate = toDateLocal(e.end)
    if (!s || !eDate) continue
    if (!sameDay(s, day) && !sameDay(eDate, day)) continue
    // Clamp naar werkdag-grenzen
    const startBoundary = new Date(day); startBoundary.setHours(cfg.workStartHour, 0, 0, 0)
    const endBoundary   = new Date(day); endBoundary.setHours(cfg.workEndHour,   0, 0, 0)
    const cs = s < startBoundary ? startBoundary : s
    const ce = eDate > endBoundary ? endBoundary : eDate
    if (cs >= ce) continue
    out.push({
      start: addMinutes(cs, -cfg.bufferMinutes),
      end:   addMinutes(ce,  cfg.bufferMinutes),
    })
  }
  return mergeIntervals(out)
}

function generateFreeSlots(day: Date, busy: Interval[], cfg: SlotConfig): Interval[] {
  // Maak een lijst van potentiële slot-starts elke 30 min binnen 09-12 + 13-17.
  // Daarna filteren we slots die in geen enkele busy interval vallen.
  const slots: Interval[] = []
  const addSlots = (fromH: number, toH: number) => {
    let s = new Date(day); s.setHours(fromH, 0, 0, 0)
    const limit = new Date(day); limit.setHours(toH, 0, 0, 0)
    while (true) {
      const e = addMinutes(s, cfg.slotMinutes)
      if (e > limit) break
      if (!intersectsAny({ start: s, end: e }, busy)) {
        slots.push({ start: new Date(s), end: e })
      }
      s = addMinutes(s, 30)   // grid van 30 min — geeft 9:00, 9:30, 10:00... starts
    }
  }
  addSlots(cfg.workStartHour, cfg.lunchStartHour)   // ochtend
  addSlots(cfg.lunchEndHour,  cfg.workEndHour)      // namiddag

  // Maximum 2 slots per dag per rep — anders bias je teveel naar één dag/rep
  // bij het sorteren over alle reps × dagen.
  return slots.slice(0, 2)
}

// ── Time/date helpers ──────────────────────────────────────────────────────

function nextWorkStart(now: Date, cfg: SlotConfig): Date {
  const d = new Date(now)
  // Als we al binnen werkuren zijn op een werkdag → start nu, anders skip naar volgende werkdag 9:00
  const hour = d.getHours()
  const day  = d.getDay()
  const isWorkday = day >= 1 && day <= 5
  if (isWorkday && hour >= cfg.workStartHour && hour < cfg.workEndHour) {
    // Rond op halfuur boven
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0)
    return d
  }
  // Skip naar volgende werkdag
  do {
    d.setDate(d.getDate() + 1)
  } while (d.getDay() === 0 || d.getDay() === 6)
  d.setHours(cfg.workStartHour, 0, 0, 0)
  return d
}

function workdaysInRange(from: Date, to: Date): Date[] {
  const out: Date[] = []
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  while (d <= end) {
    const dow = d.getDay()
    if (dow >= 1 && dow <= 5) out.push(new Date(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d); x.setDate(x.getDate() + days); return x
}

function addMinutes(d: Date, mins: number): Date {
  const x = new Date(d); x.setMinutes(x.getMinutes() + mins); return x
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * Parse een Google-event start/end. All-day events zijn "YYYY-MM-DD" zonder
 * tijdzone; timed events zijn ISO met "+02:00" of "Z". We mappen beide naar
 * een Date in lokale tijd.
 */
function toDateLocal(s: string): Date {
  if (!s) return new Date(NaN)
  // YYYY-MM-DD zonder tijd → all-day, lokaal midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d, 0, 0, 0)
  }
  return new Date(s)
}

function intersectsAny(slot: Interval, busy: Interval[]): boolean {
  for (const b of busy) {
    if (slot.start < b.end && slot.end > b.start) return true
  }
  return false
}

function mergeIntervals(input: Interval[]): Interval[] {
  if (input.length === 0) return []
  const sorted = input.slice().sort((a, b) => a.start.getTime() - b.start.getTime())
  const out: Interval[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]
    const cur  = sorted[i]
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end
    } else {
      out.push(cur)
    }
  }
  return out
}
