'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { UploadSummary, AppointmentWithFeedback, CustomFieldDef, CustomFieldsBag, CustomInsight } from '@/types/database'

type UploadDetail = UploadSummary & {
  voicemails?: number | null
}

// Color-mappings blijven hardcoded (CSS classes), labels worden via t() opgehaald.
const OUTCOME_COLORS: Record<string, string> = {
  deal:      'badge-green',
  offerte:   'badge-blue',
  follow_up: 'badge-amber',
  verloren:  'badge-red',
  geen:      'badge-gray',
}

const STATUS_COLORS: Record<string, string> = {
  uitgevoerd: 'badge-green', no_show: 'badge-red', geannuleerd: 'badge-gray', gepland: 'badge-blue',
}

export default function UploadDetailPage() {
  const t = useTranslations('dashboard.upload.detail')
  const params = useParams()
  const router = useRouter()
  const [upload, setUpload] = useState<UploadDetail | null>(null)
  const [feedback, setFeedback] = useState<AppointmentWithFeedback[]>([])
  const [customDefs, setCustomDefs] = useState<CustomFieldDef[]>([])
  const [customRows, setCustomRows] = useState<CustomFieldsBag[]>([])
  const [customInsights, setCustomInsights] = useState<CustomInsight[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const supabase = createClient()

    const { data, error } = await supabase
      .from('upload_summary')
      .select('*')
      .eq('id', params.id as string)
      .single()

    if (error || !data) {
      setError(t('notFound'))
      setLoading(false)
      return
    }
    setUpload(data)

    // Haal feedback op voor afspraken uit deze upload — match via caller_id
    // (caller_name is fragiel: dubbele namen of name changes breken de match)
    const { data: fb } = await supabase
      .from('appointments_with_feedback')
      .select('*')
      .eq('project_id', data.project_id)
      .eq('caller_id', data.caller_id)

    setFeedback(fb ?? [])

    // Custom field definities ophalen (van het project) + de waardes per record
    const { data: proj } = await supabase
      .from('projects')
      .select('custom_field_definitions')
      .eq('id', data.project_id)
      .single()
    const defs = (proj as { custom_field_definitions?: CustomFieldDef[] } | null)?.custom_field_definitions ?? []
    setCustomDefs(defs)

    if (defs.length > 0) {
      const { data: cr } = await supabase
        .from('call_records')
        .select('custom_fields')
        .eq('upload_id', params.id as string)
      const rows = (cr ?? []).map(r =>
        (r as { custom_fields?: CustomFieldsBag }).custom_fields ?? {}
      )
      setCustomRows(rows)
    }

    // AI custom-insights ophalen uit analyses-tabel
    const { data: ana } = await supabase
      .from('analyses')
      .select('custom_insights')
      .eq('upload_id', params.id as string)
      .maybeSingle()
    const insights = (ana as { custom_insights?: CustomInsight[] } | null)?.custom_insights ?? []
    setCustomInsights(insights)

    setLoading(false)
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-sm text-gray-400">{t('loading')}</div>
  )
  if (error || !upload) return (
    <div className="card p-8 text-center text-sm text-gray-400">{error ?? t('notFound')}</div>
  )

  const reachRate = upload.total_calls > 0 ? Math.round(upload.reached / upload.total_calls * 100) : 0
  const convRate  = upload.reached > 0 ? Math.round(upload.appointments / upload.reached * 100) : 0
  const maxObj    = Math.max(...(upload.objections ?? []).map(o => o.count), 1)

  const toolLabel: Record<string, string> = {
    aircall: 'Aircall', hubspot: 'HubSpot', lemlist: 'Lemlist', ringover: 'Ringover', andere: 'Andere',
  }

  const feedbackWithData = feedback.filter(f => f.appointment_status && f.appointment_status !== 'gepland')
  const ratedFeedback = feedbackWithData.filter(f => f.quality_rating)
  const avgQuality = ratedFeedback.length > 0
    ? (ratedFeedback.reduce((s, f) => s + (f.quality_rating ?? 0), 0) / ratedFeedback.length).toFixed(1)
    : null

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 mb-3 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t('back')}
          </button>
          <h1 className="text-2xl font-semibold text-gray-900">{upload.filename}</h1>
          <div className="flex items-center gap-2 mt-1 text-sm text-gray-400">
            <span>{upload.project_name}</span>
            <span>·</span>
            <span>{toolLabel[upload.tool] ?? upload.tool}</span>
            <span>·</span>
            <span>{new Date(upload.uploaded_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
          </div>
        </div>
        <span className={`badge mt-1 ${
          upload.status === 'done' ? 'badge-green' :
          upload.status === 'processing' ? 'badge-amber' :
          upload.status === 'error' ? 'badge-red' : 'badge-gray'
        }`}>
          {upload.status === 'done' ? t('statusBadge.done')
            : upload.status === 'processing' ? t('statusBadge.processing')
            : upload.status === 'error' ? t('statusBadge.error')
            : t('statusBadge.pending')}
        </span>
      </div>

      {/* KPI's */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          { label: t('kpis.leadsContacted'), value: upload.total_calls,   sub: null,                                       color: 'text-gray-900' },
          { label: t('kpis.reached'),        value: upload.reached,        sub: `${reachRate}%`,                            color: 'text-gray-900' },
          { label: t('kpis.appointments'),   value: upload.appointments,   sub: `${convRate}% ${t('kpis.convSuffix')}`,     color: 'text-brand-700' },
          { label: t('kpis.callbacks'),      value: upload.callbacks,      sub: null,                                       color: 'text-gray-900' },
        ].map(kpi => (
          <div key={kpi.label} className="card p-4">
            <div className="text-xs text-gray-400 mb-1">{kpi.label}</div>
            <div className={`text-2xl font-semibold ${kpi.color}`}>{kpi.value}</div>
            {kpi.sub && <div className="text-xs text-gray-400 mt-0.5">{kpi.sub}</div>}
          </div>
        ))}
      </div>

      {/* Custom velden — projectspecifieke data */}
      {customDefs.length > 0 && customRows.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="text-sm font-medium text-gray-900 mb-4">{t('customFields.title')}</div>
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
                      <div className="text-sm text-gray-300 mt-1">{t('customFields.noData')}</div>
                    </div>
                  )
                }
                const sum = nums.reduce((s, n) => s + n, 0)
                const avg = sum / nums.length
                return (
                  <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">{def.label}</div>
                    <div className="text-2xl font-semibold text-gray-900">
                      {sum.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {t('customFields.avgPrefix')} {avg.toLocaleString(undefined, { maximumFractionDigits: 1 })} · {nums.length} {t('customFields.filledSuffix')}
                    </div>
                  </div>
                )
              }

              if (def.type === 'date') {
                const dates = values
                  .map(v => new Date(String(v)))
                  .filter(d => !Number.isNaN(d.getTime()))
                if (dates.length === 0) {
                  return (
                    <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                      <div className="text-xs text-gray-400">{def.label}</div>
                      <div className="text-sm text-gray-300 mt-1">{t('customFields.noData')}</div>
                    </div>
                  )
                }
                const earliest = new Date(Math.min(...dates.map(d => d.getTime())))
                const latest   = new Date(Math.max(...dates.map(d => d.getTime())))
                const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                return (
                  <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">{def.label}</div>
                    <div className="text-sm font-medium text-gray-900">
                      {fmt(earliest)} — {fmt(latest)}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {dates.length} {t('customFields.filledSuffix')}
                    </div>
                  </div>
                )
              }

              if (def.type === 'category') {
                // Top categorieën met telling
                const counts = new Map<string, number>()
                for (const v of values) {
                  const key = String(v)
                  counts.set(key, (counts.get(key) ?? 0) + 1)
                }
                const top = Array.from(counts.entries())
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                const total = values.length
                return (
                  <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-2">{def.label}</div>
                    {top.length === 0 ? (
                      <div className="text-sm text-gray-300">{t('customFields.noData')}</div>
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

              // text → toon aantal ingevulde + 1-2 voorbeelden
              const samples = values.slice(0, 2).map(String)
              return (
                <div key={def.key} className="border border-gray-100 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">{def.label}</div>
                  <div className="text-sm text-gray-700">
                    {values.length} {t('customFields.filledSuffix')}
                  </div>
                  {samples.length > 0 && (
                    <div className="text-xs text-gray-400 mt-1 italic truncate">
                      &quot;{samples.join('", "')}&quot;
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* AI inzichten over custom velden */}
      {customInsights.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-6 h-6 bg-brand-50 rounded-md flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.5 4.5l2 2M9.5 9.5l2 2M4.5 11.5l2-2M9.5 6.5l2-2" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-900">{t('customInsights.title')}</span>
            <span className="badge badge-blue ml-auto">{t('customInsights.badge')}</span>
          </div>
          <div className="space-y-3">
            {customInsights.map((insight, i) => {
              const labelsByKey = new Map(customDefs.map(d => [d.key, d.label]))
              const fieldLabels = insight.field_keys
                .map(k => labelsByKey.get(k) ?? k)
                .join(' + ')
              return (
                <div key={i} className="border-l-2 border-brand-300 pl-3 py-1">
                  <div className="flex items-baseline gap-2 mb-1">
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
      )}

      {/* AI Rapport */}
      {upload.rapport_text && (
        <div className="card p-5 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 bg-brand-50 rounded-md flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M3 4h10M3 8h10M3 12h6" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-900">{t('aiReport.title')}</span>
            <span className="badge badge-blue ml-auto">{t('aiReport.badge')}</span>
          </div>
          <p className="text-sm text-gray-600 leading-relaxed">{upload.rapport_text}</p>
        </div>
      )}

      {/* Bezwaren */}
      {upload.objections && upload.objections.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-6 h-6 bg-amber-50 rounded-md flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="#d97706" strokeWidth="1.5"/>
                <path d="M8 5v4M8 11v.5" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-900">{t('objections.title')}</span>
            <span className="text-xs text-gray-400 ml-auto">{t('objections.badge')}</span>
          </div>
          <div className="space-y-3">
            {upload.objections.map((obj, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-32 text-sm text-gray-600 flex-shrink-0">{obj.label}</div>
                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-amber-400" style={{ width: `${Math.round(obj.count / maxObj * 100)}%` }}/>
                </div>
                <div className="text-sm font-medium text-gray-700 w-6 text-right">{obj.count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Statusverdeling */}
      <div className="card p-5 mb-6">
        <div className="text-sm font-medium text-gray-900 mb-4">{t('statusDistribution.title')}</div>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: t('statusDistribution.appointments'), value: upload.appointments,                         color: 'bg-green-100 text-green-700' },
            { label: t('statusDistribution.callbacks'),    value: upload.callbacks,                             color: 'bg-blue-100 text-blue-700' },
            { label: t('statusDistribution.voicemails'),   value: upload.voicemails ?? 0,                       color: 'bg-gray-100 text-gray-600' },
            { label: t('statusDistribution.notReached'),   value: upload.total_calls - upload.reached,          color: 'bg-gray-100 text-gray-500' },
          ].map(s => (
            <div key={s.label} className="flex items-center justify-between p-3 rounded-lg bg-gray-50">
              <span className="text-sm text-gray-600">{s.label}</span>
              <span className={`badge ${s.color}`}>{s.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Feedback van sales reps */}
      {feedbackWithData.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-6 h-6 bg-purple-50 rounded-md flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="#9333ea" strokeWidth="1.5"/>
                <path d="M5 2V4M11 2V4M2 7H14" stroke="#9333ea" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-900">{t('feedback.title')}</span>
            {avgQuality && (
              <div className="ml-auto flex items-center gap-1.5">
                <div className="flex gap-0.5">
                  {[1,2,3,4,5].map(s => (
                    <div key={s} className={`w-2 h-2 rounded-full ${s <= Number(avgQuality) ? 'bg-amber-400' : 'bg-gray-200'}`}/>
                  ))}
                </div>
                <span className="text-xs text-gray-500">{t('feedback.avgPrefix')} {avgQuality}/5</span>
              </div>
            )}
          </div>

          <div className="space-y-3">
            {feedbackWithData.map((f, i) => (
              <div key={i} className="border border-gray-100 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium text-sm text-gray-900">{f.lead_name ?? t('feedback.unknownLead')}</div>
                  <div className="flex items-center gap-2">
                    {f.appointment_status && (
                      <span className={`badge ${STATUS_COLORS[f.appointment_status] ?? 'badge-gray'}`}>
                        {t(`statusLabels.${f.appointment_status}`)}
                      </span>
                    )}
                    {f.outcome && f.outcome !== 'geen' && (
                      <span className={`badge ${OUTCOME_COLORS[f.outcome] ?? 'badge-gray'}`}>
                        {t(`outcomeLabels.${f.outcome}`)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-xs text-gray-400">
                    {f.sales_rep_name && <span>{t('feedback.byPrefix')} {f.sales_rep_name}</span>}
                  </div>
                  {f.quality_rating != null && (
                    <div className="flex items-center gap-1">
                      <div className="flex gap-0.5">
                        {[1,2,3,4,5].map(s => (
                          <div key={s} className={`w-1.5 h-1.5 rounded-full ${s <= (f.quality_rating ?? 0) ? 'bg-amber-400' : 'bg-gray-200'}`}/>
                        ))}
                      </div>
                      <span className="text-xs text-gray-400">{f.quality_rating}/5</span>
                    </div>
                  )}
                </div>
                {f.sales_notes && (
                  <p className="text-xs text-gray-500 mt-2 italic">"{f.sales_notes}"</p>
                )}
              </div>
            ))}
          </div>

          {feedbackWithData.length < upload.appointments && (
            <p className="text-xs text-gray-400 mt-3">
              {t('feedback.awaitingMore', { count: upload.appointments - feedbackWithData.length })}
            </p>
          )}
        </div>
      )}

      {/* Geen feedback nog */}
      {upload.appointments > 0 && feedbackWithData.length === 0 && (
        <div className="card p-5 border-dashed">
          <div className="text-center">
            <div className="text-gray-200 mb-2">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className="mx-auto">
                <rect x="3" y="4" width="22" height="20" rx="3" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M9 3V6M19 3V6M3 11H25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <p className="text-sm text-gray-400">
              {t('feedback.awaitingAll', { count: upload.appointments })}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
