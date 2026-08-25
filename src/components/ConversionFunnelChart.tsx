'use client'

import { useTranslations } from 'next-intl'
import {
  FunnelChart, Funnel, LabelList, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'

interface Props {
  called:       number
  reached:      number
  appointments: number
  deals:        number
  /** Toont een titel bovenaan de kaart. Default = true. */
  showTitle?:   boolean
}

/**
 * Visuele conversie-funnel — trapezium-vorm die per stap smaller wordt.
 * Vervangt de eerdere "horizontale bars"-versie die alle stappen op
 * dezelfde breedte tekende (visueel misleidend).
 *
 * Kleuren volgen dezelfde semantische conventie als het oude blok:
 *   - Gebeld     — grijs (baseline, alle gebelde leads)
 *   - Bereikt    — lichtblauw (contact gemaakt)
 *   - Afspraken  — brand-blauw (conversie-stap)
 *   - Deals      — groen (win)
 *
 * Percentages zijn t.o.v. de vorige stap ("stapconversie") én t.o.v. het
 * totaal aantal gebelde leads. Zo zie je in één blik of de drop-off in
 * een specifieke stap zit.
 */
export default function ConversionFunnelChart({
  called, reached, appointments, deals,
  showTitle = true,
}: Props) {
  const t = useTranslations('dashboard.funnel')

  // Warme progressie: koel-blauw (rustige start, grote basis) → violet
  // (activering) → roze (klik-moment) → win-groen. Elk kleur is Tailwind's
  // 400-tint = vibrant maar niet schreeuwerig, en heeft genoeg contrast met
  // witte label-tekst.
  const funnelData = [
    { name: t('called'),       value: called,       fill: '#60a5fa' }, // blue-400
    { name: t('reached'),      value: reached,      fill: '#a78bfa' }, // violet-400
    { name: t('appointments'), value: appointments, fill: '#f472b6' }, // pink-400
    { name: t('deals'),        value: deals,        fill: '#34d399' }, // emerald-400
  ]

  // Percentages voor de zij-lijst
  const rows = [
    { label: t('called'),       count: called,       pctOfTotal: 100,
      pctOfPrev: null },
    { label: t('reached'),      count: reached,      pctOfTotal: called > 0 ? Math.round(reached / called * 100) : 0,
      pctOfPrev: called > 0 ? Math.round(reached / called * 100) : 0 },
    { label: t('appointments'), count: appointments, pctOfTotal: called > 0 ? Math.round(appointments / called * 100) : 0,
      pctOfPrev: reached > 0 ? Math.round(appointments / reached * 100) : 0 },
    { label: t('deals'),        count: deals,        pctOfTotal: called > 0 ? Math.round(deals / called * 100) : 0,
      pctOfPrev: appointments > 0 ? Math.round(deals / appointments * 100) : 0 },
  ]

  if (called === 0) {
    return (
      <div className="card p-6 mb-6 avoid-break">
        {showTitle && <div className="text-sm font-semibold text-gray-900 mb-4">{t('title')}</div>}
        <p className="text-sm text-gray-400 text-center py-8">{t('empty')}</p>
      </div>
    )
  }

  return (
    <div className="card p-6 mb-6 avoid-break">
      {showTitle && <div className="text-sm font-semibold text-gray-900 mb-4">{t('title')}</div>}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-center">
        {/* Trechter — 3 kolommen breed op desktop */}
        <div className="md:col-span-3 -mx-2">
          <ResponsiveContainer width="100%" height={260}>
            <FunnelChart>
              <Tooltip
                contentStyle={{ fontSize: 12, border: '0.5px solid #e5e7eb', borderRadius: 8, boxShadow: 'none' }}
                formatter={(value: number, name: string) => [value, name]}
              />
              <Funnel
                data={funnelData}
                dataKey="value"
                nameKey="name"
                isAnimationActive
                stroke="#fff"
                strokeWidth={2}
              >
                {funnelData.map((entry, index) => (
                  <Cell key={index} fill={entry.fill} />
                ))}
                <LabelList
                  position="right"
                  fill="#374151"
                  stroke="none"
                  dataKey="name"
                  fontSize={12}
                />
                <LabelList
                  position="center"
                  fill="#fff"
                  stroke="none"
                  dataKey="value"
                  fontSize={13}
                  fontWeight={600}
                />
              </Funnel>
            </FunnelChart>
          </ResponsiveContainer>
        </div>

        {/* Zij-lijst met counts + stapconversie */}
        <div className="md:col-span-2 space-y-3">
          {rows.map((r, i) => (
            <div key={r.label} className="flex items-baseline justify-between border-b border-gray-100 last:border-0 pb-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: funnelData[i].fill }}
                />
                <span className="text-sm text-gray-600">{r.label}</span>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-gray-900">{r.count.toLocaleString('nl-BE')}</div>
                <div className="text-xs text-gray-400">
                  {r.pctOfPrev !== null
                    ? t('stepConversion', { pct: r.pctOfPrev })
                    : t('totalBase')}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
