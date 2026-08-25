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
import type { SimulatorAssumptions } from '@/lib/simulator'

/** Bouwt de period_key waaronder annotations + simulator-aannames worden
    bewaard. Zo krijgt "juli 2026" andere notities dan "aug 2026". */
function buildPeriodKey(period: ReportPeriod, from: string, to: string): string {
  if (period === 'month')  return `month:${from.slice(0, 7)}`   // "month:2026-07"
  if (period === 'week')   return `week:${from}`                // "week:2026-07-06"
  return `custom:${from}_${to}`                                 // "custom:2026-07-01_2026-07-31"
}

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
    .select('id, name, description, created_at, custom_field_definitions, sim_no_show_rate, sim_closing_rate, sim_arr_per_deal, sim_enabled')
    .eq('id', projectId)
    .single()
  const project = projectData as {
    id: string
    name: string
    description: string | null
    created_at: string
    custom_field_definitions: CustomFieldDef[] | null
    sim_no_show_rate: number
    sim_closing_rate: number
    sim_arr_per_deal: number
    sim_enabled:      boolean
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

  // Per-caller data — voor de aparte secties. We groeperen uploads + feedback
  // op caller_id/caller_name en tonen straks één sectie per caller die in de
  // periode actief was. Alfabetisch gesorteerd (of op afspraken) — keuze:
  // op deals descending, zodat top-performer bovenaan komt.
  const uploads  = uploadsData  ?? []
  const feedback = feedbackData ?? []
  type CallerBucket = {
    caller_id:   string
    caller_name: string
    uploads:     UploadSummary[]
    feedback:    AppointmentWithFeedback[]
  }
  const callerBuckets = new Map<string, CallerBucket>()
  for (const u of uploads) {
    if (!u.caller_id && !u.caller_name) continue
    const key = u.caller_id ?? u.caller_name!
    if (!callerBuckets.has(key)) {
      callerBuckets.set(key, {
        caller_id: key, caller_name: u.caller_name ?? 'Onbekend',
        uploads: [], feedback: [],
      })
    }
    callerBuckets.get(key)!.uploads.push(u)
  }
  for (const f of feedback) {
    if (!f.caller_id && !f.caller_name) continue
    const key = f.caller_id ?? f.caller_name!
    if (!callerBuckets.has(key)) {
      callerBuckets.set(key, {
        caller_id: key, caller_name: f.caller_name ?? 'Onbekend',
        uploads: [], feedback: [],
      })
    }
    callerBuckets.get(key)!.feedback.push(f)
  }
  const perCaller = Array.from(callerBuckets.values())
    .sort((a, b) => b.feedback.length - a.feedback.length)

  // Annotations + simulator-aannames + period key
  const periodKey = buildPeriodKey(period, periodFromDate, periodToDate)
  const { data: annotationRows } = await supabase
    .from('report_annotations')
    .select('section_key, text')
    .eq('project_id', projectId)
    .eq('period_key', periodKey)
  const annotations = new Map<string, string>()
  for (const r of ((annotationRows ?? []) as { section_key: string; text: string }[])) {
    annotations.set(r.section_key, r.text)
  }

  const simAssumptions: SimulatorAssumptions = {
    no_show_rate: Number(project.sim_no_show_rate),
    closing_rate: Number(project.sim_closing_rate),
    arr_per_deal: Number(project.sim_arr_per_deal),
  }

  // Simulator input-cijfers uit de al gefetchte feedback + costMetrics.
  const dealsRealized = feedback.filter(f =>
    f.outcome === 'deal' || (f.dealstage_category ?? '').toLowerCase() === 'won'
  ).length
  const lostOrNoShow = feedback.filter(f =>
    f.outcome === 'verloren'
    || (f.dealstage_category ?? '').toLowerCase() === 'lost'
    || f.appointment_status === 'no_show'
  ).length
  const appointmentsTotal = feedback.length

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
        uploads={uploads}
        feedback={feedback}
        yearFeedback={yearFeedbackData ?? []}
        customDefs={customDefs}
        customRows={customRows}
        customInsights={customInsights}
        period={period}
        periodRangeLabel={periodRangeLabel}
        periodKey={periodKey}
        annotations={annotations}
        perCaller={perCaller}
        simulator={{
          enabled:            project.sim_enabled,
          assumptions:        simAssumptions,
          appointmentsTotal,
          dealsRealized,
          lostOrNoShow,
          costTotal:          costMetrics?.total_cost ?? null,
          currency:           costMetrics?.currency ?? 'EUR',
        }}
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
