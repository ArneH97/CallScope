'use client'

import { useTranslations } from 'next-intl'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import {
  computeDealBreakdown,
  DEAL_STAGE_ORDER,
  DEAL_STAGE_COLORS,
  type FeedbackRow,
  type DealStageBucket,
} from '@/lib/deals-charts'

interface Props {
  feedback: FeedbackRow[]
}

/**
 * Donut chart met per-stage verdeling van afspraken met feedback.
 * "Nog geen feedback" (bucket `other`) wordt bewust APART getoond bovenaan
 * als attention-banner — anders zou hij bij typisch cold-calling gedrag
 * (waar de sales rep nog niet gemarkeerd heeft) 80-95% van de taart pakken
 * en de échte stage-verdeling onzichtbaar maken.
 *
 * Layout:
 *   ┌────────────────────────────────────────────┐
 *   │ ⚠  24 van 26 afspraken wachten op feedback │
 *   ├──────────────────┬─────────────────────────┤
 *   │                  │ Gewonnen · 1 (50%)     │
 *   │     [DONUT]      │ Offerte lopen · 0     │
 *   │      totaal: 2   │ Follow-up · 1 (50%)   │
 *   │                  │ No show · 0            │
 *   │                  │ Verloren · 0           │
 *   └──────────────────┴─────────────────────────┘
 */
export default function DealsBreakdownCard({ feedback }: Props) {
  const t = useTranslations('dashboard.deals.breakdown')
  const { buckets, total } = computeDealBreakdown(feedback)

  if (total === 0) return null

  // "Actieve" stages = deals waar écht iets mee gebeurd is. `other` (nog geen
  // feedback) en `upcoming` (afspraak nog niet geweest) hebben elk een eigen
  // banner en horen niet in de donut — anders overschaduwen ze de échte mix.
  const activeStages: DealStageBucket[] = DEAL_STAGE_ORDER.filter(b => b !== 'other' && b !== 'upcoming')
  const activeTotal = activeStages.reduce((s, b) => s + buckets[b], 0)
  const awaitingCount = buckets.other
  const awaitingPct   = total > 0 ? Math.round(awaitingCount / total * 100) : 0
  const upcomingCount = buckets.upcoming
  const upcomingPct   = total > 0 ? Math.round(upcomingCount / total * 100) : 0

  const pieData = activeStages
    .filter(b => buckets[b] > 0)
    .map(b => ({
      name:  t(`labels.${b}`),
      value: buckets[b],
      fill:  DEAL_STAGE_COLORS[b],
    }))

  return (
    <div className="card p-5 mb-6 avoid-break">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="text-sm font-medium text-gray-900">{t('title')}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {t('subtitle', { total })}
          </div>
        </div>
      </div>

      {/* Upcoming-banner — informatief (niet actie-vereist): deze afspraken
          liggen nog in de toekomst, dus feedback is nog niet verwachtbaar.
          Indigo/blauwe tint zodat hij duidelijk onderscheidt van de amber
          "wacht op feedback"-banner die WEL actie vraagt. */}
      {upcomingCount > 0 && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2.5 bg-indigo-50 border border-indigo-100 rounded-lg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-indigo-600 flex-shrink-0">
            <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="2"/>
            <path d="M8 2v4M16 2v4M3 10h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <div className="text-sm text-indigo-900 flex-1">
            {t('upcomingBanner', { count: upcomingCount, total, pct: upcomingPct })}
          </div>
        </div>
      )}

      {/* Awaiting-feedback banner — alleen tonen als er iemand op feedback wacht */}
      {awaitingCount > 0 && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2.5 bg-amber-50 border border-amber-100 rounded-lg">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-amber-600 flex-shrink-0">
            <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div className="text-sm text-amber-900 flex-1">
            {t('awaitingBanner', { count: awaitingCount, total, pct: awaitingPct })}
          </div>
        </div>
      )}

      {activeTotal === 0 ? (
        // Twee edge cases: alles nog upcoming (banner al zichtbaar) of
        // alles awaiting (amber banner zichtbaar). Toon geen "allAwaiting"
        // tekst als het puur upcoming is — dat zou fout aanvoelen.
        awaitingCount > 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">{t('allAwaiting')}</p>
        ) : null
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
          {/* Donut */}
          <div className="relative">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={2}
                  stroke="#fff"
                  strokeWidth={2}
                >
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '0.5px solid #e5e7eb', borderRadius: 8, boxShadow: 'none' }}
                  formatter={(value: number, name: string) => [value, name]}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Centraal totaal in het donut-gat */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div className="text-2xl font-semibold text-gray-900">{activeTotal}</div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wide">{t('withFeedback')}</div>
            </div>
          </div>

          {/* Zij-lijst — alle stages inclusief 0-counts voor volledig beeld */}
          <div className="space-y-2">
            {activeStages.map(bucket => {
              const count = buckets[bucket]
              const pct   = activeTotal > 0 ? Math.round(count / activeTotal * 100) : 0
              return (
                <div key={bucket} className="flex items-center justify-between border-b border-gray-50 last:border-0 pb-1.5">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: DEAL_STAGE_COLORS[bucket], opacity: count === 0 ? 0.25 : 1 }}
                    />
                    <span className={`text-sm ${count === 0 ? 'text-gray-400' : 'text-gray-700'}`}>
                      {t(`labels.${bucket}`)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className={`text-sm font-semibold ${count === 0 ? 'text-gray-400' : 'text-gray-900'}`}>
                      {count}
                    </span>
                    <span className="text-xs text-gray-400 ml-2 w-10 inline-block">{pct}%</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
