/**
 * Pure berekeningen voor de team-grafieken (calls/u + bereikratio).
 * Bedoeld om herbruikt te worden door:
 *   - /dashboard/team (client) — fetcht zelf, gebruikt useMemo
 *   - /dashboard/projects/[id]/report (server) — fetcht server-side
 *   - /r/[token] (server, publiek) — idem voor share-rapport
 *
 * Geen React hooks hier — pure functies + data shapes. De UI-renderer staat
 * apart in components/TeamChartsBlock.tsx.
 */

export type ChartCallRow = {
  caller_id: string
  call_date: string   // yyyy-mm-dd
  status:    string | null
}

export type ChartConfRow = {
  caller_id:       string
  week_start_date: string  // yyyy-mm-dd (maandag)
  hours_mon:       number | null
  hours_tue:       number | null
  hours_wed:       number | null
  hours_thu:       number | null
  hours_fri:       number | null
}

export type ChartRateRow = {
  caller_id:           string
  weekly_hours_preset: number | null
}

export type ChartCaller = {
  id:    string
  name:  string
  color: string
}

export type ChartSeriesRow = {
  dateKey:   string
  dateLabel: string
} & Record<string, number | string | null>

export const CHART_CALLER_COLORS = [
  '#2d4fff', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16',
]

/**
 * Patronen die we als "niet bereikt" beschouwen. Alles wat NIET matched
 * telt als bereikt. Dit is een heuristic — exacte cijfers gebruiken
 * upload_summary, deze chart toont enkel trends.
 */
const NOT_REACHED_PATTERNS = [
  'no answer', 'geen antwoord', 'niet bereikt', 'niet bereikbaar',
  'busy', 'bezet',
  'voicemail', 'voicemailbox', 'voice mail',
  'wrong number', 'verkeerd nummer', 'fout nummer',
  'geen gehoor', 'opgehangen', 'niet opgenomen',
]

export function isReached(status: string | null | undefined): boolean {
  if (!status) return false
  const s = status.toLowerCase().trim()
  if (s === '') return false
  return !NOT_REACHED_PATTERNS.some(p => s.includes(p))
}

/** Maandag (00:00 lokale tijd) van de week waarin `date` valt. */
export function mondayOfDay(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0)
  const day = d.getDay()
  const offset = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + offset)
  return d
}

