import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import ReportActions from '@/components/report/ReportActions'
import ReportView from '@/components/report/ReportView'
import CostMetricsCard from '@/components/CostMetricsCard'
import { calcProjectCostMetrics } from '@/lib/cost-metrics'
import {
  parseReportPeriod, getReportPeriodWindow, formatPeriodRange,
  type ReportPeriod,
} from '@/lib/report-period'
import { getLocale } from 'next-intl/server'
import type {
  UploadSummary,
  AppointmentWithFeedback,
  CustomFieldDef,
  CustomFieldsBag,
  CustomInsight,
} from '@/types/database'

export default async function ProjectReportPage({
  params,
  searchParams,
}: {
  params:       { id: string }
  searchParams: { period?: string; from?: string; to?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const projectId = params.id

  // Periode: ?period=week|month|custom. Voor custom: ook ?from=YYYY-MM-DD
  // en ?to=YYYY-MM-DD nodig. Default = month.
  const period: ReportPeriod = parseReportPeriod(searchParams.period)
  const customFrom           = searchParams.from ?? null
  const customTo             = searchParams.to   ?? null
  const { fromIso, toIso, fromDate: periodFromDate, toDate: periodToDate }
                             = getReportPeriodWindow(period, customFrom, customTo)
  const locale               = await getLocale()
  const bcp47                = locale === 'nl' ? 'nl-BE' : locale
  const periodRangeLabel     = formatPeriodRange(period, bcp47, customFrom, customTo)

  const { data: projectData } = await supabase
    .from('projects')
    .select('id, name, description, created_at, custom_field_definitions')
    .eq('id', projectId)
    .single()
  const project = projectData as {
    id: string
    name: string
    description: string | null
    created_at: string
    custom_field_definitions: CustomFieldDef[] | null
  } | null

  if (!project) notFound()

  // Uploads & feedback gefilterd op het period window. Uploads filteren we op
  // uploaded_at; appointments-feedback op call_date (= dag waarop de afspraak
  // gemaakt werd via call_records).
  const { data: uploadsData } = await supabase
    .from('upload_summary')
    .select('*')
    .eq('project_id', projectId)
    .gte('uploaded_at', fromIso)
    .lte('uploaded_at', toIso)
    .order('uploaded_at', { ascending: false })
    .returns<UploadSummary[]>()

  const fromDate = fromIso.slice(0, 10)
  const toDate   = toIso.slice(0, 10)
  const { data: feedbackData } = await supabase
    .from('appointments_with_feedback')
    .select('*')
    .eq('project_id', projectId)
    .gte('call_date', fromDate)
    .lte('call_date', toDate)
    .returns<AppointmentWithFeedback[]>()

  // Aparte query voor de "Deals per maand"-grafiek — die toont bewust het
  // volledige kalenderjaar, los van de periode-filter. Zonder deze extra
  // fetch zou de grafiek enkel de rapport-periode-maand tonen.
  const yearStart = `${new Date().getUTCFullYear()}-01-01`
  const yearEnd   = `${new Date().getUTCFullYear()}-12-31`
  const { data: yearFeedbackData } = await supabase
    .from('appointments_with_feedback')
    .select('call_date, dealstage_category, outcome, appointment_status')
    .eq('project_id', projectId)
    .gte('call_date', yearStart)
    .lte('call_date', yearEnd)
    .returns<AppointmentWithFeedback[]>()

  // Custom fields data — alleen ophalen als er definities zijn op het project
  const customDefs = project.custom_field_definitions ?? []
  let customRows: CustomFieldsBag[] = []
  let customInsights: CustomInsight[] = []

  if (customDefs.length > 0) {
    // Beperk call_records lookup ook op de period window via call_date
    const { data: cr } = await supabase
      .from('call_records')
      .select('custom_fields')
      .eq('project_id', projectId)
      .gte('call_date', fromDate)
      .lte('call_date', toDate)
    customRows = (cr ?? []).map(r =>
      (r as { custom_fields?: CustomFieldsBag }).custom_fields ?? {}
    )

    // AI insights van de uploads die in de window vallen
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

  // Kost-metrics — synchroniseert nu met dezelfde periode als de rest van
  // het rapport, niet meer hardcoded 30 dagen. Returnt null als project geen
  // tarieven heeft (dan rendert de card zichzelf niet).
  const costMetrics = await calcProjectCostMetrics(projectId, periodFromDate, periodToDate)

  return (
    <div className="max-w-4xl mx-auto">
      <ReportActions
        projectId={projectId}
        projectName={project.name}
        period={period}
        customFrom={customFrom}
        customTo={customTo}
      />
      <ReportView
        project={project}
        uploads={uploadsData ?? []}
        feedback={feedbackData ?? []}
        yearFeedback={yearFeedbackData ?? []}
        customDefs={customDefs}
        customRows={customRows}
        customInsights={customInsights}
        period={period}
        periodRangeLabel={periodRangeLabel}
      />
      {/* Kost-metrics — alleen als tarieven ingesteld zijn op het project */}
      {costMetrics && (
        <div className="mt-6">
          <CostMetricsCard metrics={costMetrics} />
        </div>
      )}
    </div>
  )
}
