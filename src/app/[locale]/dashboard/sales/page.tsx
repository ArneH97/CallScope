'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { Profile, UploadSummary, AppointmentWithFeedback, Analysis } from '@/types/database'
import ProjectFilter from '@/components/ui/ProjectFilter'
import DateRangeFilter, { type DateRange, type DateFilterKind, isInRange } from '@/components/ui/DateRangeFilter'
import CostMetricsForProject from '@/components/CostMetricsForProject'
import DealsBreakdownCard from '@/components/DealsBreakdownCard'
import DealsPerMonthChart from '@/components/DealsPerMonthChart'
import ConversionFunnelChart from '@/components/ConversionFunnelChart'
import {
  Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  LineChart, Line, CartesianGrid, Legend, XAxis, YAxis,
} from 'recharts'
import {
  CHART_CALLER_COLORS, REACH_SUFFIX, computeCombinedTeamData, mondayOfDay,
  type ChartCallRow, type ChartConfRow, type ChartRateRow,
} from '@/lib/team-charts'

type AnalysisAgg = Pick<Analysis, 'upload_id' | 'objections' | 'total_calls' | 'reached' | 'appointments'>

type SalesTableCell = { v: number | string; l: string; c?: string }

interface ProjectStats {
  project_id: string
  project_name: string
  total_calls: number
  reached: number
  appointments: number
  callbacks: number
  deals: number
  offertes: number
  verloren: number
  follow_up: number
  no_shows: number
  avg_quality: number
  conversion_pct: number
  deal_rate: number
}

interface CallerStats {
  caller_name: string
  call_center_name: string
  project_id: string
  total_calls: number
  appointments: number
  avg_quality: number
  conversion_pct: number
}

const COLORS = ['#2d4fff', '#1D9E75', '#EF9F27', '#E24B4A', '#7F77DD']

