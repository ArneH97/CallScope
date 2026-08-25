'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { computeSimulation, type SimulatorAssumptions } from '@/lib/simulator'
import AnnotationField from './AnnotationField'

interface Props {
  projectId:            string
  periodKey:            string
  /** Aantal afspraken in de periode (uit filteredFeedback). */
  appointmentsTotal:    number
  /** Al effectief gewonnen deals in periode. */
  dealsRealized:        number
  /** Al negatief afgesloten (verloren + no-show) in periode. */
  lostOrNoShow:         number
  /** Totale kost van de periode. Als null: geen ROI berekening. */
  costTotal:            number | null
  currency:             string
  /** Startwaarden voor de aannames (uit projects tabel). */
  initialAssumptions:   SimulatorAssumptions
  initialAnnotation:    string
}

/**
 * "Projectie bij afgesloten pipeline"-sectie in het rapport.
 *
 * cc_manager stelt de aannames in (no-show %, closing %, ARR/deal) via drie
 * kleine inputs. Cijfers rekenen live door en tonen: hoeveel deals er nog
 * verwacht mogen worden, welke extra ARR dat oplevert, en de ROI vs de
 * kost van deze periode. Aannames zijn persistent via een aparte POST call.
 *
 * In print (PDF) verbergen we de bewerkbare inputs — enkel de eindcijfers
 * plus de aannames-samenvatting blijven zichtbaar zodat de klant ziet
 * waarop de projectie gebaseerd is.
 */
export default function SimulatorSection({
  projectId, periodKey,
  appointmentsTotal, dealsRealized, lostOrNoShow, costTotal, currency,
  initialAssumptions, initialAnnotation,
}: Props) {
  const t = useTranslations('dashboard.projects.report.simulator')

  const [noShow, setNoShow]         = useState(initialAssumptions.no_show_rate)
  const [closing, setClosing]       = useState(initialAssumptions.closing_rate)
  const [arr, setArr]               = useState(initialAssumptions.arr_per_deal)
  const [saving, setSaving]         = useState(false)
  const [saveErr, setSaveErr]       = useState<string | null>(null)

  const sim = computeSimulation({
    appointments_total: appointmentsTotal,
    deals_realized:     dealsRealized,
    lost_or_no_show:    lostOrNoShow,
    no_show_rate:       noShow,
    closing_rate:       closing,
    arr_per_deal:       arr,
    cost_total:         costTotal ?? 0,
  })

  async function saveAssumptions() {
    setSaving(true)
    setSaveErr(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/simulator-assumptions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          no_show_rate: noShow,
          closing_rate: closing,
          arr_per_deal: arr,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? t('saveFailed'))
      }
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const fmtCur = (n: number) => n.toLocaleString('nl-BE', {
    style: 'currency', currency, maximumFractionDigits: 0,
  })

  return (
    <div className="card p-5 mt-6 avoid-break">
      <div className="mb-3">
        <div className="text-sm font-semibold text-gray-900">{t('title')}</div>
        <p className="text-xs text-gray-500 mt-1">{t('subtitle')}</p>
      </div>

      {/* Inputs — verbergen in print */}
      <div className="no-print grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 pb-4 border-b border-gray-100">
        <label className="block">
          <span className="text-xs text-gray-500">{t('noShowLabel')}</span>
          <div className="flex items-center gap-1 mt-1">
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={noShow}
              onChange={e => setNoShow(Number(e.target.value))}
              onBlur={saveAssumptions}
              className="w-20 text-sm border border-gray-200 rounded px-2 py-1"
            />
            <span className="text-xs text-gray-400">%</span>
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">{t('closingLabel')}</span>
          <div className="flex items-center gap-1 mt-1">
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={closing}
              onChange={e => setClosing(Number(e.target.value))}
              onBlur={saveAssumptions}
              className="w-20 text-sm border border-gray-200 rounded px-2 py-1"
            />
            <span className="text-xs text-gray-400">%</span>
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">{t('arrLabel')}</span>
          <div className="flex items-center gap-1 mt-1">
            <span className="text-xs text-gray-400">{currency === 'EUR' ? '€' : currency}</span>
            <input
              type="number"
              min={0}
              step={50}
              value={arr}
              onChange={e => setArr(Number(e.target.value))}
              onBlur={saveAssumptions}
              className="w-24 text-sm border border-gray-200 rounded px-2 py-1"
            />
          </div>
        </label>
      </div>
      {saveErr && <p className="text-xs text-red-600 -mt-2 mb-3 no-print">{saveErr}</p>}
      {saving && <p className="text-xs text-gray-400 -mt-2 mb-3 no-print">{t('saving')}</p>}

      {/* Aannames-samenvatting — WEL zichtbaar in print zodat klant context ziet */}
      <div className="hidden print:block text-xs text-gray-500 mb-3">
        {t('assumptionsSummary', { noShow, closing, arr: fmtCur(arr) })}
      </div>

      {/* Uitkomst-cijfers */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Metric label={t('pendingLabel')} value={sim.pending_appointments.toString()} hint={t('pendingHint')} />
        <Metric
          label={t('projectedDealsLabel')}
          value={sim.projected_total_deals.toString()}
          hint={t('projectedDealsHint', {
            realized: dealsRealized,
            newDeals: sim.projected_new_deals,
          })}
        />
        <Metric
          label={t('projectedArrLabel')}
          value={fmtCur(sim.projected_arr)}
          hint={t('projectedArrHint', { additional: fmtCur(sim.additional_arr) })}
          highlight
        />
        {sim.roi_ratio != null ? (
          <Metric
            label={t('roiLabel')}
            value={`${Math.round(sim.roi_ratio * 100)}%`}
            hint={t('roiHint', { cost: fmtCur(costTotal ?? 0) })}
            highlight={sim.roi_ratio >= 1}
          />
        ) : (
          <Metric label={t('roiLabel')} value="—" hint={t('roiNoCost')} />
        )}
      </div>

      {/* Notitie-veld — voor de manager om context/waarschuwingen te noteren */}
      <AnnotationField
        projectId={projectId}
        periodKey={periodKey}
        sectionKey="simulator"
        initialText={initialAnnotation}
        placeholder={t('annotationPlaceholder')}
      />
    </div>
  )
}

function Metric({ label, value, hint, highlight }: {
  label: string; value: string; hint?: string; highlight?: boolean
}) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-semibold ${highlight ? 'text-brand-700' : 'text-gray-900'}`}>
        {value}
      </div>
      {hint && <div className="text-xs text-gray-400 mt-1 leading-relaxed">{hint}</div>}
    </div>
  )
}
