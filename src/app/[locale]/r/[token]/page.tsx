import { notFound } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { createServiceClient } from '@/lib/supabase/server'
import ReportView from '@/components/report/ReportView'
import {
  parseReportPeriod, getReportPeriodWindow, formatPeriodRange,
  type ReportPeriod,
} from '@/lib/report-period'
import type {
  UploadSummary,
  AppointmentWithFeedback,
  CustomFieldDef,
  CustomFieldsBag,
  CustomInsight,
} from '@/types/database'

/**
 * Publieke share-route: /r/[token]
 * Geen auth nodig — de geldigheid van de token wordt gecheckt en de service-
 * role client wordt gebruikt om RLS te omzeilen voor de gefilterde data.
 */
export default async function SharedReportPage({
  params,
  searchParams,
}: {
  params:       { token: string }
  searchParams: { period?: string }
}) {
  const supabase = createServiceClient()
  const t = await getTranslations('dashboard.projects.report.share')

  // Periode komt mee via ?period= in de share-link. Default = month.
  const period: ReportPeriod = parseReportPeriod(searchParams.period)
  const { fromIso, toIso }   = getReportPeriodWindow(period)
  const locale               = await getLocale()
  const bcp47                = locale === 'nl' ? 'nl-BE' : locale
  const periodRangeLabel     = formatPeriodRange(period, bcp47)
  const fromDate             = fromIso.slice(0, 10)
  const toDate               = toIso.slice(0, 10)

  // Token opzoeken
  const { data: shareData } = await supabase
    .from('report_shares')
    .select('id, project_id, expires_at, view_count, sent_to, client_name, created_by')
    .eq('token', params.token)
    .maybeSingle()
  const share = shareData as {
    id: string
    project_id: string
    expires_at: string
    view_count: number | null
    sent_to: string | null
    client_name: string | null
    created_by: string
  } | null

  if (!share) notFound()

  // Expiry check
  if (new Date(share.expires_at).getTime() < Date.now()) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="card p-8 max-w-md text-center">
          <div className="text-3xl mb-3">⏱</div>
          <h1 className="text-lg font-semibold text-gray-900 mb-2">{t('expired.title')}</h1>
          <p className="text-sm text-gray-500">
            {t('expired.body')}
          </p>
        </div>
      </div>
    )
  }

  // View tellen (fire-and-forget)
  void supabase
    .from('report_shares')
    .update({
      view_count: (share.view_count ?? 0) + 1,
      viewed_at: share.view_count === 0 ? new Date().toISOString() : undefined,
    })
    .eq('id', share.id)

  // Project + data ophalen
  const { data: projectData } = await supabase
    .from('projects')
    .select('id, name, description, created_at, custom_field_definitions')
    .eq('id', share.project_id)
    .single()
  const project = projectData as {
    id: string
    name: string
    description: string | null
    created_at: string
    custom_field_definitions: CustomFieldDef[] | null
  } | null

  if (!project) notFound()

  const { data: uploadsData } = await supabase
    .from('upload_summary')
    .select('*')
    .eq('project_id', share.project_id)
    .gte('uploaded_at', fromIso)
    .lte('uploaded_at', toIso)
    .order('uploaded_at', { ascending: false })
    .returns<UploadSummary[]>()

  const { data: feedbackData } = await supabase
    .from('appointments_with_feedback')
    .select('*')
    .eq('project_id', share.project_id)
    .gte('call_date', fromDate)
    .lte('call_date', toDate)
    .returns<AppointmentWithFeedback[]>()

  // Extra: hele-jaar-feedback voor de "Deals per maand"-grafiek. Los van
  // de periode-filter zodat de klant het volledige jaar in één oogopslag ziet.
  const yearStart = `${new Date().getUTCFullYear()}-01-01`
  const yearEnd   = `${new Date().getUTCFullYear()}-12-31`
  const { data: yearFeedbackData } = await supabase
    .from('appointments_with_feedback')
    .select('call_date, dealstage_category, outcome, appointment_status')
    .eq('project_id', share.project_id)
    .gte('call_date', yearStart)
    .lte('call_date', yearEnd)
    .returns<AppointmentWithFeedback[]>()

  // Custom field data — alleen als het project er definities voor heeft
  const customDefs = project.custom_field_definitions ?? []
  let customRows: CustomFieldsBag[] = []
  let customInsights: CustomInsight[] = []
  if (customDefs.length > 0) {
    const { data: cr } = await supabase
      .from('call_records')
      .select('custom_fields')
      .eq('project_id', share.project_id)
      .gte('call_date', fromDate)
      .lte('call_date', toDate)
    customRows = (cr ?? []).map(r =>
      (r as { custom_fields?: CustomFieldsBag }).custom_fields ?? {}
    )

    const uploadIds = (uploadsData ?? []).map(u => u.id)
    if (uploadIds.length > 0) {
      const { data: ana } = await supabase
        .from('analyses')
        .select('custom_insights')
        .in('upload_id', uploadIds)
      customInsights = (ana ?? []).flatMap(a =>
        ((a as { custom_insights?: CustomInsight[] }).custom_insights ?? [])
      )
    }
  }

  // Manager-naam (afzender) voor de cover
  const { data: managerData } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', share.created_by)
    .single()
  const manager = managerData as { full_name: string | null } | null

  const generatedNote = manager?.full_name
    ? t('sharedBy', { name: manager.full_name })
    : t('sharedViaCallScope')

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header strip — alleen op scherm */}
        <div className="no-print mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="5.5" stroke="white" strokeWidth="1.5"/>
              <path d="M8 3v2M8 11v2M3 8h2M11 8h2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="8" cy="8" r="1.4" fill="white"/>
              </svg>
            </div>
            <span className="font-semibold text-sm tracking-tight text-gray-900">CallScope</span>
          </div>
          <a
            href="javascript:window.print()"
            className="btn-secondary text-xs inline-flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 12v2h12v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            {t('downloadPdf')}
          </a>
        </div>

        <ReportView
          project={project}
          uploads={uploadsData ?? []}
          feedback={feedbackData ?? []}
          yearFeedback={yearFeedbackData ?? []}
          generatedNote={generatedNote}
          customDefs={customDefs}
          customRows={customRows}
          customInsights={customInsights}
          period={period}
          periodRangeLabel={periodRangeLabel}
        />
      </div>
    </div>
  )
}
