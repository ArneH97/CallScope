import { getTranslations } from 'next-intl/server'
import DealsBreakdownCard from '@/components/DealsBreakdownCard'
import ConversionFunnelChart from '@/components/ConversionFunnelChart'
import AnnotationField from './AnnotationField'
import StatusBreakdownCard from './StatusBreakdownCard'
import type { UploadSummary, AppointmentWithFeedback } from '@/types/database'

interface Props {
  projectId:      string
  periodKey:      string
  callerId:       string
  callerName:     string
  /** Uploads gefilterd op deze caller. */
  uploads:        UploadSummary[]
  /** Feedback gefilterd op deze caller. */
  feedback:       AppointmentWithFeedback[]
  /** Raw call_records.status waarden voor deze caller — status-breakdown. */
  statuses?:      (string | null)[]
  /** Annotations voor deze caller-sectie (intro + trailing note). */
  introText:      string
  notesText:      string
  /** Volgnummer voor de sectie-titel ("Resultaten Dieter"). */
  index?:         number
}

/**
 * Volledige per-caller rapport-sectie.
 * Bevat: KPI-strip · funnel · dealstages-breakdown · top bezwaren · notities.
 *
 * Data wordt in de parent (report-page) al gesplitst per caller — deze
 * component doet enkel het aggregeren + rendering. Zo blijft de fetch
 * simpel en kunnen we in de toekomst ook per-caller specifieke queries
 * toevoegen zonder deze component aan te raken.
 *
 * Elke sectie wordt afgesloten met "avoid-break" op de card zodat de
 * browser hem zoveel mogelijk op één PDF-pagina houdt.
 */
export default async function CallerReportSection({
  projectId, periodKey, callerId, callerName,
  uploads, feedback, statuses = [], introText, notesText, index,
}: Props) {
  const t = await getTranslations('dashboard.projects.report.perCaller')

  // Aggregaten. Zelfde formules als de team-totalen in ReportView, maar op
  // de al-gefilterde subset. Als een caller in de periode 0 uploads heeft
  // renderen we niks — anders krijg je lege secties in het rapport.
  if (uploads.length === 0 && feedback.length === 0) return null

  const totals = uploads.reduce(
    (acc, u) => ({
      calls:        acc.calls        + (u.total_calls  ?? 0),
      reached:      acc.reached      + (u.reached      ?? 0),
      appointments: acc.appointments + (u.appointments ?? 0),
    }),
    { calls: 0, reached: 0, appointments: 0 },
  )
  const reachRate = totals.calls > 0 ? Math.round(totals.reached / totals.calls * 100) : 0
  const convRate  = totals.reached > 0 ? Math.round(totals.appointments / totals.reached * 100) : 0

  const deals     = feedback.filter(f => f.outcome === 'deal').length
  const dealRate  = totals.appointments > 0 ? Math.round(deals / totals.appointments * 100) : 0

  // Top-5 bezwaren voor deze caller (uit uploads.objections)
  const objectionMap = new Map<string, number>()
  for (const u of uploads) {
    for (const obj of (u.objections ?? [])) {
      objectionMap.set(obj.label, (objectionMap.get(obj.label) ?? 0) + obj.count)
    }
  }
  const objectionTotal = Array.from(objectionMap.values()).reduce((s, v) => s + v, 0)
  const topObjections = Array.from(objectionMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({
      label, count,
      pct: objectionTotal > 0 ? Math.round(count / objectionTotal * 100) : 0,
    }))

  return (
    <section className="mt-8 avoid-break">
      {/* Header */}
      <div className="mb-4 pb-3 border-b border-gray-200">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h2 className="text-xl font-semibold text-gray-900">
            {index != null && <span className="text-gray-400 mr-1">{index}.</span>}
            {t('sectionTitle', { name: callerName })}
          </h2>
        </div>
        {/* Intro / rol-omschrijving — persistent per (project, periode, caller) */}
        <AnnotationField
          projectId={projectId}
          periodKey={periodKey}
          sectionKey={`caller:${callerId}:intro`}
          initialText={introText}
          placeholder={t('introPlaceholder')}
          compact
        />
      </div>

      {/* KPI-strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Kpi label={t('calls')} value={totals.calls} />
        <Kpi label={t('reachRate')} value={`${reachRate}%`} sub={t('reachedSub', { n: totals.reached })} />
        <Kpi
          label={t('appointments')}
          value={totals.appointments}
          sub={totals.reached > 0 ? t('conversionSub', { n: convRate }) : undefined}
          accent
        />
        <Kpi
          label={t('deals')}
          value={deals}
          sub={totals.appointments > 0 ? t('dealRateSub', { n: dealRate }) : undefined}
          accent
        />
      </div>

      {/* Funnel + dealstages */}
      {totals.calls > 0 && (
        <div className="mb-2">
          <ConversionFunnelChart
            called={totals.calls}
            reached={totals.reached}
            appointments={totals.appointments}
            deals={deals}
          />
        </div>
      )}

      {feedback.length > 0 && (
        <DealsBreakdownCard feedback={feedback} />
      )}

      {/* Ruwe status-verdeling voor deze caller — bv voicemail vs geen interesse */}
      {statuses.length > 0 && (
        <StatusBreakdownCard statuses={statuses} compact />
      )}

      {/* Top bezwaren */}
      {topObjections.length > 0 && (
        <div className="card p-5 mb-4 avoid-break">
          <div className="text-sm font-semibold text-gray-900 mb-3">{t('objectionsTitle')}</div>
          <div className="space-y-2">
            {topObjections.map(obj => (
              <div key={obj.label} className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-700 truncate flex-1">{obj.label}</span>
                <div className="flex items-center gap-2 w-40 flex-shrink-0">
                  <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-amber-400" style={{ width: `${obj.pct}%` }}/>
                  </div>
                  <span className="text-xs text-gray-400 w-16 text-right">
                    {obj.count}× ({obj.pct}%)
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trailing notitie — "wat viel op bij deze caller" */}
      <AnnotationField
        projectId={projectId}
        periodKey={periodKey}
        sectionKey={`caller:${callerId}:notes`}
        initialText={notesText}
        placeholder={t('notesPlaceholder')}
      />
    </section>
  )
}

function Kpi({ label, value, sub, accent }: {
  label: string; value: number | string; sub?: string; accent?: boolean
}) {
  return (
    <div className="card p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-semibold ${accent ? 'text-brand-700' : 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}
