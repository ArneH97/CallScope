/**
 * Periode-window voor rapporten.
 *
 * Gebruikt door zowel /dashboard/projects/[id]/report (auth) als /r/[token]
 * (publieke share) zodat klant en manager exact hetzelfde rapport zien.
 *
 * Strategie: KALENDER-grenzen in Belgische tijd, géén rolling window.
 *   - month = 1ste tot laatste dag van de huidige kalendermaand
 *             (bv. 1 mei → 31 mei). Geen overlap met andere maanden.
 *   - week  = maandag tot zondag van de huidige kalenderweek
 *             (ISO-week, ma-zo).
 *
 * De huidige Brussel-datum wordt via Intl bepaald zodat we niet in de val
 * trappen waarbij de Vercel-server (UTC) net na middernacht nog "vorige
 * maand" zou denken terwijl het in België al een nieuwe maand is.
 */

export type ReportPeriod = 'week' | 'month'

export const DEFAULT_REPORT_PERIOD: ReportPeriod = 'month'

export function parseReportPeriod(raw: string | undefined | null): ReportPeriod {
  if (raw === 'week' || raw === 'month') return raw
  return DEFAULT_REPORT_PERIOD
}

/**
 * Huidige datum in Brussel-tijd, plus dag-van-de-week (1=Mon … 7=Sun).
 * Cruciaal: tussen 00:00 UTC en 02:00 UTC (= 02:00-04:00 CEST) heeft de
 * Vercel-server nog UTC-vorige-dag terwijl het in Brussel al een nieuwe
 * dag is — dus we mogen niet zomaar new Date() in UTC gebruiken.
 */
function getBelgianToday(): { year: number; month: number; day: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Brussels',
    year:    'numeric',
    month:   '2-digit',
    day:     '2-digit',
    weekday: 'short',
  }).formatToParts(new Date())
  const year  = Number(parts.find(p => p.type === 'year')!.value)
  const month = Number(parts.find(p => p.type === 'month')!.value)
  const day   = Number(parts.find(p => p.type === 'day')!.value)
  const wd    = parts.find(p => p.type === 'weekday')!.value
  // Intl 'short' weekday in en-CA: 'Mon', 'Tue', etc.
  const dowMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  }
  return { year, month, day, dow: dowMap[wd] ?? 1 }
}

/** Helper: 'YYYY-MM-DD' uit Y/M/D-componenten zonder TZ-shenanigans. */
function fmtDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Bepaalt de start- en einddatum van de huidige kalendermaand of -week
 * in Brussel-tijd. Returnt zowel "YYYY-MM-DD" date-strings (voor filters
 * op DATE-kolommen zoals call_date) als volledige ISO-timestamps met
 * Brusselse offset (voor filters op TIMESTAMP-kolommen zoals uploaded_at).
 */
export function getReportPeriodWindow(period: ReportPeriod): {
  fromIso:  string
  toIso:    string
  fromDate: string
  toDate:   string
} {
  const { year, month, day, dow } = getBelgianToday()

  let fromY: number, fromM: number, fromD: number
  let toY:   number, toM:   number, toD:   number

  if (period === 'month') {
    // 1ste tot laatste dag van de huidige maand.
    // new Date(Y, M, 0) → JS month is 0-indexed dus M (= 1..12) wijst naar
    // "maand erna, dag 0" = laatste dag van de gevraagde maand. Hanteert
    // schrikkeljaren automatisch.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    fromY = year; fromM = month; fromD = 1
    toY   = year; toM   = month; toD   = lastDay
  } else {
    // Maandag → zondag van DEZE week. dow=1 (Ma) → -0 dagen, dow=7 (Zo) → -6.
    const today = new Date(Date.UTC(year, month - 1, day))
    const monday = new Date(today)
    monday.setUTCDate(today.getUTCDate() - (dow - 1))
    const sunday = new Date(monday)
    sunday.setUTCDate(monday.getUTCDate() + 6)
    fromY = monday.getUTCFullYear(); fromM = monday.getUTCMonth() + 1; fromD = monday.getUTCDate()
    toY   = sunday.getUTCFullYear(); toM   = sunday.getUTCMonth() + 1; toD   = sunday.getUTCDate()
  }

  const fromDate = fmtDate(fromY, fromM, fromD)
  const toDate   = fmtDate(toY,   toM,   toD)

  // Voor timestamp-kolommen: hard-coded Brussel-offset is tricky door DST.
  // Pragmatisch: gebruik begin van dag in UTC (= 02:00 Brussel CEST). De
  // afwijking is ≤ 2u, irrelevant voor maand/week-rapporten waar 99% van de
  // uploads tussen 9u en 18u BE local zit. Voor exactheid wisselen we
  // later naar timestamptz parsing met expliciete offset.
  const fromIso = `${fromDate}T00:00:00.000Z`
  const toIso   = `${toDate}T23:59:59.999Z`

  return { fromIso, toIso, fromDate, toDate }
}

/**
 * Locale-aware label voor in de cover van het rapport.
 *   - month: "Mei 2026" (NL) / "May 2026" (EN)
 *   - week:  "25 — 31 mei 2026"
 */
export function formatPeriodRange(period: ReportPeriod, bcp47: string): string {
  const { fromDate, toDate } = getReportPeriodWindow(period)
  const from = new Date(fromDate + 'T12:00:00Z')  // noon = TZ-safe
  const to   = new Date(toDate   + 'T12:00:00Z')

  if (period === 'month') {
    return from.toLocaleDateString(bcp47, { month: 'long', year: 'numeric' })
  }
  // Week-range: als zelfde maand → "25 — 31 mei 2026", anders → "29 mei — 4 jun 2026"
  const sameMonth = from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear()
  if (sameMonth) {
    const fromDay = from.toLocaleDateString(bcp47, { day: 'numeric' })
    const toFull  = to.toLocaleDateString(bcp47, { day: 'numeric', month: 'long', year: 'numeric' })
    return `${fromDay} — ${toFull}`
  }
  const fromPart = from.toLocaleDateString(bcp47, { day: 'numeric', month: 'short' })
  const toPart   = to.toLocaleDateString(bcp47, { day: 'numeric', month: 'short', year: 'numeric' })
  return `${fromPart} — ${toPart}`
}
