import { getTranslations, getLocale } from 'next-intl/server'
import type { ReportPeriod } from '@/lib/report-period'
import DealsBreakdownCard from '@/components/DealsBreakdownCard'
import DealsPerMonthChart from '@/components/DealsPerMonthChart'
import ConversionFunnelChart from '@/components/ConversionFunnelChart'
import CallerReportSection from './CallerReportSection'
import SimulatorSection from './SimulatorSection'
import AnnotationField from './AnnotationField'
import type {
  UploadSummary,
  AppointmentWithFeedback,
  CustomFieldDef,
  CustomFieldsBag,
  CustomInsight,
} from '@/types/database'
import type { SimulatorAssumptions } from '@/lib/simulator'

export interface PerCallerBucket {
  caller_id:   string
  caller_name: string
  uploads:     UploadSummary[]
  feedback:    AppointmentWithFeedback[]
}

export interface SimulatorProps {
  enabled:            boolean
  assumptions:        SimulatorAssumptions
  appointmentsTotal:  number
  dealsRealized:      number
  lostOrNoShow:       number
  costTotal:          number | null
  currency:           string
}

interface Props {
  project: { id: string; name: string; description: string | null; created_at?: string }
  uploads: UploadSummary[]
  feedback: AppointmentWithFeedback[]
  /** Feedback over het HELE kalenderjaar (los van de periode-filter) — voor
   *  de "Deals per maand"-grafiek die altijd het volledige jaar toont.
   *  Optioneel: als niet meegegeven, gebruikt de grafiek `feedback`. */
  yearFeedback?: AppointmentWithFeedback[]
  /** Bijschrift voor de cover, bv. 'Gegenereerd op ...' of 'Gedeeld door ...' */
  generatedNote?: string
  /** Custom field-definities voor dit project. */
  customDefs?: CustomFieldDef[]
  /** Custom fields-waardes per call_record over àlle uploads van dit project. */
  customRows?: CustomFieldsBag[]
  /** AI-gegenereerde inzichten over alle uploads van dit project. */
  customInsights?: CustomInsight[]
  /** Welk periode-bereik dit rapport dekt (week/month). Default = month. */
  period?: ReportPeriod
  /** Voor-geformatteerd periode-label, bv. "28 apr — 28 mei". */
  periodRangeLabel?: string
  /** Unieke sleutel voor annotations/simulator-persistence. */
  periodKey?: string
  /** section_key → text map met alle opgeslagen commentaren. */
  annotations?: Map<string, string>
  /** Per-caller buckets voor de aparte secties. Als leeg → geen secties. */
  perCaller?: PerCallerBucket[]
  /** Simulator-props. Als undefined of enabled=false → geen simulator-sectie. */
  simulator?: SimulatorProps
}

/**
 * Pure render van een project-rapport — geen data fetching.
 * Wordt gebruikt op zowel /dashboard/projects/[id]/report (auth)
 * als /r/[token] (publiek via share-link).
 *
 * Async server component — gebruikt next-intl's getTranslations zodat we
 * de locale-aware datums/getallen kunnen renderen zonder client-side hydration.
 */