export default function SalesManagerDashboard() {
  const t = useTranslations('dashboard.sales')
  // Hergebruik van de team-chart strings — zelfde chart-component op een
  // andere pagina hoeft niet z'n eigen kopie van titles/labels te onderhouden.
  const tChart = useTranslations('dashboard.team.teamChart')
  const locale = useLocale()
  const [projects, setProjects]       = useState<ProjectStats[]>([])
  const [allFeedback, setAllFeedback] = useState<AppointmentWithFeedback[]>([])
  const [allUploads, setAllUploads]   = useState<UploadSummary[]>([])
  const [allAnalyses, setAllAnalyses] = useState<AnalysisAgg[]>([])
  const [loading, setLoading]         = useState(true)
  const [selectedProject, setSelectedProject] = useState<string>('alle')
  const [dateRange, setDateRange]     = useState<DateRange>({ from: null, to: null })
  const [dateFilterKind, setDateFilterKind] = useState<DateFilterKind>('month')
  const [profile, setProfile]         = useState<Profile | null>(null)

  // Team-chart data (calls/u + bereikratio per caller per werkdag). Wordt
  // alleen gefetcht wanneer een specifiek project geselecteerd is — anders
  // is de chart sowieso verborgen.
  const [chartCallRows, setChartCallRows] = useState<ChartCallRow[]>([])
  const [chartConfRows, setChartConfRows] = useState<ChartConfRow[]>([])
  const [chartRateRows, setChartRateRows] = useState<ChartRateRow[]>([])
  const [teamChartMetric, setTeamChartMetric] = useState<'calls' | 'reach'>('calls')

  useEffect(() => { loadData() }, [])

  // Sales-dashboard toont altijd één specifiek project — een cross-project
  // overzicht is hier niet zinvol omdat KPIs, deal rates en uitkomsten
  // semantisch verschillen per project. Bij initial state ('alle') →
  // automatisch het eerste project kiezen, ongeacht hoeveel projecten
  // beschikbaar zijn. Gebruiker kan nog steeds via de filter switchen.
  useEffect(() => {
    if (selectedProject !== 'alle') return
    if (projects.length > 0) {
      setSelectedProject(projects[0].project_id)
    }
  }, [projects, selectedProject])

  async function loadData() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: p }        = await supabase.from('profiles').select('*').eq('id', user.id).single()
    const { data: uploads }  = await supabase.from('upload_summary').select('*').order('uploaded_at', { ascending: false })
    const { data: feedback } = await supabase.from('appointments_with_feedback').select('*')
    const { data: analyses } = await supabase.from('analyses').select('upload_id, objections, total_calls, reached, appointments')

    setProfile(p)
    setAllUploads(uploads ?? [])
    setAllFeedback(feedback ?? [])
    setAllAnalyses(analyses ?? [])

    // Project stats
    const projectMap = new Map<string, ProjectStats>()
    for (const u of (uploads ?? [])) {
      if (!u.project_id) continue
      if (!projectMap.has(u.project_id)) {
        projectMap.set(u.project_id, {
          project_id: u.project_id, project_name: u.project_name ?? 'Onbekend',
          total_calls: 0, reached: 0, appointments: 0, callbacks: 0,
          deals: 0, offertes: 0, verloren: 0, follow_up: 0, no_shows: 0,
          avg_quality: 0, conversion_pct: 0, deal_rate: 0,
        })
      }
      const ps = projectMap.get(u.project_id)!
      ps.total_calls  += u.total_calls  ?? 0
      ps.reached      += u.reached      ?? 0
      ps.appointments += u.appointments ?? 0
      ps.callbacks    += u.callbacks    ?? 0
    }
    for (const fb of (feedback ?? [])) {
      const ps = projectMap.get(fb.project_id)
      if (!ps) continue
      if (fb.outcome === 'deal')      ps.deals++
      if (fb.outcome === 'offerte')   ps.offertes++
      if (fb.outcome === 'verloren')  ps.verloren++
      if (fb.outcome === 'follow_up') ps.follow_up++
      if (fb.appointment_status === 'no_show') ps.no_shows++
    }
    for (const ps of Array.from(projectMap.values())) {
      ps.conversion_pct = ps.reached > 0 ? Math.round(ps.appointments / ps.reached * 100) : 0
      ps.deal_rate = ps.appointments > 0 ? Math.round(ps.deals / ps.appointments * 100) : 0
      const pFb = (feedback ?? []).filter(f => f.project_id === ps.project_id && f.quality_rating)
      ps.avg_quality = pFb.length > 0
        ? Math.round(pFb.reduce((s, f) => s + (f.quality_rating ?? 0), 0) / pFb.length * 10) / 10 : 0
    }
    setProjects(Array.from(projectMap.values()))
    setLoading(false)
  }

  // Team-chart data laden — alleen voor een specifiek project met actieve range.
  // Identieke fetch als op het team-dashboard zodat de chart consistent dezelfde
  // metrics rendert. Sales-managers krijgen zo per-caller calls/u + bereikratio
  // voor het project waar ze nu naar kijken.
  useEffect(() => {
    if (selectedProject === 'alle' || !dateRange.from || !dateRange.to) {
      setChartCallRows([])
      setChartConfRows([])
      setChartRateRows([])
      return
    }
    const sb = createClient()
    let cancelled = false

    ;(async () => {
      const fromDate = dateRange.from!.toISOString().slice(0, 10)
      const toDate   = dateRange.to!.toISOString().slice(0, 10)

      const { data: cr } = await sb
        .from('call_records')
        .select('call_date, status, uploads!inner(caller_id)')
        .eq('project_id', selectedProject)
        .gte('call_date', fromDate)
        .lte('call_date', toDate)
        .returns<{ call_date: string | null; status: string | null; uploads: { caller_id: string } | { caller_id: string }[] | null }[]>()

      const monFrom = mondayOfDay(dateRange.from!).toISOString().slice(0, 10)
      const monTo   = mondayOfDay(dateRange.to!).toISOString().slice(0, 10)
      const { data: conf } = await sb
        .from('weekly_hour_confirmations')
        .select('caller_id, week_start_date, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri')
        .eq('project_id', selectedProject)
        .gte('week_start_date', monFrom)
        .lte('week_start_date', monTo)

      const { data: rates } = await sb
        .from('project_caller_rates')
        .select('caller_id, weekly_hours_preset')
        .eq('project_id', selectedProject)

      if (cancelled) return

      const calls: ChartCallRow[] = (cr ?? [])
        .map(r => {
          const up = Array.isArray(r.uploads) ? r.uploads[0] : r.uploads
          if (!up?.caller_id || !r.call_date) return null
          return { caller_id: up.caller_id, call_date: r.call_date.slice(0, 10), status: r.status }
        })
        .filter((r): r is ChartCallRow => r !== null)

      setChartCallRows(calls)
      setChartConfRows((conf ?? []) as ChartConfRow[])
      setChartRateRows((rates ?? []) as ChartRateRow[])
    })()

    return () => { cancelled = true }
  }, [selectedProject, dateRange])

  // Gefilterde data — gebruikt nu een DateRange (from/to) i.p.v. één cutoff
  // zodat 'Deze maand' en 'Aangepast' (van-tot) ook ondersteund worden.
  const filteredFeedback = useMemo(() => {
    let data = selectedProject === 'alle' ? allFeedback : allFeedback.filter(f => f.project_id === selectedProject)
    if (dateRange.from || dateRange.to) {
      data = data.filter(f => f.call_date && isInRange(new Date(f.call_date), dateRange))
    }
    return data
  }, [allFeedback, selectedProject, dateRange])

  const filteredUploads = useMemo(() => {
    let data = selectedProject === 'alle' ? allUploads : allUploads.filter(u => u.project_id === selectedProject)
    if (dateRange.from || dateRange.to) {
      data = data.filter(u => isInRange(new Date(u.uploaded_at), dateRange))
    }
    return data
  }, [allUploads, selectedProject, dateRange])

  const activeProjects = useMemo(() =>
    selectedProject === 'alle' ? projects : projects.filter(p => p.project_id === selectedProject),
    [projects, selectedProject])

  // Totalen op basis van gefilterde uploads
  const totals = useMemo(() => filteredUploads.reduce((acc, u) => ({
    calls:        acc.calls        + (u.total_calls  ?? 0),
    reached:      acc.reached      + (u.reached      ?? 0),
    appointments: acc.appointments + (u.appointments ?? 0),
    deals:        acc.deals        + 0,
    no_shows:     acc.no_shows     + 0,
  }), { calls: 0, reached: 0, appointments: 0, deals: 0, no_shows: 0 }), [filteredUploads])

  // Tel deals/no-shows apart via feedback
  const feedbackTotals = useMemo(() => filteredFeedback.reduce((acc, fb) => ({
    deals:    acc.deals    + (fb.outcome === 'deal' ? 1 : 0),
    no_shows: acc.no_shows + (fb.appointment_status === 'no_show' ? 1 : 0),
  }), { deals: 0, no_shows: 0 }), [filteredFeedback])

  const reachRate  = totals.calls > 0 ? Math.round(totals.reached / totals.calls * 100) : 0
  const convRate   = totals.reached > 0 ? Math.round(totals.appointments / totals.reached * 100) : 0
  const dealRate   = totals.appointments > 0 ? Math.round(feedbackTotals.deals / totals.appointments * 100) : 0
  const noShowRate = totals.appointments > 0 ? Math.round(feedbackTotals.no_shows / totals.appointments * 100) : 0

  // Pie data met %
  const pieData = useMemo(() => {
    const counts: Record<string, number> = { Deal: 0, Offerte: 0, 'Follow-up': 0, Verloren: 0 }
    for (const fb of filteredFeedback) {
      if (fb.outcome === 'deal')      counts['Deal']++
      if (fb.outcome === 'offerte')   counts['Offerte']++
      if (fb.outcome === 'follow_up') counts['Follow-up']++
      if (fb.outcome === 'verloren')  counts['Verloren']++
    }
    const total = Object.values(counts).reduce((s, v) => s + v, 0)
    return Object.entries(counts)
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({ name, value, pct: total > 0 ? Math.round(value / total * 100) : 0 }))
  }, [filteredFeedback])

  // AI inzichten: aggregeer bezwaren uit alle analyses
  const aiInsights = useMemo(() => {
    const relevantUploadIds = new Set(filteredUploads.map(u => u.id))
    const objectionMap = new Map<string, number>()
    for (const a of allAnalyses) {
      if (!relevantUploadIds.has(a.upload_id)) continue
      for (const obj of (a.objections ?? [])) {
        objectionMap.set(obj.label, (objectionMap.get(obj.label) ?? 0) + obj.count)
      }
    }
    const total = Array.from(objectionMap.values()).reduce((s, v) => s + v, 0)
    return Array.from(objectionMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, count]) => ({ label, count, pct: total > 0 ? Math.round(count / total * 100) : 0 }))
  }, [allAnalyses, filteredUploads])

  // Caller stats
  const callerStats = useMemo((): CallerStats[] => {
    const callerMap = new Map<string, CallerStats>()
    for (const u of filteredUploads) {
      if (!u.caller_name) continue
      const key = `${u.caller_name}__${u.project_id}`
      if (!callerMap.has(key)) callerMap.set(key, {
        caller_name: u.caller_name, call_center_name: u.call_center_name ?? '',
        project_id: u.project_id, total_calls: 0, appointments: 0, avg_quality: 0, conversion_pct: 0,
      })
      const cs = callerMap.get(key)!
      cs.total_calls  += u.total_calls  ?? 0
      cs.appointments += u.appointments ?? 0
    }
    for (const [, cs] of Array.from(callerMap.entries())) {
      const cFb = filteredFeedback.filter(f => f.caller_name === cs.caller_name && f.quality_rating)
      cs.avg_quality = cFb.length > 0
        ? Math.round(cFb.reduce((s, f) => s + (f.quality_rating ?? 0), 0) / cFb.length * 10) / 10 : 0
      cs.conversion_pct = cs.total_calls > 0 ? Math.round(cs.appointments / cs.total_calls * 100) : 0
    }
    return Array.from(callerMap.values()).sort((a, b) => b.appointments - a.appointments)
  }, [filteredUploads, filteredFeedback])

  // Team-chart data: top 8 callers (op afspraken-volume) uit filteredUploads.
  // We groeperen per caller_id en pakken caller_name uit de eerste upload-rij
  // — bij multi-naam-aliassen voor dezelfde id pakken we gewoon de eerste.
  const teamChartData = useMemo(() => {
    if (selectedProject === 'alle' || !dateRange.from || !dateRange.to) return { rows: [], callers: [] }
    if (chartCallRows.length === 0 && chartConfRows.length === 0) return { rows: [], callers: [] }

    const callerMap = new Map<string, { name: string; appointments: number }>()
    for (const u of filteredUploads) {
      if (!u.caller_id) continue
      if (!callerMap.has(u.caller_id)) {
        callerMap.set(u.caller_id, { name: u.caller_name ?? 'Onbekend', appointments: 0 })
      }
      const c = callerMap.get(u.caller_id)!
      c.appointments += u.appointments ?? 0
    }
    const visibleCallers = Array.from(callerMap.entries())
      .sort((a, b) => b[1].appointments - a[1].appointments)
      .slice(0, 8)
      .map(([id, v], i) => ({
        id,
        name: v.name,
        color: CHART_CALLER_COLORS[i % CHART_CALLER_COLORS.length],
      }))

    return computeCombinedTeamData(
      chartCallRows, chartConfRows, chartRateRows,
      visibleCallers,
      dateRange.from, dateRange.to,
      locale === 'nl' ? 'nl-BE' : locale,
    )
  }, [selectedProject, dateRange, chartCallRows, chartConfRows, chartRateRows, filteredUploads, locale])

  // Forecast op basis van geselecteerde periode
  const forecastCalls        = 200
  const forecastAppointments = Math.round(forecastCalls * (reachRate / 100) * (convRate / 100))
  const forecastDeals        = Math.round(forecastAppointments * (dealRate / 100))
  // DateRangeFilter is in 2026-05-04 versimpeld naar { month | week | custom }.
  // De legacy labels (7d/30d/this_month/all) blijven in messages staan voor
  // backward-compat maar worden niet meer geëmit door de filter.
  const forecastLabel = (
    dateFilterKind === 'week'   ? t('forecast.labelWeek') :
    dateFilterKind === 'month'  ? t('forecast.labelThisMonth') :
    dateFilterKind === 'custom' ? t('forecast.labelCustom') :
                                  t('forecast.labelAll')
  )

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>

  return (
    <div className="max-w-5xl">
      {/* Header + filters */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            {t('greeting', { firstName: profile?.full_name?.split(' ')[0] ?? '' })}
            {selectedProject !== 'alle' && (
              <span className="text-gray-400 font-normal ml-2">
                — {projects.find(p => p.project_id === selectedProject)?.project_name}
              </span>
            )}
          </h1>
          <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Datumfilter — herbruikbare component met 7d / 30d / deze maand /
              alles / aangepast (custom from-to). */}
          <DateRangeFilter
            defaultKind="month"
            onChange={(range, kind) => {
              setDateRange(range)
              setDateFilterKind(kind)
            }}
          />
          {/* Projectfilter */}
          <ProjectFilter
            projects={projects.map(p => ({ id: p.project_id, name: p.project_name }))}
            value={selectedProject}
            onChange={setSelectedProject}
          />
        </div>
      </div>

      {/* KPI's */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          { label: t('kpis.leadsContacted'), value: totals.calls,        sub: null,                                                                       color: 'text-gray-900',   tip: t('kpis.leadsContactedTip') },
          { label: t('kpis.reachRate'),      value: `${reachRate}%`,     sub: `${totals.reached} ${t('kpis.reachedSuffix')}`,                              color: 'text-gray-900',   tip: t('kpis.reachRateTip') },
          { label: t('kpis.appointments'),   value: totals.appointments, sub: `${convRate}% ${t('kpis.convSuffix')}`,                                      color: 'text-brand-700',  tip: t('kpis.appointmentsTip') },
          { label: t('kpis.deals'),          value: feedbackTotals.deals, sub: dealRate > 0 ? `${dealRate}% ${t('kpis.ofAppointments')}` : t('kpis.noFeedbackYet'), color: 'text-green-700', tip: t('kpis.dealsTip') },
        ].map(kpi => (
          <div key={kpi.label} className="card p-4 group relative">
            <div className="text-xs text-gray-400 mb-1">{kpi.label}</div>
            <div className={`text-2xl font-semibold ${kpi.color}`}>{kpi.value}</div>
            {kpi.sub && <div className="text-xs text-gray-400 mt-0.5">{kpi.sub}</div>}
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
              {kpi.tip}
            </div>
          </div>
        ))}
      </div>

      {/* Conversie-funnel — trapezium-vorm met per-stap conversieratio's.
          Vervangt de oude horizontale-bars-versie. */}
      <ConversionFunnelChart
        called={totals.calls}
        reached={totals.reached}
        appointments={totals.appointments}
        deals={feedbackTotals.deals}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Pie met % — nu naast de conversie-funnel hierboven, dus
            neemt maximaal de helft van de breedte in. */}
        <div className="card p-5">
          <div className="text-sm font-medium text-gray-900 mb-1">{t('outcomes.title')}</div>
          {dealRate > 0 && (
            <div className="text-xs text-green-600 font-medium mb-3">{t('outcomes.dealRate', { rate: dealRate })}</div>
          )}
          {pieData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={38} outerRadius={60} paddingAngle={3} dataKey="value">
                    {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]}/>)}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12, border: '0.5px solid #e5e7eb', borderRadius: 8, boxShadow: 'none' }}/>
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-1.5 mt-2">
                {pieData.map((d, i) => (
                  <div key={d.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }}/>
                      <span className="text-gray-600">{d.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-900">{d.value}</span>
                      <span className="text-gray-400">({d.pct}%)</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-48 flex items-center justify-center text-sm text-gray-300">{t('outcomes.noFeedback')}</div>
          )}
        </div>
      </div>

      {/* Team-chart: calls/u of bereikratio per cold caller per werkdag.
          Zelfde component-pattern als op het team-dashboard (cc_manager). Pill-
          toggle rechtsboven om tussen de 2 metrics te switchen. Alleen tonen
          wanneer een specifiek project geselecteerd is. */}
      {selectedProject !== 'alle' && teamChartData.callers.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <div>
              <div className="text-sm font-medium text-gray-900">
                {teamChartMetric === 'calls' ? tChart('titleCalls') : tChart('titleReach')}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {teamChartMetric === 'calls' ? tChart('subtitleCalls') : tChart('subtitleReach')}
              </p>
            </div>
            <div className="inline-flex gap-0.5 bg-gray-100 p-0.5 rounded-md">
              <button
                onClick={() => setTeamChartMetric('calls')}
                className={`text-xs px-2.5 py-1 rounded transition-colors ${
                  teamChartMetric === 'calls'
                    ? 'bg-white text-gray-900 font-medium shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tChart('toggleCalls')}
              </button>
              <button
                onClick={() => setTeamChartMetric('reach')}
                className={`text-xs px-2.5 py-1 rounded transition-colors ${
                  teamChartMetric === 'reach'
                    ? 'bg-white text-gray-900 font-medium shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tChart('toggleReach')}
              </button>
            </div>
          </div>
          <div className="mt-4">
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={teamChartData.rows} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6"/>
                <XAxis
                  dataKey="dateLabel"
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                  interval={teamChartData.rows.length > 10 ? 'preserveStartEnd' : 0}
                />
                <YAxis
                  domain={teamChartMetric === 'reach' ? [0, 100] : ['auto', 'auto']}
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                  unit={teamChartMetric === 'reach' ? '%' : ''}
                  label={{
                    value: teamChartMetric === 'calls' ? tChart('yAxisLeft') : tChart('yAxisRight'),
                    angle: -90, position: 'insideLeft',
                    style: { fontSize: 10, fill: '#9ca3af', textAnchor: 'middle' },
                  }}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, border: '0.5px solid #e5e7eb', borderRadius: 8, boxShadow: 'none' }}
                  formatter={(value: number) => [
                    teamChartMetric === 'reach' ? `${value}%` : `${value} ${tChart('unitCallsPerHour')}`,
                    '',
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="line"/>
                {teamChartData.callers.map(cl => (
                  <Line
                    key={cl.id}
                    type="monotone"
                    dataKey={teamChartMetric === 'reach' ? cl.id + REACH_SUFFIX : cl.id}
                    name={cl.name}
                    stroke={cl.color}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-gray-400 mt-2">{tChart('footer')}</p>
        </div>
      )}

      {/* AI Inzichten — bezwaren */}
      {aiInsights.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-6 h-6 bg-amber-50 rounded-md flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="#d97706" strokeWidth="1.5"/>
                <path d="M8 5v4M8 11v.5" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-900">{t('aiInsights.title')}</span>
            <span className="badge badge-amber ml-auto">{t('aiInsights.badge')}</span>
          </div>
          <div className="space-y-2.5">
            {aiInsights.map((obj, i) => (
              <div key={obj.label} className="flex items-center gap-3">
                <div className="w-28 text-sm text-gray-600 flex-shrink-0">{obj.label}</div>
                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-amber-400 transition-all duration-500"
                    style={{ width: `${obj.pct}%` }}
                  />
                </div>
                <div className="text-xs font-medium text-gray-700 w-10 text-right">{obj.pct}%</div>
                <div className="text-xs text-gray-400 w-12 text-right">{obj.count}x</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">
            {t('aiInsights.footer', { count: filteredUploads.length })}
          </p>
        </div>
      )}

      {/* Forecast */}
      <div className="card p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-6 h-6 bg-brand-50 rounded-md flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M2 12L6 8L9 11L14 4" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="text-sm font-medium text-gray-900">{t('forecast.title')}</span>
          <span className="badge badge-blue ml-auto">{t('forecast.basedOn', { label: forecastLabel })}</span>
        </div>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: t('forecast.expectedLeads'),         value: forecastCalls,        sub: t('forecast.expectedLeadsSub') },
            { label: t('forecast.expectedAppointments'),  value: forecastAppointments, sub: t('forecast.expectedAppointmentsSub', { rate: convRate }) },
            { label: t('forecast.expectedDeals'),         value: forecastDeals,        sub: dealRate > 0 ? t('forecast.expectedDealsSub', { rate: dealRate }) : t('forecast.expectedDealsNoData') },
          ].map(f => (
            <div key={f.label} className="bg-brand-50 rounded-xl p-4">
              <div className="text-xs text-brand-600 mb-1">{f.label}</div>
              <div className="text-2xl font-semibold text-brand-700">{f.value}</div>
              <div className="text-xs text-brand-400 mt-0.5">{f.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* No-show */}
      {noShowRate > 0 && (
        <div className={`card p-4 mb-6 flex items-center gap-3 ${noShowRate > 20 ? 'border-red-100 bg-red-50' : 'border-amber-100 bg-amber-50'}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke={noShowRate > 20 ? '#dc2626' : '#d97706'} strokeWidth="1.5"/>
            <path d="M8 5v4M8 11v.5" stroke={noShowRate > 20 ? '#dc2626' : '#d97706'} strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <p className="text-sm">
            <span className={`font-medium ${noShowRate > 20 ? 'text-red-700' : 'text-amber-700'}`}>{t('noShow.rateLabel', { rate: noShowRate })} </span>
            <span className={noShowRate > 20 ? 'text-red-600' : 'text-amber-600'}>
              {noShowRate > 20 ? t('noShow.highHint') : t('noShow.lowHint')}
            </span>
          </p>
        </div>
      )}

      {/* Caller performantie */}
      {callerStats.length > 0 && (
        <div className="card p-5">
          <div className="text-sm font-medium text-gray-900 mb-4">{t('callers.title')}</div>
          <div className="space-y-2">
            {callerStats.map((c, i) => (
              <div key={`${c.caller_name}-${i}`} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0 ${i === 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">{c.caller_name}</div>
                  <div className="text-xs text-gray-400">{c.call_center_name}</div>
                </div>
                <div className="flex gap-5 text-sm flex-shrink-0">
                  {([
                    { v: c.total_calls,          l: t('callers.leads') },
                    { v: c.appointments,          l: t('callers.appointments'), c: 'text-brand-700' },
                    { v: `${c.conversion_pct}%`,  l: t('callers.conv') },
                  ] as SalesTableCell[]).map(s => (
                    <div key={s.l} className="text-center">
                      <div className={`font-medium ${s.c ?? 'text-gray-900'}`}>{s.v}</div>
                      <div className="text-xs text-gray-400">{s.l}</div>
                    </div>
                  ))}
                  {c.avg_quality > 0 && (
                    <div className="text-center">
                      <div className="flex gap-0.5 justify-center">
                        {[1,2,3,4,5].map(s => <div key={s} className={`w-1.5 h-1.5 rounded-full ${s <= c.avg_quality ? 'bg-amber-400' : 'bg-gray-200'}`}/>)}
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">{c.avg_quality}/5</div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dealstages breakdown = periode-scoped (volgt de datum-filter).
          Deals per maand = altijd het volledige kalenderjaar — bewust los
          van de datum-filter, om trends over het jaar heen te tonen. */}
      <DealsBreakdownCard feedback={filteredFeedback} />
      <DealsPerMonthChart feedback={
        selectedProject === 'alle'
          ? allFeedback
          : allFeedback.filter(f => f.project_id === selectedProject)
      } />

      {/* Tijd & kost-metrics — alleen wanneer één specifiek project is gefilterd
          en het project tarieven heeft ingesteld. Anders rendert de component
          zichzelf niet. Bij "alle" sturen we een sentinel-datum die door de
          helper geclampt wordt naar project.created_at. */}
      {/* Wacht op dateRange voor we fetchen — voorkomt race tussen een
          eerste all-time-fetch (sentinel) en de echte maand-fetch. */}
      {selectedProject !== 'alle' && dateRange.from && dateRange.to && (
        <div className="mt-5">
          <CostMetricsForProject
            projectId={selectedProject}
            fromIso={dateRange.from.toISOString()}
            toIso={dateRange.to.toISOString()}
          />
        </div>
      )}

      {projects.length === 0 && (
        <div className="card p-8 sm:p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-brand-50 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path d="M3 3v18h18M9 17V9m4 8V5m4 12v-7" stroke="#1a35e6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h3 className="text-base font-semibold text-gray-900 mb-1.5">{t('emptyState.title')}</h3>
          <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">{t('emptyState.body')}</p>
        </div>
      )}
    </div>
  )
}
