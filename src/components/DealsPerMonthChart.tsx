'use client'

import { useMemo } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import {
  computeDealsPerMonth,
  DEAL_STAGE_ORDER,
  DEAL_STAGE_COLORS,
  type FeedbackRow,
} from '@/lib/deals-charts'

interface Props {
  feedback: FeedbackRow[]
}

/**
 * Stacked bar chart — één bar per maand met de verdeling per dealstage
 * gestapeld erop. Zo zie je meteen zowel het totaal (bar-hoogte) als de
 * kwaliteit van de pipeline (kleuren binnen de bar).
 *
 * Als er minder dan 2 maanden data zijn, rendert de grafiek zichzelf niet
 * (parent-check op de wrapper).
 */
export default function DealsPerMonthChart({ feedback }: Props) {
  const t      = useTranslations('dashboard.deals.perMonth')
  const locale = useLocale()
  const bcp47  = locale === 'nl' ? 'nl-BE' : locale

  // Huidig kalenderjaar in Brussel-tijd zodat we niet in de val trappen
  // van UTC-server die na middernacht nog een oud jaar aangeeft.
  const currentYear = useMemo(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Brussels',
      year:     'numeric',
    }).formatToParts(new Date())
    return Number(parts.find(p => p.type === 'year')?.value ?? new Date().getUTCFullYear())
  }, [])

  const rows = useMemo(
    () => computeDealsPerMonth(feedback, bcp47, { fillYear: currentYear }),
    [feedback, bcp47, currentYear],
  )

  // Verberg als er nog geen data is voor het volledige jaar — mag niet
  // gebeuren want fillYear zorgt voor 12 lege rijen, maar defensieve check.
  if (rows.length === 0) return null

  return (
    <div className="card p-5 mb-6 avoid-break">
      <div className="mb-4">
        <div className="text-sm font-medium text-gray-900">{t('title', { year: currentYear })}</div>
        <div className="text-xs text-gray-500 mt-0.5">{t('subtitle')}</div>
      </div>
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis
              dataKey="monthLabel"
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              axisLine={false}
              tickLine={false}
              width={36}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                fontSize:     12,
                border:       '0.5px solid #e5e7eb',
                borderRadius: 8,
                boxShadow:    'none',
              }}
              formatter={(value: number, name: string) => [value, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="square" />
            {DEAL_STAGE_ORDER.map(bucket => (
              <Bar
                key={bucket}
                dataKey={bucket}
                stackId="a"
                name={t(`labels.${bucket}`)}
                fill={DEAL_STAGE_COLORS[bucket]}
                radius={bucket === 'other' ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