export default async function ReportView({
  project,
  uploads,
  feedback,
  yearFeedback,
  generatedNote,
  customDefs = [],
  customRows = [],
  customInsights = [],
  period = 'month',
  periodRangeLabel,
  periodKey = '',
  annotations,
  perCaller = [],
  simulator,
}: Props) {
  // Helper: haal een annotation-tekst op (default ''). Gebruikt overal
  // waar we een <AnnotationField> renderen.
  const ann = (key: string) => annotations?.get(key) ?? ''
  const t = await getTranslations('dashboard.projects.report.view')
  const locale = await getLocale()
  // Map next-intl locale codes naar BCP-47 voor toLocaleDateString
  const bcp47 = locale === 'nl' ? 'nl-BE' : locale

  // Stats
  const totals = uploads.reduce(
    (acc, u) => ({
      calls:        acc.calls        + (u.total_calls  ?? 0),
      reached:      acc.reached      + (u.reached      ?? 0),
      appointments: acc.appointments + (u.appointments ?? 0),
      callbacks:    acc.callbacks    + (u.callbacks    ?? 0),
    }),
    { calls: 0, reached: 0, appointments: 0, callbacks: 0 },
  )

  const reachRate = totals.calls > 0 ? Math.round(totals.reached / totals.calls * 100) : 0
  const convRate  = totals.reached > 0 ? Math.round(totals.appointments / totals.reached * 100) : 0

  const outcomes = feedback.reduce(
    (acc, f) => {
      if (f.outcome === 'deal')      acc.deals++
      if (f.outcome === 'offerte')   acc.offertes++
      if (f.outcome === 'follow_up') acc.follow_up++
      if (f.outcome === 'verloren')  acc.verloren++
      if (f.appointment_status === 'no_show')    acc.no_shows++
      if (f.appointment_status === 'uitgevoerd') acc.uitgevoerd++
      return acc
    },
    { deals: 0, offertes: 0, follow_up: 0, verloren: 0, no_shows: 0, uitgevoerd: 0 },
  )
  const dealRate = totals.appointments > 0 ? Math.round(outcomes.deals / totals.appointments * 100) : 0

  type CallerRow = {
    caller_id: string
    caller_name: string
    calls: number
    reached: number
    appointments: number
    deals: number
    conversion: number
  }
  const callerMap = new Map<string, CallerRow>()
  for (const u of uploads) {
    const key = u.caller_id ?? u.caller_name ?? 'onbekend'
    if (!callerMap.has(key)) {
      callerMap.set(key, {
        caller_id: key,
        caller_name: u.caller_name ?? t('unknownCaller'),
        calls: 0, reached: 0, appointments: 0, deals: 0, conversion: 0,
      })
    }
    const c = callerMap.get(key)!
    c.calls += u.total_calls ?? 0
    c.reached += u.reached ?? 0
    c.appointments += u.appointments ?? 0
  }
  for (const f of feedback) {
    const key = f.caller_id ?? f.caller_name ?? 'onbekend'
    const c = callerMap.get(key)
    if (c && f.outcome === 'deal') c.deals++
  }
  for (const c of Array.from(callerMap.values())) {
    c.conversion = c.calls > 0 ? Math.round(c.appointments / c.calls * 100) : 0
  }
  const callers = Array.from(callerMap.values()).sort((a, b) => b.appointments - a.appointments)

  const objectionMap = new Map<string, number>()
  for (const u of uploads) {
    for (const obj of (u.objections ?? [])) {
      objectionMap.set(obj.label, (objectionMap.get(obj.label) ?? 0) + obj.count)
    }
  }
  const objectionTotal = Array.from(objectionMap.values()).reduce((s, v) => s + v, 0)
  const topObjections = Array.from(objectionMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, count]) => ({ label, count, pct: objectionTotal > 0 ? Math.round(count / objectionTotal * 100) : 0 }))

  const dates = uploads.map(u => new Date(u.uploaded_at)).sort((a, b) => a.getTime() - b.getTime())
  const startDate = dates[0]
  const endDate   = dates[dates.length - 1]

  const fmtDate = (d?: Date) =>
    d ? d.toLocaleDateString(bcp47, { day: 'numeric', month: 'long', year: 'numeric' }) : t('emptyDate')

  return (
    <>
      {/* Cover */}
      <div className="card p-8 mb-6 avoid-break">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">{t('label')}</div>
            <h1 className="text-3xl font-semibold text-gray-900">{project.name}</h1>
            {project.description && (
              <p className="text-sm text-gray-500 mt-2">{project.description}</p>
            )}
          </div>
          <div className="text-right text-xs text-gray-400">
            <div>{t('generatedOn')}</div>
            <div className="font-medium text-gray-700">{fmtDate(new Date())}</div>
            {generatedNote && <div className="mt-1 italic">{generatedNote}</div>}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 pt-6 border-t border-gray-100 text-sm">
          <div>
            <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">
              {t(period === 'week' ? 'periodWeek' : period === 'custom' ? 'periodCustom' : 'periodMonth')}
            </div>
            <div className="text-gray-900 font-medium">
              {periodRangeLabel ?? `${fmtDate(startDate)} — ${fmtDate(endDate)}`}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">{t('uploads')}</div>
            <div className="text-gray-900 font-medium">{uploads.length}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">{t('callersActive')}</div>
            <div className="text-gray-900 font-medium">{callers.length}</div>
          </div>
        </div>
      </div>

      {/* Cover-annotatie: openingsparagraaf/context van de manager */}
      {periodKey && (
        <AnnotationField
          projectId={project.id}
          periodKey={periodKey}
          sectionKey="overview"
          initialText={ann('overview')}
          placeholder={t('annotation.overviewPlaceholder')}
        />
      )}

      {/* Hoofd-KPI's */}
      <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mt-8 mb-3">{t('results')}</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6 avoid-break">
        {[
          { label: t('kpi.leads'),        value: totals.calls,        sub: null },
          { label: t('kpi.reached'),      value: totals.reached,      sub: t('kpi.reachRate', { rate: reachRate }) },
          { label: t('kpi.appointments'), value: totals.appointments, sub: t('kpi.convRate',  { rate: convRate }) },
          { label: t('kpi.deals'),        value: outcomes.deals,      sub: dealRate > 0 ? t('kpi.dealRate', { rate: dealRate }) : t('kpi.noFeedback') },
        ].map(kpi => (
          <div key={kpi.label} className="card p-4">
            <div className="text-xs text-gray-400 mb-1">{kpi.label}</div>
            <div className="text-2xl font-semibold text-gray-900">{kpi.value}</div>
            {kpi.sub && <div className="text-xs text-gray-400 mt-0.5">{kpi.sub}</div>}
          </div>
        ))}
      </div>

      {/* Funnel — trapezium-vorm met per-stap conversieratio's. */}
      <ConversionFunnelChart
        called={totals.calls}
        reached={totals.reached}
        appointments={totals.appointments}
        deals={outcomes.deals}
      />
      {periodKey && (
        <AnnotationField
          projectId={project.id}
          periodKey={periodKey}
          sectionKey="funnel"
          initialText={ann('funnel')}
          placeholder={t('annotation.funnelPlaceholder')}
        />
      )}

      {/* Uitkomsten */}
      {totals.appointments > 0 && (
        <div className="card p-6 mb-6 avoid-break">
          <div className="text-sm font-semibold text-gray-900 mb-4">{t('outcomes.title')}</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: t('outcomes.deals'),    value: outcomes.deals,     color: 'text-green-700  bg-green-50' },
              { label: t('outcomes.quotes'),   value: outcomes.offertes,  color: 'text-blue-700   bg-blue-50' },
              { label: t('outcomes.followUp'), value: outcomes.follow_up, color: 'text-amber-700  bg-amber-50' },
              { label: t('outcomes.lost'),     value: outcomes.verloren,  color: 'text-red-700    bg-red-50' },
            ].map(o => (
              <div key={o.label} className={`p-3 rounded-lg ${o.color}`}>
                <div className="text-xs uppercase tracking-wide opacity-70 mb-1">{o.label}</div>
                <div className="text-2xl font-semibold">{o.value}</div>
              </div>
            ))}
          </div>
          {outcomes.no_shows > 0 && (
            <div className="mt-4 text-xs text-gray-500">
              {t('outcomes.noShows', { count: outcomes.no_shows })}
            </div>
          )}
        </div>
      )}

      {/* Dealstages breakdown = periode-scoped (volgt rapport-periode).
          Deals per maand = volledig kalenderjaar (yearFeedback wanneer
          beschikbaar, fallback op feedback voor backwards-compat). */}
      <DealsBreakdownCard feedback={feedback} />
      {periodKey && (
        <AnnotationField
          projectId={project.id}
          periodKey={periodKey}
          sectionKey="dealstages"
          initialText={ann('dealstages')}
          placeholder={t('annotation.dealstagesPlaceholder')}
        />
      )}
      <DealsPerMonthChart feedback={yearFeedback ?? feedback} />

      {/* ── Per-caller aparte secties ─────────────────────────────────── */}
      {perCaller.length > 1 && periodKey && (
        <div className="mt-10 pt-6 border-t-2 border-gray-200 avoid-break">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-1">
            {t('perCaller.header')}
          </h2>
          <p className="text-xs text-gray-500 mb-3">{t('perCaller.subtitle')}</p>
          <AnnotationField
            projectId={project.id}
            periodKey={periodKey}
            sectionKey="per_caller_intro"
            initialText={ann('per_caller_intro')}
            placeholder={t('annotation.perCallerIntroPlaceholder')}
          />
          {perCaller.map((c, i) => (
            <CallerReportSection
              key={c.caller_id}
              projectId={project.id}
              periodKey={periodKey}
              callerId={c.caller_id}
              callerName={c.caller_name}
              uploads={c.uploads}
              feedback={c.feedback}
              introText={ann(`caller:${c.caller_id}:intro`)}
              notesText={ann(`caller:${c.caller_id}:notes`)}
              index={i + 1}
            />
          ))}
        </div>
      )}

      {/* ── Simulator: projectie bij afgesloten pipeline ───────────────── */}
      {simulator?.enabled && periodKey && (
        <div className="mt-10 pt-6 border-t-2 border-gray-200 avoid-break">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-1">
            {t('simulatorHeader')}
          </h2>
          <p className="text-xs text-gray-500 mb-3">{t('simulatorSubtitle')}</p>
          <SimulatorSection
            projectId={project.id}
            periodKey={periodKey}
            appointmentsTotal={simulator.appointmentsTotal}
            dealsRealized={simulator.dealsRealized}
            lostOrNoShow={simulator.lostOrNoShow}
            costTotal={simulator.costTotal}
            currency={simulator.currency}
            initialAssumptions={simulator.assumptions}
            initialAnnotation={ann('simulator')}
          />
        </div>
      )}

      {/* Custom velden — cross-upload aggregatie + AI-inzichten */}
      {customDefs.length > 0 && customRows.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mt-8 mb-3">{t('custom.title')}</h2>
          <div className="card p-6 mb-6 avoid-break">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {customDefs.map(def => {
                const values = customRows
                  .map(r => r[def.key])
                  .filter(v => v !== null && v !== undefined && v !== '')

                if (def.type === 'number') {
                  const nums = values.map(Number).filter(n => Number.isFinite(n))
                  if (nums.length === 0) {
                    return (
                      <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                        <div className="text-xs text-gray-400">{def.label}</div>
                        <div className="text-sm text-gray-300 mt-1">{t('custom.noData')}</div>
                      </div>
                    )
                  }
                  const sum = nums.reduce((s, n) => s + n, 0)
                  const avg = sum / nums.length
                  const fmtNum = (n: number, maxFrac: number) =>
                    n.toLocaleString(bcp47, { maximumFractionDigits: maxFrac })
                  return (
                    <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                      <div className="text-xs text-gray-400 mb-1">{def.label}</div>
                      <div className="text-2xl font-semibold text-gray-900">
                        {fmtNum(sum, 2)}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {t('custom.numberAvg', { avg: fmtNum(avg, 1), count: nums.length })}
                      </div>
                    </div>
                  )
                }

                if (def.type === 'date') {
                  const dates = values.map(v => new Date(String(v))).filter(d => !Number.isNaN(d.getTime()))
                  if (dates.length === 0) {
                    return (
                      <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                        <div className="text-xs text-gray-400">{def.label}</div>
                        <div className="text-sm text-gray-300 mt-1">{t('custom.noData')}</div>
                      </div>
                    )
                  }
                  const earliest = new Date(Math.min(...dates.map(d => d.getTime())))
                  const latest = new Date(Math.max(...dates.map(d => d.getTime())))
                  const fmt = (d: Date) => d.toLocaleDateString(bcp47, { day: 'numeric', month: 'short' })
                  return (
                    <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                      <div className="text-xs text-gray-400 mb-1">{def.label}</div>
                      <div className="text-sm font-medium text-gray-900">
                        {fmt(earliest)} — {fmt(latest)}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {t('custom.dateCount', { count: dates.length })}
                      </div>
                    </div>
                  )
                }

                if (def.type === 'category') {
                  const counts = new Map<string, number>()
                  for (const v of values) {
                    const k = String(v)
                    counts.set(k, (counts.get(k) ?? 0) + 1)
                  }
                  const top = Array.from(counts.entries())
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                  const total = values.length
                  return (
                    <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                      <div className="text-xs text-gray-400 mb-2">{def.label}</div>
                      {top.length === 0 ? (
                        <div className="text-sm text-gray-300">{t('custom.noData')}</div>
                      ) : (
                        <div className="space-y-1">
                          {top.map(([cat, n]) => (
                            <div key={cat} className="flex items-center justify-between text-sm">
                              <span className="text-gray-700 truncate max-w-[180px]">{cat}</span>
                              <span className="text-xs text-gray-400">
                                {n} ({Math.round(n / total * 100)}%)
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                }

                // text
                return (
                  <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">{def.label}</div>
                    <div className="text-sm text-gray-700">{t('custom.textCount', { count: values.length })}</div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* AI inzichten — samengevoegd over alle uploads */}
      {customInsights.length > 0 && (() => {
        // Dedup op headline (verschillende uploads kunnen vergelijkbare insights produceren)
        const seen = new Set<string>()
        const unique = customInsights.filter(ins => {
          if (seen.has(ins.headline)) return false
          seen.add(ins.headline)
          return true
        })
        const labelsByKey = new Map(customDefs.map(d => [d.key, d.label]))
        return (
          <>
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mt-8 mb-3">
              {t('insights.title')} <span className="text-gray-400 font-normal">{t('insights.subtitle')}</span>
            </h2>
            <div className="card p-6 mb-6 avoid-break">
              <div className="space-y-3">
                {unique.map((insight, i) => {
                  const fieldLabels = (insight.field_keys ?? [])
                    .map(k => labelsByKey.get(k) ?? k)
                    .join(' + ')
                  return (
                    <div key={i} className="border-l-2 border-brand-300 pl-3 py-1">
                      <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                        <span className="text-sm font-medium text-gray-900">{insight.headline}</span>
                        {fieldLabels && (
                          <span className="text-xs text-gray-400">— {fieldLabels}</span>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 leading-relaxed">{insight.detail}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )
      })()}

      {/* Caller performantie */}
      <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mt-8 mb-3">{t('perCaller.title')}</h2>
      <div className="card p-6 mb-6 avoid-break">
        {callers.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">{t('perCaller.empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                <th className="pb-2 font-medium">{t('perCaller.headers.caller')}</th>
                <th className="pb-2 font-medium text-right">{t('perCaller.headers.called')}</th>
                <th className="pb-2 font-medium text-right">{t('perCaller.headers.reached')}</th>
                <th className="pb-2 font-medium text-right">{t('perCaller.headers.appointments')}</th>
                <th className="pb-2 font-medium text-right">{t('perCaller.headers.conversion')}</th>
                <th className="pb-2 font-medium text-right">{t('perCaller.headers.deals')}</th>
              </tr>
            </thead>
            <tbody>
              {callers.map((c, i) => (
                <tr key={c.caller_id} className="border-b border-gray-50 last:border-0">
                  <td className="py-2.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-5 h-5 rounded-full text-xs flex items-center justify-center font-medium ${
                        i === 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'
                      }`}>{i + 1}</div>
                      <span className="text-gray-900 font-medium">{c.caller_name}</span>
                    </div>
                  </td>
                  <td className="py-2.5 text-right text-gray-700">{c.calls}</td>
                  <td className="py-2.5 text-right text-gray-700">{c.reached}</td>
                  <td className="py-2.5 text-right text-brand-700 font-medium">{c.appointments}</td>
                  <td className="py-2.5 text-right text-gray-700">{c.conversion}%</td>
                  <td className="py-2.5 text-right text-green-700 font-medium">{c.deals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Top bezwaren */}
      {topObjections.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mt-8 mb-3">
            {t('objections.title')} <span className="text-gray-400 font-normal">{t('objections.subtitle')}</span>
          </h2>
          <div className="card p-6 mb-6 avoid-break">
            <div className="space-y-3">
              {topObjections.map(obj => (
                <div key={obj.label} className="flex items-center gap-3">
                  <div className="w-44 text-sm text-gray-700">{obj.label}</div>
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-amber-400" style={{ width: `${obj.pct}%` }}/>
                  </div>
                  <div className="w-12 text-right text-xs text-gray-500">{obj.pct}%</div>
                  <div className="w-12 text-right text-xs text-gray-400">{obj.count}x</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-4">
              {t('objections.aggregation', { count: uploads.length })}
            </p>
          </div>
        </>
      )}

      {/* Sales feedback */}
      {feedback.filter(f => f.outcome && f.outcome !== 'geen').length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mt-8 mb-3">{t('feedback.title')}</h2>
          <div className="card p-6 mb-6">
            <div className="space-y-3">
              {feedback
                .filter(f => f.outcome && f.outcome !== 'geen' && f.sales_notes)
                .slice(0, 8)
                .map((f, i) => (
                  <div key={i} className="border-l-2 border-brand-200 pl-3 py-1 avoid-break">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-900">
                        {f.lead_name ?? t('feedback.leadFallback')}
                      </span>
                      <span className={`badge ${
                        f.outcome === 'deal' ? 'badge-green' :
                        f.outcome === 'verloren' ? 'badge-red' : 'badge-amber'
                      }`}>{f.outcome}</span>
                    </div>
                    <p className="text-sm text-gray-600 italic">&quot;{f.sales_notes}&quot;</p>
                    <div className="text-xs text-gray-400 mt-1">
                      {f.sales_rep_name && <>{t('feedback.byPrefix', { name: f.sales_rep_name })}</>}
                      {t('feedback.callerLabel', { name: f.caller_name ?? t('emptyDate') })}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </>
      )}

      <div className="text-center text-xs text-gray-400 mt-12 pt-6 border-t border-gray-100">
        {t('footer', { date: fmtDate(new Date()) })}
      </div>
    </>
  )
}