/** ISO yyyy-mm-dd uit een Date, in LOKALE tijd (geen UTC-shift). */
export function isoDay(d: Date): string {
  const y  = d.getFullYear()
  const m  = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/**
 * Bouwt een lijst werkdagen (Ma-Vr) tussen from en to (inclusief beide grenzen).
 * Returnt elke dag als een Date in lokale tijd, 00:00.
 */
export function workdaysBetween(from: Date, to: Date): Date[] {
  const out: Date[] = []
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const end    = new Date(to.getFullYear(),   to.getMonth(),   to.getDate())
  while (cursor <= end) {
    const dow = cursor.getDay()
    if (dow >= 1 && dow <= 5) out.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/**
 * Label per werkdag, locale-aware ("Ma 11" voor nl-BE, "Mon 11" voor en).
 * Eerste letter van de weekday-naam wordt geconverteerd naar uppercase voor
 * consistentie (sommige locales geven 'ma' i.p.v. 'Ma').
 */
function workdayLabel(d: Date, bcp47: string): string {
  const wd = d.toLocaleDateString(bcp47, { weekday: 'short' })
  const wdSlice = wd.length >= 2 ? wd.slice(0, 2) : wd
  return `${wdSlice.charAt(0).toUpperCase()}${wdSlice.slice(1)} ${d.getDate()}`
}

const DAY_COLS = ['hours_mon', 'hours_tue', 'hours_wed', 'hours_thu', 'hours_fri'] as const

/**
 * Minimum aantal calls op een dag voordat we een datapunt tekenen. Dagen
 * met weinig calls geven volatiele calls/u en bereikratio-cijfers (één
 * geweigerd telefoontje bij 5 calls = 20% bereikratio swing), wat
 * coachings-signaal verstoort. 20 is empirisch gekozen — ongeveer
 * 1u-1u30 normaal belwerk.
 */
export const MIN_CALLS_PER_POINT = 20

/**
 * Berekent uren voor een specifieke caller op een specifieke werkdag.
 *
 * Returnt enkel ECHTE bevestigde uren — geen preset-fallback. Reden: de
 * preset is een budgetting-verwachting (10u/week → 2u/dag avg), niet de
 * werkelijke gewerkte uren. Hem als fallback gebruiken levert misleidende
 * calls/u op zodra een caller op een dag bv. maar 1u of net 4u werkt
 * (chart toonde dan systematisch 2u-aanname → cijfers gedeeld door 2).
 *
 * Gevolg: voor lopende weken zonder bevestiging is er geen datapunt.
 * Zodra de vrijdag-cron de confirmation aanmaakt — of de caller zelf
 * vooraf z'n uren invult via /dashboard/projects/[id]/confirm-hours —
 * verschijnt de lijn alsnog.
 */
function hoursForCallerDay(
  date: Date,
  callerId: string,
  confByCallerWeek: Map<string, ChartConfRow>,
): number | null {
  const dow = date.getDay()
  if (dow < 1 || dow > 5) return null
  const mondayKey = isoDay(mondayOfDay(date))
  const conf = confByCallerWeek.get(`${callerId}|${mondayKey}`)
  if (!conf) return null
  const v = conf[DAY_COLS[dow - 1]]
  if (v == null || v <= 0) return null
  return v
}

/**
 * Calls/u-data per werkdag per caller. Calls / uren_gewerkt die dag.
 * Filtert callers zonder data eruit zodat de Legend leesbaar blijft.
 *
 * Fallback: als een dag calls heeft maar 0 uren geregistreerd, gebruiken
 * we het week-gemiddelde (totaal calls die week / totaal uren die week).
 * Zonder deze fallback verdwijnen die calls uit de chart terwijl ze wel
 * in de KPI-totalen zitten — wat een discrepantie geeft tussen "totaal
 * calls / totaal uren" en het chart-gemiddelde. Typische oorzaak: caller
 * boekt uren op andere dagen dan wanneer hij effectief belde (bv. alles
 * op DO/VR bevestigd maar ook op MA gebeld).
 */
export function computeCallsPerHourData(
  callRows:    ChartCallRow[],
  confRows:    ChartConfRow[],
  _rateRows:   ChartRateRow[],  // gereserveerd; preset wordt niet meer als fallback gebruikt
  callers:     ChartCaller[],
  from:        Date,
  to:          Date,
  bcp47:       string = 'nl-BE',
): { rows: ChartSeriesRow[]; callers: ChartCaller[] } {
  // Calls per (caller_id, dateKey)
  const callsByCallerDay = new Map<string, number>()
  for (const r of callRows) {
    const k = `${r.caller_id}|${r.call_date}`
    callsByCallerDay.set(k, (callsByCallerDay.get(k) ?? 0) + 1)
  }

  // Confirmations per (caller_id, monday-key)
  const confByCallerWeek = new Map<string, ChartConfRow>()
  for (const c of confRows) {
    confByCallerWeek.set(`${c.caller_id}|${c.week_start_date}`, c)
  }

  // Week-gemiddelde per (caller_id, monday-key): totaal calls / totaal uren
  // Berekend uit callRows + confRows. Gebruikt als fallback wanneer een
  // specifieke dag geen uren heeft maar de week wel.
  const weekTotalsByCaller = new Map<string, { calls: number; hours: number }>()
  for (const r of callRows) {
    const mondayKey = isoDay(mondayOfDay(new Date(r.call_date)))
    const k = `${r.caller_id}|${mondayKey}`
    const cur = weekTotalsByCaller.get(k) ?? { calls: 0, hours: 0 }
    cur.calls += 1
    weekTotalsByCaller.set(k, cur)
  }
  for (const c of confRows) {
    const k = `${c.caller_id}|${c.week_start_date}`
    const cur = weekTotalsByCaller.get(k) ?? { calls: 0, hours: 0 }
    cur.hours = DAY_COLS.reduce((s, col) => s + (c[col] ?? 0), 0)
    weekTotalsByCaller.set(k, cur)
  }

  const rows: ChartSeriesRow[] = []
  for (const d of workdaysBetween(from, to)) {
    const dateKey = isoDay(d)
    const mondayKey = isoDay(mondayOfDay(d))
    const row: ChartSeriesRow = { dateKey, dateLabel: workdayLabel(d, bcp47) }
    for (const cl of callers) {
      const calls = callsByCallerDay.get(`${cl.id}|${dateKey}`) ?? 0
      if (calls < MIN_CALLS_PER_POINT) { row[cl.id] = null; continue }

      const hrs = hoursForCallerDay(d, cl.id, confByCallerWeek)
      if (hrs && hrs > 0) {
        // Normale per-dag ratio: uren zijn precies voor deze dag geboekt.
        row[cl.id] = Math.round((calls / hrs) * 10) / 10
      } else {
        // Fallback: dag-uren = 0, maar de week zelf heeft wel uren.
        // Gebruik week-gemiddelde zodat calls op "boekhoudkundig 0-uur"-
        // dagen niet verdwijnen uit de chart. Anders klopt totaal calls
        // / totaal uren niet met wat de user hier ziet.
        const wk = weekTotalsByCaller.get(`${cl.id}|${mondayKey}`)
        row[cl.id] = wk && wk.hours > 0
          ? Math.round((wk.calls / wk.hours) * 10) / 10
          : null
      }
    }
    rows.push(row)
  }
  const callersWithData = callers.filter(c =>
    rows.some(r => typeof r[c.id] === 'number')
  )
  return { rows, callers: callersWithData }
}

/**
 * Bereikratio per werkdag per caller. (#bereikt / #totaal) × 100.
 * Alleen wanneer er die dag minstens 1 call is voor de caller — anders null.
 */
export function computeReachRateData(
  callRows: ChartCallRow[],
  callers:  ChartCaller[],
  from:     Date,
  to:       Date,
  bcp47:    string = 'nl-BE',
): { rows: ChartSeriesRow[]; callers: ChartCaller[] } {
  // Index per (caller_id, dateKey): { total, reached }
  const statsByCallerDay = new Map<string, { total: number; reached: number }>()
  for (const r of callRows) {
    const k = `${r.caller_id}|${r.call_date}`
    if (!statsByCallerDay.has(k)) statsByCallerDay.set(k, { total: 0, reached: 0 })
    const s = statsByCallerDay.get(k)!
    s.total++
    if (isReached(r.status)) s.reached++
  }

  const rows: ChartSeriesRow[] = []
  for (const d of workdaysBetween(from, to)) {
    const dateKey = isoDay(d)
    const row: ChartSeriesRow = { dateKey, dateLabel: workdayLabel(d, bcp47) }
    for (const cl of callers) {
      const s = statsByCallerDay.get(`${cl.id}|${dateKey}`)
      row[cl.id] = s && s.total >= MIN_CALLS_PER_POINT
        ? Math.round((s.reached / s.total) * 100)
        : null
    }
    rows.push(row)
  }
  const callersWithData = callers.filter(c =>
    rows.some(r => typeof r[c.id] === 'number')
  )
  return { rows, callers: callersWithData }
}

/**
 * Gecombineerd: zowel calls/u als bereikratio per (caller, werkdag) in
 * dezelfde rij. Bedoeld voor een chart met dual Y-axis: linker as toont
 * calls/u (per caller een solid lijn op key `${callerId}`), rechter as
 * toont bereikratio (per caller een gestippelde lijn op key `${callerId}__reach`).
 *
 * Een caller verschijnt in `callers` zodra hij in éen van de twee series data
 * heeft — zo voorkomen we dat hij uit de chart verdwijnt als bv. zijn uren
 * ontbreken maar zijn bereikratio wél berekenbaar is (en vice versa).
 */
export const REACH_SUFFIX = '__reach'
export const APPT_SUFFIX  = '__appt'

/** Minimale shape uit appointments_with_feedback nodig voor de afspraken-lijn. */
export type ChartApptRow = {
  caller_id: string | null
  call_date: string | null
}

export function computeCombinedTeamData(
  callRows:  ChartCallRow[],
  confRows:  ChartConfRow[],
  _rateRows: ChartRateRow[],   // gereserveerd; preset wordt niet meer als fallback gebruikt
  callers:   ChartCaller[],
  from:      Date,
  to:        Date,
  bcp47:     string = 'nl-BE',
  apptRows:  ChartApptRow[] = [],
): { rows: ChartSeriesRow[]; callers: ChartCaller[] } {
  // Calls + reach stats per (caller, dateKey)
  const statsByCallerDay = new Map<string, { total: number; reached: number }>()
  for (const r of callRows) {
    const k = `${r.caller_id}|${r.call_date}`
    if (!statsByCallerDay.has(k)) statsByCallerDay.set(k, { total: 0, reached: 0 })
    const s = statsByCallerDay.get(k)!
    s.total++
    if (isReached(r.status)) s.reached++
  }
  // Confirmations
  const confByCallerWeek = new Map<string, ChartConfRow>()
  for (const c of confRows) {
    confByCallerWeek.set(`${c.caller_id}|${c.week_start_date}`, c)
  }
  // Afspraken per (caller, dateKey) — elke feedback-rij = 1 afspraak.
  // Geen MIN_CALLS_PER_POINT drempel: 1 afspraak is een waardig datapunt.
  const apptsByCallerDay = new Map<string, number>()
  for (const a of apptRows) {
    if (!a.caller_id || !a.call_date) continue
    const dateKey = a.call_date.slice(0, 10)   // dropt eventuele tijd-component
    const k = `${a.caller_id}|${dateKey}`
    apptsByCallerDay.set(k, (apptsByCallerDay.get(k) ?? 0) + 1)
  }

  const rows: ChartSeriesRow[] = []
  for (const d of workdaysBetween(from, to)) {
    const dateKey = isoDay(d)
    const row: ChartSeriesRow = { dateKey, dateLabel: workdayLabel(d, bcp47) }
    for (const cl of callers) {
      const s   = statsByCallerDay.get(`${cl.id}|${dateKey}`)
      const hrs = hoursForCallerDay(d, cl.id, confByCallerWeek)
      const hasMinCalls = !!s && s.total >= MIN_CALLS_PER_POINT

      // calls/u — vereist én ≥20 calls én bevestigde uren > 0
      row[cl.id] = hasMinCalls && hrs && hrs > 0
        ? Math.round((s!.total / hrs) * 10) / 10
        : null

      // bereikratio % — vereist alleen ≥20 calls
      row[`${cl.id}${REACH_SUFFIX}`] = hasMinCalls
        ? Math.round((s!.reached / s!.total) * 100)
        : null

      // afspraken op deze dag — 0 valid (i.p.v. null) zodat de lijn doorloopt
      // op werkdagen zonder afspraak. null enkel wanneer we ook geen calls
      // tellen (= caller inactief die dag).
      const apptCount = apptsByCallerDay.get(`${cl.id}|${dateKey}`) ?? 0
      row[`${cl.id}${APPT_SUFFIX}`] = s || apptCount > 0 ? apptCount : null
    }
    rows.push(row)
  }
  // Een caller blijft over zodra hij in min. één serie min. één datapoint heeft
  const callersWithData = callers.filter(c =>
    rows.some(r =>
      typeof r[c.id] === 'number' ||
      typeof r[`${c.id}${REACH_SUFFIX}`] === 'number' ||
      typeof r[`${c.id}${APPT_SUFFIX}`]  === 'number',
    ),
  )
  return { rows, callers: callersWithData }
}
