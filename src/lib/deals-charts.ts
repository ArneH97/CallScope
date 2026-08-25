/**
 * Pure compute-functies voor de dealstage-grafieken.
 *
 * Bedoeld voor herbruik in:
 *   - /dashboard/team (cc_manager)
 *   - /dashboard/sales (sales_manager)
 *   - /dashboard/projects/[id]/report + /r/[token] (klant-rapport)
 *
 * Bron: `appointments_with_feedback` view — bevat per afspraak:
 *   - dealstage_category ('won'|'lost'|'offerte'|'in_progress'|'no_show'|'other'|null)
 *   - outcome           ('deal'|'offerte'|'follow_up'|'verloren'|'geen'|null)
 *   - appointment_status ('gepland'|'uitgevoerd'|'no_show'|null)
 *   - call_date          ISO date-string van de bijhorende call
 *
 * `dealstage_category` heeft voorrang (komt uit HubSpot classifier).
 * Voor projecten zonder HubSpot-koppeling vallen we terug op `outcome` +
 * `appointment_status` zodat de grafiek altijd data toont.
 */

export type DealStageBucket =
  | 'won'
  | 'offerte'
  | 'in_progress'
  | 'no_show'
  | 'lost'
  | 'upcoming'   // afspraakdatum ligt nog in de toekomst → nog geen feedback te verwachten
  | 'other'

export const DEAL_STAGE_ORDER: DealStageBucket[] = [
  'won',
  'offerte',
  'in_progress',
  'no_show',
  'lost',
  'upcoming',
  'other',
]

export const DEAL_STAGE_COLORS: Record<DealStageBucket, string> = {
  won:         '#10b981',  // green
  offerte:     '#3b82f6',  // blue
  in_progress: '#f59e0b',  // amber
  no_show:     '#a3a3a3',  // gray
  lost:        '#ef4444',  // red
  upcoming:    '#a5b4fc',  // indigo-300 — hoopvol maar neutraal, onderscheidt zich van "won"
  other:       '#d4d4d4',  // light gray
}

/** Minimale shape die de compute-functies verwachten uit de feedback-view. */
export type FeedbackRow = {
  call_date:          string | null
  dealstage_category: string | null
  outcome:            string | null
  appointment_status: string | null
  /** ISO timestamptz. Als > NOW en er is geen feedback/dealstage, dan
      valt de afspraak in de 'upcoming' bucket ipv 'other' — logischer
      onderscheid voor de manager (weet dat feedback nog niet verwacht
      kan worden). */
  appointment_date?:  string | null
}

/**
 * Bepaal in welke bucket een afspraak valt. Prioriteit:
 *   1. dealstage_category (HubSpot-classifier) — meest betrouwbaar
 *   2. appointment_status='no_show' → 'no_show'
 *   3. outcome mapping
 *   4. appointment_date in de toekomst → 'upcoming' (geen feedback te verwachten)
 *   5. fallback 'other' (afspraak zonder feedback of onduidelijk)
 */
export function bucketForFeedback(f: FeedbackRow, now: Date = new Date()): DealStageBucket {
  const cat = (f.dealstage_category ?? '').toLowerCase()
  if (cat === 'won')         return 'won'
  if (cat === 'lost')        return 'lost'
  if (cat === 'offerte')     return 'offerte'
  if (cat === 'in_progress') return 'in_progress'
  if (cat === 'no_show')     return 'no_show'

  if (f.appointment_status === 'no_show') return 'no_show'

  const outcome = (f.outcome ?? '').toLowerCase()
  if (outcome === 'deal')      return 'won'
  if (outcome === 'offerte')   return 'offerte'
  if (outcome === 'follow_up') return 'in_progress'
  if (outcome === 'verloren')  return 'lost'

  // Geen dealstage + geen outcome → check of de afspraak in de toekomst
  // ligt. Zo ja: nog geen feedback te verwachten → aparte bucket.
  if (f.appointment_date) {
    const d = new Date(f.appointment_date)
    if (!isNaN(d.getTime()) && d.getTime() > now.getTime()) {
      return 'upcoming'
    }
  }

  return 'other'
}

/**
 * Bereken het aantal afspraken per dealstage-bucket in de gegeven set.
 */
export function computeDealBreakdown(feedback: FeedbackRow[]): {
  buckets: Record<DealStageBucket, number>
  total:   number
} {
  const buckets: Record<DealStageBucket, number> = {
    won:         0,
    offerte:     0,
    in_progress: 0,
    no_show:     0,
    lost:        0,
    upcoming:    0,
    other:       0,
  }
  for (const f of feedback) {
    buckets[bucketForFeedback(f)]++
  }
  const total = Object.values(buckets).reduce((s, n) => s + n, 0)
  return { buckets, total }
}

/**
 * Groepeer afspraken per kalendermaand (YYYY-MM) met counts per bucket.
 * Handig voor een stacked line/bar chart die de deal-flow over de tijd toont.
 *
 * Alleen maanden met minstens 1 afspraak worden opgenomen (spaarzaam als
 * je project pas net loopt). Volgorde: chronologisch (oudste eerst).
 */
export type MonthlyDealRow = {
  monthKey:   string   // YYYY-MM (voor sortering)
  monthLabel: string   // "mei 2026" / "May 2026" (locale-aware)
  total:      number
} & Record<DealStageBucket, number>

export function computeDealsPerMonth(
  feedback: FeedbackRow[],
  bcp47:    string = 'nl-BE',
  opts:     { fillYear?: number } = {},
): MonthlyDealRow[] {
  const byMonth = new Map<string, MonthlyDealRow>()

  const emptyRow = (monthKey: string): MonthlyDealRow => {
    const d = new Date(monthKey + '-01T12:00:00Z')
    const monthLabel = d.toLocaleDateString(bcp47, { month: 'short', year: 'numeric' })
    return {
      monthKey, monthLabel,
      total: 0, won: 0, offerte: 0, in_progress: 0, no_show: 0, lost: 0, upcoming: 0, other: 0,
    }
  }

  // Als een `fillYear` is opgegeven, pre-populeren met alle 12 maanden zodat
  // maanden zonder data ook getoond worden (lege bar in de chart). Zonder
  // pre-populate zou de x-as enkel maanden met data laten zien wat visueel
  // misleidend is bij een grafiek die "hele jaar" belooft.
  if (opts.fillYear) {
    for (let m = 1; m <= 12; m++) {
      const monthKey = `${opts.fillYear}-${String(m).padStart(2, '0')}`
      byMonth.set(monthKey, emptyRow(monthKey))
    }
  }

  for (const f of feedback) {
    if (!f.call_date) continue
    const monthKey = f.call_date.slice(0, 7)   // "2026-05"
    // Als we jaar-filter aan hebben, alleen maanden binnen dat jaar tellen
    if (opts.fillYear && !monthKey.startsWith(String(opts.fillYear))) continue
    let row = byMonth.get(monthKey)
    if (!row) {
      row = emptyRow(monthKey)
      byMonth.set(monthKey, row)
    }
    row[bucketForFeedback(f)]++
    row.total++
  }
  return Array.from(byMonth.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey))
}

/**
 * Actieve pipeline = deals die nog kunnen sluiten. Handig voor de "kost per
 * deal" berekening in de tijd&kost-widget: als je enkel `won` telt geeft
 * dat een misleidend hoge cost/deal voor recente maanden waar deals nog
 * niet zijn afgesloten.
 */
export function isActiveDealBucket(b: DealStageBucket): boolean {
  return b === 'won' || b === 'offerte' || b === 'in_progress'
}
