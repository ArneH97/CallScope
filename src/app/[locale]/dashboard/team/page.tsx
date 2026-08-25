'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Link } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'
import type {
  Profile, CallCenter, UploadSummary, AppointmentWithFeedback,
  AppointmentFeedback, Analysis, CustomFieldDef, CustomFieldsBag, CustomInsight,
} from '@/types/database'
import ProjectFilter from '@/components/ui/ProjectFilter'
import DateRangeFilter, { type DateRange, type DateFilterKind, isInRange } from '@/components/ui/DateRangeFilter'
import CostMetricsForProject from '@/components/CostMetricsForProject'
import CoachingBlock from '@/components/CoachingBlock'
import DealsBreakdownCard from '@/components/DealsBreakdownCard'
import DealsPerMonthChart from '@/components/DealsPerMonthChart'
import ConversionFunnelChart from '@/components/ConversionFunnelChart'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, CartesianGrid, Legend,
} from 'recharts'
import {
  CHART_CALLER_COLORS, REACH_SUFFIX, APPT_SUFFIX, computeCombinedTeamData,
  mondayOfDay, isoDay,
} from '@/lib/team-charts'

/** Status-strings die we als "afspraak" beschouwen (zelfde als upload_summary view). */
const APPOINTMENT_RE = /afspraak|appointment/i

type DirectFeedback = Pick<AppointmentFeedback, 'outcome' | 'appointment_status' | 'call_record_id'>
type AnalysisAgg = Pick<Analysis, 'upload_id' | 'objections' | 'total_calls' | 'reached' | 'appointments'>

interface CallerStats {
  caller_id: string
  caller_name: string
  total_calls: number
  reached: number
  appointments: number
  callbacks: number
  reach_rate: number
  conversion_pct: number
  avg_quality: number | null
  no_shows: number
  deals: number
  uploads: number
}


