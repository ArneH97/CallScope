'use client'

import { useTranslations, useLocale } from 'next-intl'
import type { CostMetrics } from '@/lib/cost-metrics'

/**
 * Toont de kost-metrics van een project (uren, kost, kost/lead-afspraak-deal,
 * per-caller breakdown). Ontvangt al-berekende metrics.
 *
 * Client component zodat zowel server components (de rapport-pagina, vanuit
 * een async server component die calcProjectCostMetrics() vooraf doet) als
 * client components (CostMetricsForProject die zelf fetcht via /api/...) deze
 * card kunnen gebruiken. Server-components mogen client-components renderen,
 * dus de async server kant blijft prima werken.
 *
 * Returnt null als metrics === null (= feature uit voor dit project).
 */
export default function CostMetricsCard({ metrics }: { metrics: CostMetrics | null }) {
  const t = useTranslations('dashboard.projects.report.cost')
  const locale = useLocale()
  const bcp47 = locale === 'nl' ? 'nl-BE' : locale

  if (!metrics) return null

  const fmt = (n: number, decimals = 0) => {
    if (!Number.isFinite(n)) return t('empty')
    return new Intl.NumberFormat(bcp47, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n)
  }
  const eur = (n: number | null, decimals = 0) => n == null ? t('empty') : `€${fmt(n, decimals)}`

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-1">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="#1a35e6" strokeWidth="1.5"/>
          <path d="M12 7v5l3 2" stroke="#1a35e6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <h3 className="font-semibold text-gray-900">{t('title')}</h3>
      </div>
      <p className="text-xs text-gray-500 mb-4 leading-relaxed">
        {t('subtitle')}
      </p>

      {/* Top-line metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Metric label={t('totalHours')} value={`${fmt(metrics.total_hours, 1)}u`} />
        <Metric label={t('totalCost')}  value={eur(metrics.total_cost)} highlight />
        <Metric label={t('totalDeals')} value={String(metrics.deals)} />
      </div>

      {/* Effiency / kost-per metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Metric label={t('hoursPerAppt')} value={metrics.hours_per_appt != null ? `${fmt(metrics.hours_per_appt, 1)}u` : t('empty')} />
        <Metric label={t('hoursPerDeal')} value={metrics.hours_per_deal != null ? `${fmt(metrics.hours_per_deal, 1)}u` : t('empty')} />
        <Metric label={t('costPerLead')}  value={eur(metrics.cost_per_lead, 2)} />
        <Metric label={t('costPerAppt')}  value={eur(metrics.cost_per_appt)} />
        <Metric label={t('costPerDeal')}  value={eur(metrics.cost_per_deal)} highlight />
      </div>

      {/* Per-caller breakdown */}
      {metrics.per_caller.length > 0 && (
        <div>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">{t('perCallerTitle')}</div>
          <div className="space-y-1.5">
            {metrics.per_caller.map(c => (
              <div key={c.caller_id} className="flex items-center justify-between gap-2 text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 flex-shrink-0">
                    {c.caller_name[0]}
                  </div>
                  <span className="text-gray-700 truncate">{c.caller_name}</span>
                  {!c.confirmed && (
                    <span className="text-xs text-amber-600" title={t('presetTip')}>
                      {t('presetBadge')}
                    </span>
                  )}
                </div>
                <div className="text-gray-600 flex-shrink-0">
                  {fmt(c.hours, 1)}u <span className="text-gray-400">·</span> {eur(c.cost)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, highlight }: {
  label:      string
  value:      string
  highlight?: boolean
}) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
      <div className={`text-base font-semibold ${highlight ? 'text-brand-700' : 'text-gray-900'}`}>
        {value}
      </div>
    </div>
  )
}
