'use client'

import { useTranslations } from 'next-intl'

interface Props {
  /** Raw status-waarden uit call_records.status voor deze periode. */
  statuses: (string | null)[]
  /** Compact = kleinere card voor per-caller secties. */
  compact?: boolean
}

/**
 * Toont hoe vaak elke waarde uit call_records.status voorkomt in de gegeven
 * set — bv. voicemail, geen interesse, terugbellen, mail, ... Dit is de
 * RUWE dispositie zoals ingevuld in de "Reactie" kolom van de sheet, los
 * van de AI-bezwaren-analyse (die duidt/classificeert).
 *
 * Nut: complementair aan AI-bezwaren. Als je pipeline veel voicemails
 * bevat weet je meteen dat de "bezwaren" mss gewoon "we hebben niemand
 * echt aan de lijn gekregen" is. Ook zie je hoeveel écht "geen interesse"-
 * calls er waren, wat direct actionable is voor caller-coaching.
 *
 * Normalisatie: whitespace trim + hoofdletter-eerste zodat "voicemail",
 * "Voicemail", " VOICEMAIL " als één rij verschijnen.
 */
export default function StatusBreakdownCard({ statuses, compact = false }: Props) {
  const t = useTranslations('dashboard.projects.report.statusBreakdown')

  const counts = new Map<string, number>()
  let total = 0
  for (const raw of statuses) {
    const s = (raw ?? '').trim()
    if (!s) continue
    const key = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
    total++
  }

  if (total === 0) return null

  const rows = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, compact ? 6 : 12)
    .map(([label, count]) => ({
      label, count,
      pct: Math.round(count / total * 100),
    }))

  return (
    <div className={`card ${compact ? 'p-4' : 'p-5'} mb-4 avoid-break`}>
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">{t('title')}</div>
          <p className="text-xs text-gray-500 mt-0.5">{t('subtitle')}</p>
        </div>
        <div className="text-xs text-gray-400 flex-shrink-0">
          {t('totalHint', { count: total })}
        </div>
      </div>
      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-700 truncate flex-1">{r.label}</span>
            <div className="flex items-center gap-2 w-44 flex-shrink-0">
              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-brand-400" style={{ width: `${r.pct}%` }}/>
              </div>
              <span className="text-xs text-gray-500 w-8 text-right">{r.pct}%</span>
              <span className="text-xs text-gray-400 w-10 text-right">{r.count}×</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