export default function CCManagerDashboard() {
  const t = useTranslations('dashboard.team')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [callCenter, setCallCenter] = useState<CallCenter | null>(null)
  const [allUploads, setAllUploads] = useState<UploadSummary[]>([])
  const [allFeedback, setAllFeedback] = useState<AppointmentWithFeedback[]>([])
  const [allAnalyses, setAllAnalyses] = useState<AnalysisAgg[]>([])
  const [directFeedback, setDirectFeedback] = useState<DirectFeedback[]>([])
  // Alle projecten van mijn call_center — ook die nog geen uploads hebben.
  const [allProjects, setAllProjects] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_dateFilterKind, setDateFilterKind] = useState<DateFilterKind>('month')
  const [selectedProject, setSelectedProject] = useState<string>('alle')
  const [selectedCaller, setSelectedCaller] = useState<string | null>(null)

  // Custom-field data voor het geselecteerde project
  const [customDefs, setCustomDefs] = useState<CustomFieldDef[]>([])
  const [customRecords, setCustomRecords] = useState<{ status: string | null; custom_fields: CustomFieldsBag }[]>([])
  const [customInsights, setCustomInsights] = useState<CustomInsight[]>([])

  // Calls/u-chart data — alleen geladen wanneer een specifiek project gekozen
  // is en er een datumrange is. We halen 3 dingen op:
  //   1) call_records (caller_id via upload + call_date) → calls per dag
  //   2) weekly_hour_confirmations → uren per dag (Ma-Vr kolommen)
  //   3) project_caller_rates → preset/5 als fallback per werkdag
  type ChartCallRow = { caller_id: string; call_date: string; status: string | null }
  type ChartConfRow = {
    caller_id:       string
    week_start_date: string
    hours_mon:       number | null
    hours_tue:       number | null
    hours_wed:       number | null
    hours_thu:       number | null
    hours_fri:       number | null
  }
  type ChartRateRow = { caller_id: string; weekly_hours_preset: number | null }
  const [chartCallRows, setChartCallRows]       = useState<ChartCallRow[]>([])
  const [chartConfRows, setChartConfRows]       = useState<ChartConfRow[]>([])
  const [chartRateRows, setChartRateRows]       = useState<ChartRateRow[]>([])

  // Coaching cache per caller-id. Lazy geladen wanneer een caller wordt
  // geselecteerd. Value = null als er nog geen cached advice is.
  type CoachingRow = {
    advice_text:     string
    context_summary: {
      total_calls: number; reached: number; appointments: number
      reach_rate: number;  conv_rate: number
      top_objections: { label: string; count: number }[]
      sample_notes: string[]; period_days: number
    } | null
    generated_at: string
  }
  const [coachingByCaller, setCoachingByCaller] = useState<Record<string, CoachingRow | null>>({})
  const [coachingLoading, setCoachingLoading] = useState<Record<string, boolean>>({})

  // Reanalyze-state — voor de "Heranalyseer"-knop bij Top bezwaren.
  // Wordt getriggerd op project-niveau (huidige selectedProject) en stuurt
  // GPT opnieuw door alle uploads. Server-side overschrijft de bestaande
  // analyses-rijen, dus na een refresh zie je de nieuwe bezwaren-counts.
  const [reanalysing, setReanalysing]       = useState(false)
  const [reanalyseMsg, setReanalyseMsg]     = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  // Team-chart metric toggle: één chart toont één metric tegelijk.
  // Bewust géén dual-Y axis — die maakte het visueel druk met meer dan 2 callers.
  const [teamChartMetric, setTeamChartMetric] = useState<'calls' | 'reach'>('calls')

  // Sync-state — voor de "Sync nu"-knop bovenaan de team-page. Detecteert
  // welke sync-bronnen het project heeft (Google Sheets, HubSpot calls,
  // Lemlist campaign) en kan ze alle drie triggeren. Spiegelt de logica van
  // de projecten-page zodat de cc_manager niet hoeft te wisselen van pagina.
  type SyncCapabilities = {
    // Elke binding is 1 (caller, sheet)-koppeling — sinds multi-sheet
    // kan een caller er meerdere hebben, dus we syncen per binding_id.
    sheetBindings:    { id: string; caller_id: string }[]
    hubspotListId:    string | null
    lemlistCampaignId:string | null
  }
  const [syncCaps, setSyncCaps]             = useState<SyncCapabilities>({
    sheetBindings: [], hubspotListId: null, lemlistCampaignId: null,
  })
  const [syncing, setSyncing]               = useState(false)
  const [syncMsg, setSyncMsg]               = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const hasSync =
    syncCaps.sheetBindings.length > 0
    || !!syncCaps.hubspotListId
    || !!syncCaps.lemlistCampaignId

  // Sync-capaciteiten van het geselecteerde project laden. Eén query per bron;
  // we tonen de knop zodra minstens één ervan iets oplevert.
  useEffect(() => {
    if (selectedProject === 'alle') {
      setSyncCaps({ sheetBindings: [], hubspotListId: null, lemlistCampaignId: null })
      return
    }
    const supabase = createClient()
    let cancelled = false

    Promise.all([
      supabase.from('project_google_sheets').select('id, caller_id').eq('project_id', selectedProject),
      supabase.from('projects').select('hubspot_calls_list_id, lemlist_campaign_id').eq('id', selectedProject).maybeSingle(),
    ]).then(([sheetRes, projRes]) => {
      if (cancelled) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proj = projRes.data as any
      setSyncCaps({
        sheetBindings:     (sheetRes.data ?? []) as { id: string; caller_id: string }[],
        hubspotListId:     proj?.hubspot_calls_list_id ?? null,
        lemlistCampaignId: proj?.lemlist_campaign_id   ?? null,
      })
    })

    return () => { cancelled = true }
  }, [selectedProject])

  async function handleSyncNow() {
    if (selectedProject === 'alle' || !hasSync) return
    setSyncing(true)
    setSyncMsg(null)
    let totalImported = 0
    const summaryParts: string[] = []
    let firstError: string | null = null

    // 1. Google Sheets — per caller
    for (const b of syncCaps.sheetBindings) {
      try {
        // Multi-sheet: stuur binding_id zodat de route exact déze sheet
        // sync't (en niet per ongeluk twee bindings mergt of alleen de
        // eerste pakt). Zonder dit zou een caller met 2 sheets alleen
        // de oudste zien syncen.
        const res = await fetch(`/api/projects/${selectedProject}/google-sync`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ binding_id: b.id }),
        })
        const data = await res.json()
        if (!res.ok) {
          if (!firstError) firstError = data.error ?? 'Google Sheets sync mislukt'
        } else {
          totalImported += data.imported ?? 0
        }
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : 'Sync error'
      }
    }
    if (syncCaps.sheetBindings.length > 0) {
      summaryParts.push(`${syncCaps.sheetBindings.length} sheet${syncCaps.sheetBindings.length !== 1 ? 's' : ''}`)
    }

    // 2. HubSpot calls — één call voor alle calls in het project's list
    if (syncCaps.hubspotListId) {
      try {
        const res = await fetch(`/api/integrations/hubspot-cc/sync`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ project_id: selectedProject, days_back: 7 }),
        })
        const data = await res.json()
        if (!res.ok) {
          if (!firstError) firstError = data.error ?? 'HubSpot sync mislukt'
        } else {
          totalImported += data.calls_imported ?? 0
          summaryParts.push('HubSpot')
        }
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : 'HubSpot sync error'
      }

      // 2b. Dealstage-sync — voor afspraken die al in CallScope staan, kijk
      // of de bijhorende deal in HubSpot een nieuwe stage heeft. Loopt
      // automatisch achter de calls-sync zodat nieuwe afspraken meteen ook
      // hun eerste dealstage krijgen (als de sales-rep al begonnen is).
      try {
        const dsRes = await fetch(`/api/integrations/hubspot/sync`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ project_id: selectedProject }),
        })
        const dsData = await dsRes.json()
        if (!dsRes.ok) {
          // Niet kritisch — calls-sync is al gelukt. Toon de error niet als
          // "Geen afspraken om te syncen" — dat is gewoon geen werk te doen.
          if (!firstError && dsData.error && !/Geen afspraken/i.test(dsData.error)) {
            firstError = dsData.error
          }
        } else {
          if ((dsData.synced ?? 0) > 0) {
            summaryParts.push(`${dsData.synced} dealstage${dsData.synced !== 1 ? 's' : ''} bijgewerkt`)
          }
        }
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : 'Dealstage sync error'
      }
    }

    // 3. Lemlist campaign
    if (syncCaps.lemlistCampaignId) {
      try {
        const res = await fetch(`/api/integrations/lemlist/sync`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ project_id: selectedProject }),
        })
        const data = await res.json()
        if (!res.ok) {
          if (!firstError) firstError = data.error ?? 'Lemlist sync mislukt'
        } else {
          totalImported += data.imported ?? data.tasks_imported ?? 0
          summaryParts.push('Lemlist')
        }
      } catch (err) {
        if (!firstError) firstError = err instanceof Error ? err.message : 'Lemlist sync error'
      }
    }

    setSyncing(false)
    if (firstError) {
      setSyncMsg({ type: 'error', text: firstError })
    } else {
      const sources = summaryParts.join(' + ') || 'geen bronnen'
      setSyncMsg({
        type: 'ok',
        text: totalImported > 0
          ? `✓ ${totalImported} nieuwe lead${totalImported !== 1 ? 's' : ''}/call${totalImported !== 1 ? 's' : ''} gesynced (${sources}).`
          : `✓ Geen nieuwe data gevonden (${sources}).`,
      })
      // Herlaad alle data zodat de team-page de nieuwe uploads + records toont.
      loadData()
    }
  }

  async function handleReanalyse() {
    if (selectedProject === 'alle') return
    // Confirmatie weggehaald — de Heranalyseer-knop triggert direct.
    // De inline toast-melding hieronder communiceert het resultaat.
    setReanalysing(true)
    setReanalyseMsg(null)
    try {
      const res = await fetch(`/api/projects/${selectedProject}/reanalyse`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setReanalyseMsg({ type: 'error', text: data.error ?? t('objections.reanalyseError') })
        return
      }
      setReanalyseMsg({
        type: 'ok',
        text: t('objections.reanalyseSuccess', { n: data.succeeded ?? 0 }),
      })
    } catch (e) {
      setReanalyseMsg({ type: 'error', text: e instanceof Error ? e.message : t('objections.reanalyseError') })
    } finally {
      setReanalysing(false)
    }
  }

  useEffect(() => { loadData() }, [])

  // Het team-dashboard toont altijd één specifiek project — een cross-project
  // overzicht is hier nooit zinvol omdat de KPIs en de extra-velden-analyse
  // semantisch verschillen tussen projecten. Als selectedProject nog 'alle' is
  // (initial state) → pak het eerste project.
  useEffect(() => {
    if (selectedProject !== 'alle') return

    // Verzamel alle bekende project_ids — eerst uit allProjects (project_call_centers),
    // anders uit allUploads (legacy fallback).
    const orderedIds: string[] = []
    const seen = new Set<string>()
    for (const p of allProjects) {
      if (!seen.has(p.id)) { seen.add(p.id); orderedIds.push(p.id) }
    }
    for (const u of allUploads) {
      if (u.project_id && !seen.has(u.project_id)) { seen.add(u.project_id); orderedIds.push(u.project_id) }
    }
    if (orderedIds.length > 0) {
      setSelectedProject(orderedIds[0])
    }
  }, [allProjects, allUploads, selectedProject])

  // Custom-field data laden voor 1 specifiek geselecteerd project.
  // Bij 'alle' tonen we de sectie niet, om verwarring tussen projecten met
  // verschillende veld-definities te voorkomen.
  useEffect(() => {
    if (selectedProject === 'alle') {
      setCustomDefs([])
      setCustomRecords([])
      setCustomInsights([])
      return
    }

    const supabase = createClient()
    let cancelled = false

    ;(async () => {
      const { data: proj } = await supabase
        .from('projects')
        .select('custom_field_definitions')
        .eq('id', selectedProject)
        .maybeSingle()
      if (cancelled) return

      const defs = (proj as { custom_field_definitions?: CustomFieldDef[] } | null)?.custom_field_definitions ?? []
      setCustomDefs(defs)

      if (defs.length === 0) {
        setCustomRecords([])
        setCustomInsights([])
        return
      }

      // Records van dit project, met custom_fields + status
      const { data: cr } = await supabase
        .from('call_records')
        .select('status, custom_fields')
        .eq('project_id', selectedProject)
      if (cancelled) return

      setCustomRecords(
        (cr ?? []).map(r => ({
          status: (r as { status: string | null }).status ?? null,
          custom_fields: (r as { custom_fields?: CustomFieldsBag }).custom_fields ?? {},
        }))
      )

      // AI-insights samenvoegen over alle uploads van dit project
      const projectUploads = allUploads.filter(u => u.project_id === selectedProject).map(u => u.id)
      if (projectUploads.length > 0) {
        const { data: ana } = await supabase
          .from('analyses')
          .select('custom_insights')
          .in('upload_id', projectUploads)
        if (cancelled) return
        setCustomInsights(
          (ana ?? []).flatMap(a =>
            ((a as { custom_insights?: CustomInsight[] }).custom_insights ?? [])
          )
        )
      } else {
        setCustomInsights([])
      }
    })()

    return () => { cancelled = true }
  }, [selectedProject, allUploads])

  // Calls/u-chart data — alleen voor een specifiek project + actieve range
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
      const fromIso  = dateRange.from!.toISOString()
      const toIso    = dateRange.to!.toISOString()
      const fromDate = fromIso.slice(0, 10)
      const toDate   = toIso.slice(0, 10)

      // 1) call_records → join op uploads om caller_id te krijgen.
      //    Status meenemen voor de bereikratio-lijn (zelfde dataset, geen
      //    extra fetch nodig). "Calls/u" telt elke gebelde lead; bereikratio
      //    splitst die op in #bereikt / #totaal.
      const { data: cr } = await sb
        .from('call_records')
        .select('call_date, status, uploads!inner(caller_id)')
        .eq('project_id', selectedProject)
        .gte('call_date', fromDate)
        .lte('call_date', toDate)
        .returns<{ call_date: string | null; status: string | null; uploads: { caller_id: string } | { caller_id: string }[] | null }[]>()

      // 2) weekly_hour_confirmations — alle weken die overlappen met de range
      // ATTN: gebruik isoDay() i.p.v. .toISOString().slice(0,10) op een local
      // Date — die laatste shift in zomertijd 2u terug (UTC+2 → 's nachts 22u
      // dag eerder) waardoor monTo één dag te vroeg uitkomt en de week-rij met
      // week_start_date='YYYY-MM-DD' juist NIET matched in de .lte()-filter.
      const monFrom = isoDay(mondayOfDay(dateRange.from!))
      const monTo   = isoDay(mondayOfDay(dateRange.to!))
      const { data: conf } = await sb
        .from('weekly_hour_confirmations')
        .select('caller_id, week_start_date, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri')
        .eq('project_id', selectedProject)
        .gte('week_start_date', monFrom)
        .lte('week_start_date', monTo)

      // 3) project_caller_rates voor preset-fallback
      const { data: rates } = await sb
        .from('project_caller_rates')
        .select('caller_id, weekly_hours_preset')
        .eq('project_id', selectedProject)

      if (cancelled) return

      // Normaliseer cr → { caller_id, call_date, status }[]
      const calls: ChartCallRow[] = (cr ?? [])
        .map(r => {
          const up = Array.isArray(r.uploads) ? r.uploads[0] : r.uploads
          if (!up?.caller_id || !r.call_date) return null
          return {
            caller_id: up.caller_id,
            call_date: r.call_date.slice(0, 10),
            status:    r.status,
          }
        })
        .filter((r): r is ChartCallRow => r !== null)

      setChartCallRows(calls)
      setChartConfRows((conf ?? []) as ChartConfRow[])
      setChartRateRows((rates ?? []) as ChartRateRow[])
    })()

    return () => { cancelled = true }
  }, [selectedProject, dateRange])

  async function loadData() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: p } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(p)

    const { data: cc } = await supabase.from('call_centers').select('*').eq('manager_id', user.id).single()
    setCallCenter(cc)

    // Alle projecten van dit call_center ophalen — ook die zonder uploads.
    if (cc?.id) {
      const { data: pccs } = await supabase
        .from('project_call_centers')
        .select('project_id, projects(id, name)')
        .eq('call_center_id', cc.id)
        .returns<{ project_id: string; projects: { id: string; name: string } | null }[]>()
      setAllProjects(
        (pccs ?? [])
          .filter(p => p.projects)
          .map(p => ({ id: p.projects!.id, name: p.projects!.name }))
      )
    }

    const { data: uploads } = await supabase
      .from('upload_summary').select('*').order('uploaded_at', { ascending: false })

    const { data: feedback } = await supabase
      .from('appointments_with_feedback').select('*')

    const { data: direct } = await supabase
      .from('appointment_feedback')
      .select('outcome, appointment_status, call_record_id')

    const { data: analyses } = await supabase
      .from('analyses').select('upload_id, objections, total_calls, reached, appointments')

    setAllUploads(uploads ?? [])
    setAllFeedback(feedback ?? [])
    setAllAnalyses(analyses ?? [])
    setDirectFeedback(direct ?? [])
    setLoading(false)
  }

  // Gefilterde uploads — gebruikt nu een DateRange (from/to) i.p.v. één
  // cutoff zodat 'Deze maand' en 'Aangepast' (van-tot) ook werken.
  const filteredUploads = useMemo(() => {
    let data = allUploads
    if (selectedProject !== 'alle') data = data.filter(u => u.project_id === selectedProject)
    if (dateRange.from || dateRange.to) {
      data = data.filter(u => isInRange(new Date(u.uploaded_at), dateRange))
    }
    return data
  }, [allUploads, selectedProject, dateRange])

  // Gefilterde feedback
  const filteredFeedback = useMemo(() => {
    let data = allFeedback
    if (selectedProject !== 'alle') data = data.filter(f => f.project_id === selectedProject)
    if (dateRange.from || dateRange.to) {
      data = data.filter(f => f.call_date && isInRange(new Date(f.call_date), dateRange))
    }
    return data
  }, [allFeedback, selectedProject, dateRange])

  // Unieke projecten
  const projects = useMemo(() => {
    // Combineer projecten uit DB met die uit uploads (voor robuustheid bij
    // legacy data zonder project_call_centers-rij).
    const map = new Map<string, string>()
    for (const p of allProjects) map.set(p.id, p.name)
    for (const u of allUploads) {
      if (u.project_id && u.project_name && !map.has(u.project_id)) {
        map.set(u.project_id, u.project_name)
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [allProjects, allUploads])

  // Caller stats
  const callerStats = useMemo((): CallerStats[] => {
    const map = new Map<string, CallerStats>()

    for (const u of filteredUploads) {
      if (!u.caller_name) continue
      const key = u.caller_id ?? u.caller_name
      if (!map.has(key)) {
        map.set(key, {
          caller_id: key,
          caller_name: u.caller_name,
          total_calls: 0, reached: 0, appointments: 0, callbacks: 0,
          reach_rate: 0, conversion_pct: 0, avg_quality: null,
          no_shows: 0, deals: 0, uploads: 0,
        })
      }
      const cs = map.get(key)!
      cs.total_calls  += u.total_calls  ?? 0
      cs.reached      += u.reached      ?? 0
      cs.appointments += u.appointments ?? 0
      cs.callbacks    += u.callbacks    ?? 0
      cs.uploads++
    }

    // Feedback stats — gebruik directe feedback voor deals.
    // BELANGRIJK: filter directFeedback op de huidige projectscope. We gebruiken
    // filteredFeedback (already project-scoped) als whitelist van call_record_ids
    // om te voorkomen dat deals/no_shows uit andere projecten meetellen voor
    // een caller die in meerdere projecten zit.
    const scopedCallRecordIds = new Set(filteredFeedback.map(f => f.call_record_id))
    for (const fb of directFeedback) {
      if (!scopedCallRecordIds.has(fb.call_record_id)) continue
      // Zoek de bijbehorende caller via call_records
      const cs = Array.from(map.values()).find(c => c.caller_name ===
        allFeedback.find(f => f.call_record_id === fb.call_record_id)?.caller_name
      )
      if (!cs) continue
      if (fb.appointment_status === 'no_show') cs.no_shows++
      if (fb.outcome === 'deal') cs.deals++
    }

    // Kwaliteitsratings
    for (const cs of Array.from(map.values())) {
      const cFb = filteredFeedback.filter(f => f.caller_name === cs.caller_name && f.quality_rating)
      cs.avg_quality = cFb.length > 0
        ? Math.round(cFb.reduce((s, f) => s + (f.quality_rating ?? 0), 0) / cFb.length * 10) / 10
        : null
      cs.reach_rate = cs.total_calls > 0 ? Math.round(cs.reached / cs.total_calls * 100) : 0
      cs.conversion_pct = cs.reached > 0 ? Math.round(cs.appointments / cs.reached * 100) : 0
    }

    return Array.from(map.values()).sort((a, b) => b.appointments - a.appointments)
  }, [filteredUploads, filteredFeedback, allFeedback, directFeedback])

  // AI inzichten aggregatie
  const aiInsights = useMemo(() => {
    const relevantIds = new Set(filteredUploads.map(u => u.id))
    const map = new Map<string, number>()
    for (const a of allAnalyses) {
      if (!relevantIds.has(a.upload_id)) continue
      for (const obj of (a.objections ?? [])) {
        map.set(obj.label, (map.get(obj.label) ?? 0) + obj.count)
      }
    }
    const total = Array.from(map.values()).reduce((s, v) => s + v, 0)
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([label, count]) => ({ label, count, pct: total > 0 ? Math.round(count / total * 100) : 0 }))
  }, [allAnalyses, filteredUploads])

  // Totalen — deals via directe feedback, project-scoped
  const totals = useMemo(() => {
    const base = callerStats.reduce((acc, c) => ({
      calls: acc.calls + c.total_calls,
      reached: acc.reached + c.reached,
      appointments: acc.appointments + c.appointments,
      deals: acc.deals + c.deals,
    }), { calls: 0, reached: 0, appointments: 0, deals: 0 })

    // Tel deals direct uit appointment_feedback maar enkel binnen de huidige
    // project + datum scope. We hergebruiken filteredFeedback (al project-
    // gefilterd) als whitelist van call_record_ids zodat deals van andere
    // projecten niet meetellen.
    const scopedCallRecordIds = new Set(filteredFeedback.map(f => f.call_record_id))
    const directDeals = directFeedback.filter(f =>
      scopedCallRecordIds.has(f.call_record_id) && f.outcome === 'deal'
    ).length
    return { ...base, deals: directDeals }
  }, [callerStats, directFeedback, filteredFeedback])

  // Custom-field analyse voor het geselecteerde project
  // Voor elk veld: data om te vergelijken tussen alle leads en alleen afspraken.
  type CategoryRow = { name: string; fullName: string; total: number; appointments: number; rate: number }
  type DateRow     = { name: string; total: number; appointments: number }
  type CategoryItem = { def: CustomFieldDef; kind: 'category'; data: CategoryRow[] }
  type NumberItem   = {
    def: CustomFieldDef; kind: 'number'
    allCount: number; apptCount: number
    avgAll: number; avgAppt: number
    sumAll: number; sumAppt: number
  }
  type DateItem     = { def: CustomFieldDef; kind: 'date'; data: DateRow[] }
  type TextItem     = { def: CustomFieldDef; kind: 'text'; count: number }
  type CustomItem   = CategoryItem | NumberItem | DateItem | TextItem

  const customAnalysis = useMemo<CustomItem[]>(() => {
    if (customDefs.length === 0 || customRecords.length === 0) return []

    const isAppointment = (status: string | null) => APPOINTMENT_RE.test(status ?? '')

    return customDefs.map<CustomItem>(def => {
      if (def.type === 'category') {
        const counts = new Map<string, { total: number; appts: number }>()
        for (const r of customRecords) {
          const v = r.custom_fields[def.key]
          if (v == null || v === '') continue
          const cat = String(v)
          if (!counts.has(cat)) counts.set(cat, { total: 0, appts: 0 })
          const c = counts.get(cat)!
          c.total++
          if (isAppointment(r.status)) c.appts++
        }
        const data: CategoryRow[] = Array.from(counts.entries())
          .map(([cat, c]) => ({
            name: cat.length > 18 ? cat.slice(0, 16) + '…' : cat,
            fullName: cat,
            total: c.total,
            appointments: c.appts,
            rate: c.total > 0 ? Math.round(c.appts / c.total * 100) : 0,
          }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 8)
        return { def, kind: 'category', data }
      }

      if (def.type === 'number') {
        const allNums = customRecords
          .map(r => r.custom_fields[def.key])
          .filter((v): v is number | string => v !== null && v !== undefined && v !== '')
          .map(Number)
          .filter(n => Number.isFinite(n))
        const apptNums = customRecords
          .filter(r => isAppointment(r.status))
          .map(r => r.custom_fields[def.key])
          .filter((v): v is number | string => v !== null && v !== undefined && v !== '')
          .map(Number)
          .filter(n => Number.isFinite(n))

        const sumAll  = allNums.reduce((s, n) => s + n, 0)
        const sumAppt = apptNums.reduce((s, n) => s + n, 0)

        return {
          def, kind: 'number',
          allCount: allNums.length, apptCount: apptNums.length,
          sumAll, sumAppt,
          avgAll:  allNums.length  > 0 ? sumAll  / allNums.length  : 0,
          avgAppt: apptNums.length > 0 ? sumAppt / apptNums.length : 0,
        }
      }

      if (def.type === 'date') {
        // Histogram per week
        const buckets = new Map<string, { total: number; appts: number }>()
        for (const r of customRecords) {
          const v = r.custom_fields[def.key]
          if (v == null || v === '') continue
          const d = new Date(String(v))
          if (Number.isNaN(d.getTime())) continue
          const ws = new Date(d)
          ws.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // maandag-start
          const key = ws.toISOString().slice(0, 10)
          if (!buckets.has(key)) buckets.set(key, { total: 0, appts: 0 })
          const b = buckets.get(key)!
          b.total++
          if (isAppointment(r.status)) b.appts++
        }
        const data: DateRow[] = Array.from(buckets.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([key, c]) => {
            const dt = new Date(key)
            return {
              name: dt.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' }),
              total: c.total,
              appointments: c.appts,
            }
          })
        return { def, kind: 'date', data }
      }

      // text
      const filled = customRecords
        .filter(r => {
          const v = r.custom_fields[def.key]
          return v !== null && v !== undefined && v !== ''
        }).length
      return { def, kind: 'text', count: filled }
    })
  }, [customDefs, customRecords])

  // Cross-veld correlaties: number × category combinaties
  // Bv. "Hoogste gem. Offertewaarde komt van Bron = Google Ads"
  type CrossCorrelation = {
    numberDef: CustomFieldDef
    categoryDef: CustomFieldDef
    breakdowns: { category: string; avg: number; total: number; n: number }[]
  }
  const customCorrelations = useMemo<CrossCorrelation[]>(() => {
    if (customDefs.length === 0 || customRecords.length === 0) return []
    const numberFields = customDefs.filter(d => d.type === 'number')
    const categoryFields = customDefs.filter(d => d.type === 'category')
    const out: CrossCorrelation[] = []

    for (const num of numberFields) {
      for (const cat of categoryFields) {
        const map = new Map<string, { sum: number; n: number }>()
        for (const r of customRecords) {
          const c = r.custom_fields[cat.key]
          const v = r.custom_fields[num.key]
          if (c == null || c === '' || v == null || v === '') continue
          const cKey = String(c)
          const vNum = Number(v)
          if (!Number.isFinite(vNum)) continue
          if (!map.has(cKey)) map.set(cKey, { sum: 0, n: 0 })
          const m = map.get(cKey)!
          m.sum += vNum
          m.n++
        }
        const breakdowns = Array.from(map.entries())
          .map(([category, m]) => ({ category, avg: m.sum / m.n, total: m.sum, n: m.n }))
          .sort((a, b) => b.avg - a.avg)

        // Alleen relevant als er minstens 2 categorieën zijn
        if (breakdowns.length >= 2) {
          out.push({ numberDef: num, categoryDef: cat, breakdowns })
        }
      }
    }
    return out
  }, [customDefs, customRecords])

  // Dedup AI-insights op headline
  const dedupedCustomInsights = useMemo(() => {
    const seen = new Set<string>()
    return customInsights.filter(ins => {
      if (seen.has(ins.headline)) return false
      seen.add(ins.headline)
      return true
    })
  }, [customInsights])

  // ── Gecombineerde team-chart aggregatie ────────────────────────────────
  // Eén grafiek met dual Y-axis: links calls/u (solid lijn per caller),
  // rechts bereikratio % (gestippelde lijn in dezelfde kleur). De compute-
  // logica zit in @/lib/team-charts zodat we 'm ook server-side kunnen
  // gebruiken in het project-rapport.
  const teamChartData = useMemo(() => {
    if (selectedProject === 'alle' || !dateRange.from || !dateRange.to) return { rows: [], callers: [] }
    if (chartCallRows.length === 0 && chartConfRows.length === 0) return { rows: [], callers: [] }

    const visibleCallers = callerStats.slice(0, 8).map((c, i) => ({
      id:    c.caller_id,
      name:  c.caller_name,
      color: CHART_CALLER_COLORS[i % CHART_CALLER_COLORS.length],
    }))

    // Afspraken per (caller, dag) voor de secondaire y-as. Trekken we
    // uit filteredFeedback want dat is al project + datum-scoped.
    const apptRows = filteredFeedback.map(f => ({
      caller_id: f.caller_id,
      call_date: f.call_date,
    }))

    return computeCombinedTeamData(
      chartCallRows, chartConfRows, chartRateRows,
      visibleCallers,
      dateRange.from, dateRange.to,
      locale === 'nl' ? 'nl-BE' : locale,
      apptRows,
    )
  }, [selectedProject, dateRange, chartCallRows, chartConfRows, chartRateRows, callerStats, locale, filteredFeedback])

  // Geselecteerde caller detail
  const selectedCallerData = selectedCaller
    ? callerStats.find(c => c.caller_id === selectedCaller)
    : null

  // Lazy load coaching voor een caller wanneer hij open klapt. We laden alleen
  // als de caller_id een echte UUID is — bij legacy uploads is caller_id soms
  // een caller_name string i.p.v. een profile id, en die hebben geen coaching.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  useEffect(() => {
    if (!selectedCaller) return
    if (!UUID_RE.test(selectedCaller)) return
    if (selectedCaller in coachingByCaller) return         // al geladen (of explicit null)
    if (coachingLoading[selectedCaller]) return            // al onderweg

    const supabase = createClient()
    setCoachingLoading(prev => ({ ...prev, [selectedCaller]: true }))
    ;(async () => {
      const { data } = await supabase
        .from('caller_coaching_insights')
        .select('advice_text, context_summary, generated_at')
        .eq('caller_id', selectedCaller)
        .maybeSingle()
      setCoachingByCaller(prev => ({ ...prev, [selectedCaller]: (data as CoachingRow | null) ?? null }))
      setCoachingLoading(prev => ({ ...prev, [selectedCaller]: false }))
    })()
  }, [selectedCaller, coachingByCaller, coachingLoading])

  const selectedCallerFeedback = selectedCaller
    ? filteredFeedback.filter(f => {
        const cs = callerStats.find(c => c.caller_id === selectedCaller)
        return cs && f.caller_name === cs.caller_name && f.appointment_status && f.appointment_status !== 'gepland'
      })
    : []

  if (loading) return <div className="text-sm text-gray-400 p-8">{tCommon('loading')}</div>

  const reachRate = totals.calls > 0 ? Math.round(totals.reached / totals.calls * 100) : 0
  const convRate  = totals.reached > 0 ? Math.round(totals.appointments / totals.reached * 100) : 0

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            {t('title')}
            {(() => {
              const proj = projects.find(p => p.id === selectedProject)
              return proj ? <span className="text-gray-400 font-normal"> — {proj.name}</span> : null
            })()}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {callCenter?.name} · {t('callersCount', { count: callerStats.length })}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Sync-knop — verschijnt zodra het project minstens één sync-bron heeft
              (Google Sheets, HubSpot list, of Lemlist campaign). Triggert alle
              ingestelde bronnen tegelijk en herlaadt daarna de team-page. */}
          {selectedProject !== 'alle' && hasSync && (
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              className="text-xs px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Pak vandaag's leads uit alle Google Sheets van dit project"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={syncing ? 'animate-spin' : ''}>
                <path d="M2 8a6 6 0 0110.5-4M14 8a6 6 0 01-10.5 4M11 4h3V1M5 12H2v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {syncing ? 'Syncen...' : 'Sync nu'}
            </button>
          )}
          {/* Datumfilter — herbruikbare component met 7d / 30d / deze maand /
              alles / aangepast (custom from-to). */}
          <DateRangeFilter
            defaultKind="month"
            onChange={(range, kind) => {
              setDateRange(range)
              setDateFilterKind(kind)
            }}
          />
          {/* Projectfilter — alleen tonen als er meer dan 1 project is.
              "Alle"-optie is verborgen omdat cross-project op het team
              dashboard nooit zinvol is. */}
          {projects.length > 1 && (
            <ProjectFilter
              projects={projects}
              value={selectedProject}
              onChange={setSelectedProject}
              hideAll
            />
          )}
        </div>
      </div>

      {/* Sync-feedback (succes / fout) net onder de filters */}
      {syncMsg && (
        <div className={`mb-4 px-3 py-2 rounded-md text-xs ${
          syncMsg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          {syncMsg.text}
        </div>
      )}

      {/* Team KPI's */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {[
          { label: t('kpis.leadsContacted'), value: totals.calls,        sub: null,                                              color: 'text-gray-900' },
          { label: t('kpis.reachRatio'),     value: `${reachRate}%`,     sub: t('kpis.reachedSub',    { n: totals.reached }),     color: 'text-gray-900' },
          { label: t('kpis.appointments'),   value: totals.appointments, sub: t('kpis.conversionSub', { n: convRate }),           color: 'text-brand-700' },
          { label: t('kpis.deals'),          value: totals.deals,        sub: t('kpis.dealsSub'),                                  color: 'text-green-700' },
        ].map(kpi => (
          <div key={kpi.label} className="card p-4">
            <div className="text-xs text-gray-400 mb-1">{kpi.label}</div>
            <div className={`text-2xl font-semibold ${kpi.color}`}>{kpi.value}</div>
            {kpi.sub && <div className="text-xs text-gray-400 mt-0.5">{kpi.sub}</div>}
          </div>
        ))}
      </div>

      {/* Conversie-funnel — trapezium-vorm met per-stap conversieratio's. */}
      <ConversionFunnelChart
        called={totals.calls}
        reached={totals.reached}
        appointments={totals.appointments}
        deals={totals.deals}
      />

      {/* Dealstages breakdown = periode-scoped (volgt de datum-filter).
          Deals per maand = altijd het volledige kalenderjaar — bewust los
          van de datum-filter, om trends over het jaar heen te tonen. */}
      <DealsBreakdownCard feedback={filteredFeedback} />
      <DealsPerMonthChart feedback={
        selectedProject === 'alle'
          ? allFeedback
          : allFeedback.filter(f => f.project_id === selectedProject)
      } />

      {/* Team-chart: één metric tegelijk, switchbaar via toggle. Eén lijn
          per caller in z'n eigen kleur. Bewust géén dual-Y axis — met meer
          dan 2 callers werd dat visueel te druk en de bereikratio-noise op
          dagen met weinig calls verstoorde de leesbaarheid van calls/u. */}
      {selectedProject !== 'alle' && teamChartData.callers.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <div>
              <div className="text-sm font-medium text-gray-900">
                {teamChartMetric === 'calls' ? t('teamChart.titleCalls') : t('teamChart.titleReach')}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {teamChartMetric === 'calls' ? t('teamChart.subtitleCalls') : t('teamChart.subtitleReach')}
              </p>
            </div>
            {/* Pill-toggle Calls/u ↔ Bereikratio */}
            <div className="inline-flex gap-0.5 bg-gray-100 p-0.5 rounded-md">
              <button
                onClick={() => setTeamChartMetric('calls')}
                className={`text-xs px-2.5 py-1 rounded transition-colors ${
                  teamChartMetric === 'calls'
                    ? 'bg-white text-gray-900 font-medium shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t('teamChart.toggleCalls')}
              </button>
              <button
                onClick={() => setTeamChartMetric('reach')}
                className={`text-xs px-2.5 py-1 rounded transition-colors ${
                  teamChartMetric === 'reach'
                    ? 'bg-white text-gray-900 font-medium shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t('teamChart.toggleReach')}
              </button>
            </div>
          </div>
          {/* Check of de actieve metric überhaupt ergens een nummer heeft —
              anders renderen we een empty state in plaats van een lege grafiek.
              Calls/u kan leeg zijn omdat er geen confirmation-uren zijn; reach
              kan leeg zijn omdat geen enkele dag de ≥20 calls drempel haalt. */}
          {(() => {
            const activeHasData = teamChartData.rows.some(r =>
              teamChartData.callers.some(cl => {
                const key = teamChartMetric === 'reach' ? cl.id + REACH_SUFFIX : cl.id
                return typeof r[key] === 'number'
              }),
            )
            if (!activeHasData) {
              return (
                <div className="mt-4 py-12 px-4 text-center border border-dashed border-gray-200 rounded-lg">
                  <p className="text-sm text-gray-500 mb-3">
                    {teamChartMetric === 'calls'
                      ? t('teamChart.emptyCalls')
                      : t('teamChart.emptyReach')}
                  </p>
                  {teamChartMetric === 'calls' && (
                    <Link
                      href={`/dashboard/projects/${selectedProject}/confirm-hours`}
                      className="text-sm text-brand-600 hover:underline"
                    >
                      {t('teamChart.emptyCallsCta')} →
                    </Link>
                  )}
                </div>
              )
            }
            return (
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
                      // Bereikratio: vast 0-100 zodat verschil tussen 60% en 80% niet
                      // visueel als "enorm" overkomt. Calls/u: auto-schaal.
                      domain={teamChartMetric === 'reach' ? [0, 100] : ['auto', 'auto']}
                      tick={{ fontSize: 11, fill: '#9ca3af' }}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                      unit={teamChartMetric === 'reach' ? '%' : ''}
                      label={{
                        value: teamChartMetric === 'calls' ? t('teamChart.yAxisLeft') : t('teamChart.yAxisRight'),
                        angle: -90, position: 'insideLeft',
                        style: { fontSize: 10, fill: '#9ca3af', textAnchor: 'middle' },
                      }}
                    />
                    {/* Tooltip toont per hoverpunt zowel de gekozen metric als
                        het aantal afspraken van die dag (uit APPT_SUFFIX). Zo
                        blijft de correlatie zichtbaar zonder een tweede lijn
                        die de grafiek onleesbaar maakt. */}
                    <Tooltip
                      contentStyle={{ fontSize: 12, border: '0.5px solid #e5e7eb', borderRadius: 8, boxShadow: 'none' }}
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      content={({ active, payload, label }: any) => {
                        if (!active || !payload || payload.length === 0) return null
                        return (
                          <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
                            <div style={{ fontWeight: 500, marginBottom: 4, color: '#111827' }}>{label}</div>
                            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                            {payload.map((p: any) => {
                              const row  = p.payload as Record<string, number | null | string>
                              const appts = row[p.dataKey + APPT_SUFFIX] as number | null | undefined
                              const primary = teamChartMetric === 'reach'
                                ? `${p.value}%`
                                : `${p.value} ${t('teamChart.unitCallsPerHour')}`
                              return (
                                <div key={p.dataKey} style={{ marginBottom: 3, color: p.color }}>
                                  <div style={{ fontWeight: 500 }}>{p.name}</div>
                                  <div style={{ color: '#374151' }}>{primary}</div>
                                  {typeof appts === 'number' && (
                                    <div style={{ color: '#6b7280', fontSize: 11 }}>
                                      {appts} {t('teamChart.appointmentsUnit')}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )
                      }}
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
            )
          })()}
          <p className="text-xs text-gray-400 mt-2">{t('teamChart.footer')}</p>
        </div>
      )}

      {/* Caller detail tabel */}
      <div className="card p-5 mb-6">
        <div className="text-sm font-medium text-gray-900 mb-4">{t('performance.title')}</div>
        {callerStats.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">{t('performance.empty')}</p>
        ) : (
          <div className="space-y-1">
            {/* Header — secundaire kolommen (Bereikt/Conv%/Kwaliteit)
                verbergen we op mobile zodat de tabel niet overlapt. Vanaf
                sm (≥640px) verschijnt Bereikt, vanaf md (≥768px) ook
                Conv% en Kwaliteit. Op iPhone (< 400px) toon je dus enkel:
                Nr · Caller · Calls · Afspraken · Deals · chevron. */}
            <div className="flex items-center gap-2 sm:gap-3 pb-2 border-b border-gray-100 text-xs font-medium text-gray-400 uppercase tracking-wide">
              <div className="w-6 flex-shrink-0"/>
              <div className="flex-1 min-w-0">{t('performance.headers.caller')}</div>
              <div className="w-12 sm:w-16 text-center">{t('performance.headers.leads')}</div>
              <div className="hidden sm:block w-16 text-center">{t('performance.headers.reached')}</div>
              <div className="w-14 sm:w-20 text-center">{t('performance.headers.appointments')}</div>
              <div className="hidden md:block w-16 text-center">{t('performance.headers.conv')}</div>
              <div className="hidden md:block w-20 text-center">{t('performance.headers.quality')}</div>
              <div className="w-12 sm:w-16 text-center">{t('performance.headers.deals')}</div>
              <div className="w-6"/>
            </div>

            {callerStats.map((c, i) => (
              <div key={c.caller_id}>
                <div
                  className={`flex items-center gap-2 sm:gap-3 py-2.5 rounded-lg px-1 cursor-pointer transition-colors ${
                    selectedCaller === c.caller_id ? 'bg-brand-50' : 'hover:bg-gray-50'
                  }`}
                  onClick={() => setSelectedCaller(selectedCaller === c.caller_id ? null : c.caller_id)}
                >
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0 ${
                    i === 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{c.caller_name}</div>
                    <div className="text-xs text-gray-400">{t('performance.uploadsCount', { count: c.uploads })}</div>
                  </div>
                  <div className="w-12 sm:w-16 text-center text-sm text-gray-700">{c.total_calls}</div>
                  <div className="hidden sm:block w-16 text-center">
                    <span className="text-sm text-gray-700">{c.reached}</span>
                    <span className="text-xs text-gray-400 ml-1">{c.reach_rate}%</span>
                  </div>
                  <div className="w-14 sm:w-20 text-center">
                    <span className="text-sm font-medium text-brand-700">{c.appointments}</span>
                  </div>
                  <div className="hidden md:block w-16 text-center">
                    <span className={`text-sm font-medium ${
                      c.conversion_pct >= 20 ? 'text-green-600' :
                      c.conversion_pct >= 10 ? 'text-amber-600' : 'text-gray-500'
                    }`}>{c.conversion_pct}%</span>
                  </div>
                  <div className="hidden md:block w-20 text-center">
                    {c.avg_quality ? (
                      <div className="flex gap-0.5 justify-center">
                        {[1,2,3,4,5].map(s => (
                          <div key={s} className={`w-2 h-2 rounded-full ${s <= c.avg_quality! ? 'bg-amber-400' : 'bg-gray-200'}`}/>
                        ))}
                        <span className="text-xs text-gray-400 ml-1">{c.avg_quality}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-300">–</span>
                    )}
                  </div>
                  <div className="w-12 sm:w-16 text-center">
                    <span className="text-sm font-medium text-green-700">{c.deals}</span>
                  </div>
                  <div className="w-6 text-gray-300 text-xs">
                    {selectedCaller === c.caller_id ? '▲' : '▼'}
                  </div>
                </div>

                {/* Caller detail drill-down */}
                {selectedCaller === c.caller_id && selectedCallerData && (
                  <div className="ml-9 mb-2 p-4 bg-gray-50 rounded-lg border border-gray-100">
                    {/* Coaching-blok — alleen als caller_id een echte UUID is.
                        Bij legacy uploads zonder profile is coaching niet beschikbaar. */}
                    {UUID_RE.test(c.caller_id) && (
                      <div className="mb-4">
                        {coachingLoading[c.caller_id] && !(c.caller_id in coachingByCaller) ? (
                          <div className="text-xs text-gray-400">{t('performance.coachingLoading')}</div>
                        ) : (
                          <CoachingBlock
                            initialAdvice={coachingByCaller[c.caller_id]?.advice_text ?? null}
                            initialContext={coachingByCaller[c.caller_id]?.context_summary ?? null}
                            initialGeneratedAt={coachingByCaller[c.caller_id]?.generated_at ?? null}
                            hasActivity={c.total_calls > 0}
                            callerId={c.caller_id}
                          />
                        )}
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                      <div>
                        <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">{t('performance.drilldown.stats')}</div>
                        <div className="space-y-1.5 text-sm">
                          {[
                            { l: t('performance.drilldown.callbacks'),  v: c.callbacks },
                            { l: t('performance.drilldown.noShows'),    v: c.no_shows },
                            { l: t('performance.drilldown.notReached'), v: c.total_calls - c.reached },
                          ].map(s => (
                            <div key={s.l} className="flex justify-between">
                              <span className="text-gray-500">{s.l}</span>
                              <span className="font-medium text-gray-900">{s.v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">{t('performance.drilldown.feedbackSales')}</div>
                        {selectedCallerFeedback.length > 0 ? (
                          <div className="space-y-1.5">
                            {selectedCallerFeedback.slice(0, 4).map((fb, i) => (
                              <div key={i} className="flex items-center justify-between text-sm">
                                <span className="text-gray-600 truncate max-w-[120px]">{fb.lead_name ?? t('performance.drilldown.lead')}</span>
                                <div className="flex items-center gap-1.5">
                                  {fb.outcome && fb.outcome !== 'geen' && (
                                    <span className={`badge text-xs ${
                                      fb.outcome === 'deal' ? 'badge-green' :
                                      fb.outcome === 'verloren' ? 'badge-red' : 'badge-amber'
                                    }`}>{fb.outcome}</span>
                                  )}
                                  {fb.quality_rating && (
                                    <span className="text-xs text-amber-500">{fb.quality_rating}/5</span>
                                  )}
                                </div>
                              </div>
                            ))}
                            {selectedCallerFeedback.length > 4 && (
                              <div className="text-xs text-gray-400">{t('performance.drilldown.moreItems', { n: selectedCallerFeedback.length - 4 })}</div>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-gray-400">{t('performance.drilldown.noFeedback')}</p>
                        )}
                      </div>
                      <div>
                        <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">{t('performance.drilldown.uploadsLabel')}</div>
                        {(() => {
                          const callerUploads = filteredUploads
                            .filter(u => (u.caller_id ?? u.caller_name) === c.caller_id)
                            .slice(0, 5)
                          if (callerUploads.length === 0) {
                            return <p className="text-xs text-gray-400">{t('performance.drilldown.noUploads')}</p>
                          }
                          return (
                            <div className="space-y-1.5">
                              {callerUploads.map(u => (
                                <a
                                  key={u.id}
                                  href={`/dashboard/upload/${u.id}`}
                                  className="flex items-center justify-between text-sm text-gray-600 hover:text-brand-600 transition-colors group"
                                >
                                  <span className="truncate max-w-[140px]">{u.filename}</span>
                                  <span className="text-xs text-gray-400 group-hover:text-brand-500 ml-2">
                                    {new Date(u.uploaded_at).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })} →
                                  </span>
                                </a>
                              ))}
                              {filteredUploads.filter(u => (u.caller_id ?? u.caller_name) === c.caller_id).length > 5 && (
                                <div className="text-xs text-gray-400">
                                  {t('performance.drilldown.moreUploads', { n: filteredUploads.filter(u => (u.caller_id ?? u.caller_name) === c.caller_id).length - 5 })}
                                </div>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>


      {/* Custom field analytics — alleen bij specifiek project geselecteerd */}
      {selectedProject !== 'alle' && customDefs.length > 0 && customRecords.length > 0 && customAnalysis.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 bg-brand-50 rounded-md flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M2 14L7 9L11 13L14 4M14 4H10M14 4V8" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-900">{t('customFields.title')}</span>
          </div>
          <p className="text-xs text-gray-400 mb-5 ml-8">
            {t('customFields.subtitle')}
          </p>

          <div className="space-y-6">
            {customAnalysis.map(item => {
              if (item.kind === 'category') {
                if (item.data.length === 0) {
                  return (
                    <div key={item.def.key}>
                      <div className="text-sm font-medium text-gray-700 mb-2">{item.def.label}</div>
                      <p className="text-xs text-gray-300">{t('customFields.noData')}</p>
                    </div>
                  )
                }
                return (
                  <div key={item.def.key}>
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="text-sm font-medium text-gray-700">{item.def.label}</div>
                      <div className="flex gap-3 text-xs text-gray-400">
                        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-sm bg-gray-300"/>{t('customFields.allLeads')}</div>
                        <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-sm bg-brand-500"/>{t('customFields.appointments')}</div>
                      </div>
                    </div>
                    <ResponsiveContainer width="100%" height={Math.max(120, item.data.length * 36)}>
                      <BarChart data={item.data} layout="vertical" margin={{ left: 8, right: 40 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} width={140}/>
                        <Tooltip
                          contentStyle={{ fontSize: 12, border: '0.5px solid #e5e7eb', borderRadius: 8, boxShadow: 'none' }}
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          formatter={(value: number, _name: string, props: any) => {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const p = props.payload as { rate?: number }
                            return [`${value} (${p?.rate ?? 0}% conv.)`, _name]
                          }}
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          labelFormatter={(label: string, payload: any[]) => payload?.[0]?.payload?.fullName ?? label}
                        />
                        <Bar dataKey="total"        fill="#d1d5db" radius={[0,3,3,0]} name={t('customFields.allLeads')}/>
                        <Bar dataKey="appointments" fill="#2d4fff" radius={[0,3,3,0]} name={t('customFields.appointments')}/>
                      </BarChart>
                    </ResponsiveContainer>

                    {/* Tekstuele samenvatting onder de chart */}
                    {(() => {
                      const totalAppts = item.data.reduce((s, d) => s + d.appointments, 0)
                      if (totalAppts === 0) return null
                      const byAppts = [...item.data].sort((a, b) => b.appointments - a.appointments)
                      const topByCount = byAppts[0]
                      // Beste conversie (min 3 leads om noise te vermijden)
                      const byRate = [...item.data]
                        .filter(d => d.total >= 3)
                        .sort((a, b) => b.rate - a.rate)
                      const topByRate = byRate[0]
                      return (
                        <div className="mt-2 text-xs text-gray-500 space-y-0.5 leading-relaxed">
                          {topByCount.appointments > 0 && (
                            <div>
                              {t('customFields.topApptHint')}{' '}
                              <strong className="text-gray-700">{topByCount.fullName}</strong>
                              {' '}{t('customFields.totalApptHint', { appts: topByCount.appointments, total: totalAppts, rate: topByCount.rate })}
                            </div>
                          )}
                          {topByRate && topByRate.fullName !== topByCount.fullName && (
                            <div>
                              {t('customFields.bestRate')}{' '}
                              <strong className="text-gray-700">{topByRate.fullName}</strong>
                              {' '}{t('customFields.bestRateValue', { rate: topByRate.rate, n: topByRate.total })}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )
              }

              if (item.kind === 'number') {
                if (item.allCount === 0) {
                  return (
                    <div key={item.def.key}>
                      <div className="text-sm font-medium text-gray-700 mb-2">{item.def.label}</div>
                      <p className="text-xs text-gray-300">{t('customFields.noData')}</p>
                    </div>
                  )
                }
                const fmt = (n: number) => n.toLocaleString('nl-BE', { maximumFractionDigits: 1 })
                const lift = item.avgAll > 0
                  ? Math.round(((item.avgAppt - item.avgAll) / item.avgAll) * 100)
                  : 0
                return (
                  <div key={item.def.key}>
                    <div className="text-sm font-medium text-gray-700 mb-2">{item.def.label}</div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="border border-gray-100 rounded-lg p-3">
                        <div className="text-xs text-gray-400 mb-1">{t('customFields.allLeads')}</div>
                        <div className="text-2xl font-semibold text-gray-900">{fmt(item.sumAll)}</div>
                        <div className="text-xs text-gray-400 mt-0.5">{t('customFields.avgPrefix')} {fmt(item.avgAll)} · n={item.allCount}</div>
                      </div>
                      <div className="border border-brand-200 bg-brand-50 rounded-lg p-3">
                        <div className="text-xs text-brand-600 mb-1">{t('customFields.appointments')}</div>
                        <div className="text-2xl font-semibold text-brand-700">{fmt(item.sumAppt)}</div>
                        <div className="text-xs text-brand-500 mt-0.5">
                          {t('customFields.avgPrefix')} {fmt(item.avgAppt)} · n={item.apptCount}
                          {lift !== 0 && item.apptCount > 0 && (
                            <span className={`ml-1 ${lift > 0 ? 'text-green-600' : 'text-red-500'}`}>
                              ({lift > 0 ? '+' : ''}{lift}%)
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              }

              if (item.kind === 'date') {
                if (item.data.length === 0) {
                  return (
                    <div key={item.def.key}>
                      <div className="text-sm font-medium text-gray-700 mb-2">{item.def.label}</div>
                      <p className="text-xs text-gray-300">{t('customFields.noData')}</p>
                    </div>
                  )
                }
                return (
                  <div key={item.def.key}>
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="text-sm font-medium text-gray-700">{item.def.label}</div>
                      <div className="text-xs text-gray-400">{t('customFields.perWeek')}</div>
                    </div>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={item.data} barGap={2}>
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false}/>
                        <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} width={20}/>
                        <Tooltip contentStyle={{ fontSize: 12, border: '0.5px solid #e5e7eb', borderRadius: 8, boxShadow: 'none' }} cursor={{ fill: '#f9fafb' }}/>
                        <Bar dataKey="total"        fill="#d1d5db" radius={[3,3,0,0]} name={t('customFields.allLeads')}>
                          {item.data.map((_, i) => <Cell key={i} fill="#d1d5db"/>)}
                        </Bar>
                        <Bar dataKey="appointments" fill="#2d4fff" radius={[3,3,0,0]} name={t('customFields.appointments')}/>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )
              }

              // text
              return (
                <div key={item.def.key} className="flex justify-between items-center text-sm">
                  <span className="text-gray-700">{item.def.label}</span>
                  <span className="text-xs text-gray-400">{t('customFields.filledCount', { n: item.count })}</span>
                </div>
              )
            })}
          </div>

          {/* Cross-veld observaties — getallen × categorieën */}
          {customCorrelations.length > 0 && (
            <div className="border-t border-gray-100 pt-4 mt-6">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-3">
                {t('customFields.crossField.title')}
              </div>
              <div className="space-y-1.5">
                {customCorrelations.map((corr, i) => {
                  const top = corr.breakdowns[0]
                  const bottom = corr.breakdowns[corr.breakdowns.length - 1]
                  const fmt = (n: number) => n.toLocaleString('nl-BE', { maximumFractionDigits: 0 })
                  return (
                    <div key={i} className="text-sm text-gray-600 leading-relaxed">
                      {t('customFields.crossField.highest')} <strong className="text-gray-800">{corr.numberDef.label}</strong>:{' '}
                      <strong className="text-gray-800">{corr.categoryDef.label} = {top.category}</strong>
                      {' '}<span className="text-gray-400">({fmt(top.avg)}, n={top.n})</span>
                      {bottom && bottom.category !== top.category && (
                        <span className="text-gray-400">
                          {' '}· {t('customFields.crossField.lowest')} <strong className="text-gray-700">{bottom.category}</strong>
                          {' '}({fmt(bottom.avg)}, n={bottom.n})
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* AI inzichten over custom velden — samengevoegd over alle uploads van het project */}
      {selectedProject !== 'alle' && dedupedCustomInsights.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-6 h-6 bg-brand-50 rounded-md flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4.5 4.5l2 2M9.5 9.5l2 2M4.5 11.5l2-2M9.5 6.5l2-2" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-900">{t('customInsights.title')}</span>
            <span className="badge badge-blue ml-auto">{t('customInsights.aiDetected')}</span>
          </div>
          <div className="space-y-3">
            {(() => {
              const labelsByKey = new Map(customDefs.map(d => [d.key, d.label]))
              return dedupedCustomInsights.map((insight, i) => {
                const fieldLabels = (insight.field_keys ?? [])
                  .map(k => labelsByKey.get(k) ?? k)
                  .join(' + ')
                return (
                  <div key={i} className="border-l-2 border-brand-300 pl-3 py-1">
                    <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">{insight.headline}</span>
                      {fieldLabels && (
                        <span className="text-xs text-gray-400">— {fieldLabels}</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600 leading-relaxed">{insight.detail}</p>
                  </div>
                )
              })
            })()}
          </div>
        </div>
      )}


      {/* AI Inzichten */}
      {aiInsights.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <div className="w-6 h-6 bg-amber-50 rounded-md flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="#d97706" strokeWidth="1.5"/>
                <path d="M8 5v4M8 11v.5" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-sm font-medium text-gray-900">{t('objections.title')}</span>
            <span className="badge badge-amber">{t('objections.aiDetected')}</span>
            {selectedProject !== 'alle' && (
              <button
                onClick={handleReanalyse}
                disabled={reanalysing}
                className="ml-auto text-xs px-2.5 py-1 rounded-md border border-gray-200 text-gray-600 hover:border-brand-300 hover:text-brand-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Run GPT opnieuw op alle uploads van dit project"
              >
                {reanalysing ? t('objections.reanalysing') : `🔄 ${t('objections.reanalyse')}`}
              </button>
            )}
          </div>
          {reanalyseMsg && (
            <div className={`mb-3 px-3 py-2 rounded-md text-xs ${
              reanalyseMsg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {reanalyseMsg.text}
            </div>
          )}
          {/* Mobile-friendly: label stackt boven de bar op smalle schermen
              (<640px) zodat de percentages en counts niet meer overlappen
              met een truncated label. Vanaf sm+ side-by-side zoals voordien. */}
          <div className="space-y-3">
            {aiInsights.map(obj => (
              <div key={obj.label} className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
                <div className="w-full sm:w-32 text-sm text-gray-700 sm:text-gray-600 sm:flex-shrink-0 break-words">
                  {obj.label}
                </div>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-amber-400" style={{ width: `${obj.pct}%` }}/>
                  </div>
                  <div className="text-xs font-medium text-gray-700 w-9 text-right flex-shrink-0">{obj.pct}%</div>
                  <div className="text-xs text-gray-400 w-10 text-right flex-shrink-0">{obj.count}×</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-3">
            {t('objections.footer')}
          </p>
        </div>
      )}

      {callerStats.length === 0 && (
        <div className="card p-12 text-center">
          <p className="text-sm text-gray-400">
            {t('noCallersEmpty')}
          </p>
        </div>
      )}

      {/* Tijd & kost-metrics — alleen wanneer één specifiek project gefilterd is
          en er tarieven ingesteld zijn op dat project. Anders rendert hij niets.
          fromIso = sentinel '2020-01-01' bij "alle" → wordt door de helper
          geclampt naar project.created_at zodat we niet jaren terug presets
          extrapoleren. */}
      {/* Wacht tot dateRange effectief gezet is voor we de widget renderen.
          Anders schiet ie eerst een "all-time"-fetch af met sentinel-datums
          (traag), dan een tweede fetch met de echte maand — die kunnen in
          race gaan en dan zie je "alle uren" ipv "deze maand". */}
      {selectedProject !== 'alle' && dateRange.from && dateRange.to && (
        <div className="mt-5">
          <CostMetricsForProject
            projectId={selectedProject}
            fromIso={dateRange.from.toISOString()}
            toIso={dateRange.to.toISOString()}
          />
        </div>
      )}
    </div>
  )
}

// Chart-helpers staan nu in @/lib/team-charts (gedeeld met server-rapport).
