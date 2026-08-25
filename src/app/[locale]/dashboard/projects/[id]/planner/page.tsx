'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations, useLocale } from 'next-intl'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/client'
import type { Profile, LeadPool } from '@/types/database'
import { isPlannerProject } from '@/lib/feature-flags'

type Role = 'cc_manager' | 'sales_manager' | 'cold_caller' | 'sales_rep'

export default function PlannerPage() {
  const t = useTranslations('dashboard.planner')
  const locale = useLocale()
  const bcp47 = locale === 'nl' ? 'nl-BE' : locale
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string

  const [profile, setProfile] = useState<Profile | null>(null)
  const [projectName, setProjectName] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const [{ data: prof }, { data: proj }] = await Promise.all([
        sb.from('profiles').select('*').eq('id', user.id).single(),
        sb.from('projects').select('id, name').eq('id', projectId).single(),
      ])
      // Feature-flag: planner is private-beta. Wie via een directe URL op
      // /dashboard/projects/<id>/planner van een niet-whitelisted project
      // belandt, stuur door naar de project-overzichtspagina.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projRow = proj as any
      if (!projRow || !isPlannerProject({ id: projRow.id, name: projRow.name })) {
        router.replace('/dashboard/projects')
        return
      }
      setProfile(prof as Profile | null)
      setProjectName((projRow.name as string | null) ?? '')
      setLoading(false)
    })
  }, [projectId, router])

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>
  if (!profile) return null

  const role = profile.role as Role
  // Wie kan WAT op de planner-pagina?
  //   - canUpload  = uploadt leads + ziet lead-tabel.
  //     → cc_manager (beheert lijsten) + sales_manager (RestoManager-stijl
  //       freelancer die zelf z'n leadlists aanlevert).
  //   - canSearch  = zoekt leads + boekt slots voor zichzelf of z'n team.
  //     → cold_caller (klassiek) + sales_rep (rep die zelf prospecteert) +
  //       sales_manager (ook actief in verkoop, niet alleen administratief).
  // Sales_manager krijgt dus BEIDE blokken op één pagina — eerst upload,
  // daaronder de zoek-flow. Zo kan een freelance manager die zelf belt
  // alles vanuit dezelfde tab doen.
  const canUpload = role === 'cc_manager'  || role === 'sales_manager'
  const canSearch = role === 'cold_caller' || role === 'sales_manager' || role === 'sales_rep'

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <Link href={`/dashboard/projects`} className="text-sm text-gray-400 hover:text-gray-600 inline-flex items-center gap-1.5 mb-3">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('backToProjects')}
        </Link>
        <h1 className="text-2xl font-semibold text-gray-900">
          {t('title')}
          {projectName && <span className="text-gray-400 font-normal"> — {projectName}</span>}
        </h1>
        <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
      </div>

      {/* Digest-knop staat los van Upload/ColdCaller-blokken zodat élke rol
          op de planner (manager + cold caller + rep) 'm kan triggeren —
          typisch end-of-day actie. Cron stuurt 'm anyway om 17u, maar je
          kan 'm ook tussendoor versturen. */}
      {(canUpload || canSearch) && <DigestCard projectId={projectId} />}

      {canUpload && <ManagerView projectId={projectId} bcp47={bcp47} />}
      {/* Sales_manager die ook als rep werkt: tussenkop zodat beide blokken
          visueel gescheiden zijn en hij niet denkt dat 'Zoek lead' bij de
          upload hoort. */}
      {canUpload && canSearch && (
        <div className="border-t border-gray-100 pt-6 mt-2 mb-4">
          <div className="text-xs uppercase tracking-wide text-gray-400 font-medium">
            {t('sectionDivider')}
          </div>
        </div>
      )}
      {canSearch && <ColdCallerView projectId={projectId} bcp47={bcp47} />}
      {!canUpload && !canSearch && (
        <div className="card p-8 text-center text-sm text-gray-400">
          {t('roleNotAllowed')}
        </div>
      )}
    </div>
  )
}

// ─── Manager view: upload + leads-tabel ─────────────────────────────────────

function ManagerView({ projectId, bcp47 }: { projectId: string; bcp47: string }) {
  const t = useTranslations('dashboard.planner')
  const [leads, setLeads]         = useState<LeadPool[]>([])
  const [totalLeads, setTotalLeads] = useState<number>(0)

  // Upload-wizard state: file → mapping → upload.
  type RowMap = Record<string, string>
  type Step = 'file' | 'mapping'
  const [step, setStep]               = useState<Step>('file')
  const [file, setFile]               = useState<File | null>(null)
  const [rawData, setRawData]         = useState<RowMap[]>([])
  const [columns, setColumns]         = useState<string[]>([])
  const [nameCol, setNameCol]         = useState<string>('')
  const [addressCol, setAddressCol]   = useState<string>('')
  const [parseError, setParseError]   = useState<string | null>(null)
  const [dragging, setDragging]       = useState(false)
  const [uploading, setUploading]     = useState(false)
  const [uploadMsg, setUploadMsg]     = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  // Preview-tabel toont alleen de 100 meest-recente leads (anders trekt
  // de browser bij elke refresh duizenden rijen) — het echte totaal komt
  // via een aparte HEAD-count zodat de header-badge accuraat blijft.
  const PREVIEW_LIMIT = 100

  const loadLeads = useCallback(async () => {
    const sb = createClient()
    const [{ data }, { count }] = await Promise.all([
      sb.from('lead_pool')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(PREVIEW_LIMIT),
      sb.from('lead_pool')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId),
    ])
    setLeads((data ?? []) as LeadPool[])
    setTotalLeads(count ?? 0)
  }, [projectId])

  useEffect(() => { loadLeads() }, [loadLeads])

  // Auto-detectie van kolomnamen — als 'naam'/'name'/'company'/'business'
  // in een header voorkomt, mappen we automatisch. Spaart de manager een klik.
  function autoDetectMapping(cols: string[]) {
    const lower = cols.map(c => c.toLowerCase())
    const nameIdx = lower.findIndex(c =>
      /^(naam|name|company|bedrijf|business|zaak|restaurant|klant|account)/.test(c),
    )
    const addrIdx = lower.findIndex(c =>
      /^(adres|address|straat|location|locatie|street)/.test(c),
    )
    if (nameIdx >= 0) setNameCol(cols[nameIdx])
    if (addrIdx >= 0) setAddressCol(cols[addrIdx])
  }

  function parseFile(f: File) {
    setParseError(null)
    setUploadMsg(null)
    const ext = f.name.split('.').pop()?.toLowerCase()

    if (ext === 'csv') {
      Papa.parse<RowMap>(f, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          const data = result.data
          if (data.length === 0) {
            setParseError(t('manager.fileEmpty'))
            return
          }
          setRawData(data)
          const cols = Object.keys(data[0] ?? {}).filter(c => c)
          setColumns(cols)
          autoDetectMapping(cols)
          setStep('mapping')
        },
        error: () => setParseError(t('manager.csvReadFailed')),
      })
    } else if (ext === 'xlsx' || ext === 'xls') {
      const reader = new FileReader()
      reader.onload = (e) => {
        try {
          const workbook = XLSX.read(e.target?.result, { type: 'binary' })
          const sheet = workbook.Sheets[workbook.SheetNames[0]]
          const data  = XLSX.utils.sheet_to_json<RowMap>(sheet, { defval: '' })
          if (data.length === 0) {
            setParseError(t('manager.fileEmpty'))
            return
          }
          setRawData(data)
          const cols = Object.keys(data[0] ?? {}).filter(c => c)
          setColumns(cols)
          autoDetectMapping(cols)
          setStep('mapping')
        } catch {
          setParseError(t('manager.excelReadFailed'))
        }
      }
      reader.readAsBinaryString(f)
    } else {
      setParseError(t('manager.unsupportedFile'))
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) { setFile(f); parseFile(f) }
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) { setFile(f); parseFile(f) }
  }

  function resetWizard() {
    setStep('file')
    setFile(null)
    setRawData([])
    setColumns([])
    setNameCol('')
    setAddressCol('')
    setParseError(null)
  }

  // Mapping → array van geldige leads. Lege namen/adressen overslaan.
  function buildLeads(): { business_name: string; address: string }[] {
    if (!nameCol || !addressCol) return []
    return rawData
      .map(r => ({
        business_name: String(r[nameCol]    ?? '').trim(),
        address:       String(r[addressCol] ?? '').trim(),
      }))
      .filter(l => l.business_name && l.address)
  }

  const previewLeads = step === 'mapping' ? buildLeads() : []

  async function handleUpload() {
    const leads = buildLeads()
    if (leads.length === 0) return
    setUploading(true)
    setUploadMsg(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/lead-pool/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leads }),
      })
      const data = await res.json()
      if (!res.ok) {
        setUploadMsg({ type: 'error', text: data.error ?? t('manager.uploadFailed') })
      } else {
        setUploadMsg({
          type: 'ok',
          text: t('manager.uploadSuccess', {
            inserted: data.inserted,
            ok:       data.geocoded_ok,
            failed:   data.geocoded_failed,
          }),
        })
        resetWizard()
        await loadLeads()
      }
    } catch (e) {
      setUploadMsg({ type: 'error', text: e instanceof Error ? e.message : t('manager.uploadFailed') })
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
      <div className="card p-5 mb-5">
        <div className="text-sm font-medium text-gray-900 mb-1">{t('manager.uploadTitle')}</div>
        <p className="text-xs text-gray-500 mb-3">{t('manager.uploadHint')}</p>

        {step === 'file' && (
          <>
            <label
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`block border-2 border-dashed rounded-lg px-6 py-10 text-center cursor-pointer transition-colors ${
                dragging
                  ? 'border-brand-400 bg-brand-50'
                  : 'border-gray-200 hover:border-brand-300 hover:bg-gray-50'
              }`}
            >
              <svg width="32" height="32" viewBox="0 0 16 16" fill="none" className="mx-auto mb-2 text-gray-400">
                <path d="M8 10V3M8 3L5 6M8 3L11 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M3 11V13H13V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <div className="text-sm font-medium text-gray-700">{t('manager.dropTitle')}</div>
              <div className="text-xs text-gray-400 mt-1">{t('manager.dropSubtitle')}</div>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileInput}
                className="hidden"
              />
            </label>
            {parseError && (
              <p className="mt-3 text-sm text-red-700 bg-red-50 px-3 py-2 rounded-lg">{parseError}</p>
            )}
          </>
        )}

        {step === 'mapping' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
              <div className="text-gray-500">
                <span className="font-medium text-gray-700">{file?.name}</span>
                <span className="text-gray-400 ml-1.5">· {t('manager.rowsDetected', { count: rawData.length })}</span>
              </div>
              <button
                onClick={resetWizard}
                className="text-brand-600 hover:underline"
              >
                {t('manager.chooseOtherFile')}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('manager.mapName')}</label>
                <select
                  value={nameCol}
                  onChange={e => setNameCol(e.target.value)}
                  className="input"
                >
                  <option value="">— {t('manager.choose')} —</option>
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('manager.mapAddress')}</label>
                <select
                  value={addressCol}
                  onChange={e => setAddressCol(e.target.value)}
                  className="input"
                >
                  <option value="">— {t('manager.choose')} —</option>
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {nameCol && addressCol && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-2">{t('manager.previewTitle')}</div>
                <div className="bg-gray-50 border border-gray-100 rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-200 bg-white">
                        <th className="text-left px-3 py-2 font-medium">{t('manager.colName')}</th>
                        <th className="text-left px-3 py-2 font-medium">{t('manager.colAddress')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewLeads.slice(0, 5).map((l, i) => (
                        <tr key={i} className="border-b border-gray-100 last:border-0">
                          <td className="px-3 py-2 text-gray-900 truncate max-w-[260px]">{l.business_name}</td>
                          <td className="px-3 py-2 text-gray-600 truncate max-w-[400px]">{l.address}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-gray-400">
                {t('manager.previewCount', { count: previewLeads.length })}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={resetWizard}
                  disabled={uploading}
                  className="btn-secondary text-sm"
                >
                  {t('manager.cancel')}
                </button>
                <button
                  onClick={handleUpload}
                  disabled={uploading || previewLeads.length === 0}
                  className="btn-primary text-sm"
                >
                  {uploading ? t('manager.uploading') : t('manager.uploadButton')}
                </button>
              </div>
            </div>
          </div>
        )}

        {uploadMsg && (
          <div className={`mt-3 px-3 py-2 rounded-lg text-sm ${
            uploadMsg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            {uploadMsg.text}
          </div>
        )}
      </div>

      <div className="card p-5 mb-5">
        <div className="text-sm font-medium text-gray-900 mb-3 flex items-center justify-between gap-2">
          <span>
            {t('manager.leadsTitle')} <span className="text-gray-400 font-normal">({totalLeads})</span>
          </span>
          {totalLeads > PREVIEW_LIMIT && (
            <span className="text-xs text-gray-400 font-normal">
              {t('manager.leadsPreviewHint', { shown: PREVIEW_LIMIT, total: totalLeads })}
            </span>
          )}
        </div>
        {totalLeads === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">{t('manager.leadsEmpty')}</p>
        ) : (
          <div className="space-y-1">
            {leads.map(l => (
              <div key={l.id} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{l.business_name}</div>
                  <div className="text-xs text-gray-400 truncate">{l.address}</div>
                </div>
                {l.province && (
                  <span className="text-xs text-gray-500 capitalize">{l.province.replace(/-/g, ' ')}</span>
                )}
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {new Date(l.created_at).toLocaleDateString(bcp47, { day: 'numeric', month: 'short' })}
                </span>
                <StatusBadge lead={l} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

// Eind-van-de-dag digest: stuurt alle vandaag-geboekte afspraken via mail
// door naar de juiste sales reps. Loopt ook automatisch om 17u Brussel via
// /api/cron/daily-appointments-digest — deze knop is voor managers die niet
// willen wachten, of voor een hertrigger als er na 17u nog iets bij komt.
function DigestCard({ projectId }: { projectId: string }) {
  const t = useTranslations('dashboard.planner.digest')
  const [sending, setSending] = useState(false)
  const [result, setResult]   = useState<
    | { type: 'ok'; repsNotified: number; appointments: number }
    | { type: 'error'; message: string }
    | null
  >(null)

  async function handleSend() {
    setSending(true)
    setResult(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/appointments/send-daily-digest`, {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) {
        setResult({ type: 'error', message: json.error ?? t('errorGeneric') })
      } else if ((json.appointments ?? 0) === 0) {
        setResult({ type: 'ok', repsNotified: 0, appointments: 0 })
      } else {
        setResult({
          type: 'ok',
          repsNotified: json.repsNotified ?? 0,
          appointments: json.appointments ?? 0,
        })
      }
    } catch (e) {
      setResult({ type: 'error', message: e instanceof Error ? e.message : t('errorGeneric') })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900">{t('title')}</div>
          <div className="text-xs text-gray-500 mt-1 max-w-md">{t('hint')}</div>
        </div>
        <button
          onClick={handleSend}
          disabled={sending}
          className="btn-primary text-sm disabled:opacity-50 whitespace-nowrap"
        >
          {sending ? t('sending') : t('sendNow')}
        </button>
      </div>
      {result && (
        <div className={`mt-3 px-3 py-2 rounded-lg text-sm ${
          result.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          {result.type === 'ok'
            ? result.appointments === 0
              ? t('noAppointmentsToday')
              : t('sentSuccess', { reps: result.repsNotified, appointments: result.appointments })
            : result.message}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ lead }: { lead: LeadPool }) {
  const t = useTranslations('dashboard.planner.statusBadge')
  if (lead.status === 'booked')             return <span className="badge badge-green text-xs">{t('booked')}</span>
  if (lead.status === 'archived')           return <span className="badge badge-gray text-xs">{t('archived')}</span>
  if (lead.geocode_status === 'pending')    return <span className="badge badge-amber text-xs">{t('pending')}</span>
  if (lead.geocode_status === 'failed')     return <span className="badge badge-red text-xs" title={lead.geocode_error ?? ''}>{t('failed')}</span>
  return <span className="badge badge-blue text-xs">{t('ready')}</span>
}

// ─── Cold caller view: zoek + slot voorstellen ──────────────────────────────

type SearchResult = {
  id: string; business_name: string; address: string
  postal_code: string | null; city: string | null; province: string | null
}

type SlotProposal = {
  sales_rep_id: string; sales_rep_name: string; sales_rep_email: string | null
  start: string; end: string; province: string; match_reason: string
}

function ColdCallerView({ projectId, bcp47 }: { projectId: string; bcp47: string }) {
  const t = useTranslations('dashboard.planner')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<SearchResult | null>(null)
  const [slots, setSlots] = useState<SlotProposal[] | null>(null)
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [missingScopeReps, setMissingScopeReps] = useState<string[]>([])
  const [bookingSlot, setBookingSlot] = useState<SlotProposal | null>(null)

  // Debounced search
  useEffect(() => {
    const handle = setTimeout(async () => {
      if (q.trim().length < 2) { setResults([]); return }
      setSearching(true)
      try {
        const res = await fetch(`/api/projects/${projectId}/lead-pool/search?q=${encodeURIComponent(q.trim())}&limit=12`)
        const data = await res.json()
        if (res.ok) setResults(data.leads ?? [])
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => clearTimeout(handle)
  }, [q, projectId])

  async function loadSlots(lead: SearchResult) {
    setSelected(lead)
    setSlots(null)
    setSlotsError(null)
    setSlotsLoading(true)
    setResults([])    // dropdown sluiten
    setQ(lead.business_name)
    try {
      const res = await fetch(`/api/projects/${projectId}/appointments/find-slots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: lead.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSlotsError(data.error ?? t('coldCaller.slotsError'))
        return
      }
      setSlots(data.slots ?? [])
      setMissingScopeReps(data.reps_missing_calendar_scope ?? [])
    } catch (e) {
      setSlotsError(e instanceof Error ? e.message : t('coldCaller.slotsError'))
    } finally {
      setSlotsLoading(false)
    }
  }

  return (
    <>
      <div className="card p-5 mb-5">
        <div className="text-sm font-medium text-gray-900 mb-3">{t('coldCaller.searchTitle')}</div>
        <div className="relative">
          <input
            type="text"
            value={q}
            onChange={e => { setQ(e.target.value); setSelected(null); setSlots(null); setSlotsError(null) }}
            placeholder={t('coldCaller.searchPlaceholder')}
            className="input"
            autoFocus
          />
          {searching && <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">{t('coldCaller.searching')}</div>}
          {results.length > 0 && !selected && (
            <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-y-auto">
              {results.map(r => (
                <button
                  key={r.id}
                  onClick={() => loadSlots(r)}
                  className="w-full text-left px-3 py-2 hover:bg-brand-50 border-b border-gray-50 last:border-0"
                >
                  <div className="text-sm font-medium text-gray-900">{r.business_name}</div>
                  <div className="text-xs text-gray-400 truncate">
                    {r.address}
                    {r.province && <span className="text-gray-500 ml-2 capitalize">· {r.province.replace(/-/g, ' ')}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        {q.trim().length >= 2 && !searching && results.length === 0 && !selected && (
          <p className="text-xs text-gray-400 mt-2">{t('coldCaller.noResults')}</p>
        )}
      </div>

      {slotsLoading && (
        <div className="card p-8 text-center text-sm text-gray-400">{t('coldCaller.findingSlots')}</div>
      )}

      {slotsError && (
        <div className="card p-4 mb-5 bg-red-50 border-red-100">
          <p className="text-sm text-red-700">{slotsError}</p>
        </div>
      )}

      {missingScopeReps.length > 0 && (
        <div className="card p-4 mb-5 bg-amber-50 border-amber-100">
          <p className="text-sm text-amber-800">{t('coldCaller.scopeWarning', { count: missingScopeReps.length })}</p>
        </div>
      )}

      {slots && selected && slots.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-sm text-gray-500">{t('coldCaller.noSlots')}</p>
          <p className="text-xs text-gray-400 mt-2">{t('coldCaller.noSlotsHint', { province: selected.province?.replace(/-/g, ' ') ?? '' })}</p>
        </div>
      )}

      {slots && slots.length > 0 && selected && (
        <div className="card p-5 mb-5">
          <div className="text-sm font-medium text-gray-900 mb-1">{t('coldCaller.slotsTitle')}</div>
          <p className="text-xs text-gray-500 mb-4">{t('coldCaller.slotsSubtitle')}</p>
          <div className="space-y-2">
            {slots.map((slot, i) => (
              <button
                key={i}
                onClick={() => setBookingSlot(slot)}
                className="w-full text-left p-3 rounded-lg border border-gray-200 hover:border-brand-300 hover:bg-brand-50 transition-colors"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900">
                      {new Date(slot.start).toLocaleDateString(bcp47, { weekday: 'long', day: 'numeric', month: 'long' })}
                    </div>
                    <div className="text-sm text-gray-600">
                      {new Date(slot.start).toLocaleTimeString(bcp47, { hour: '2-digit', minute: '2-digit' })}
                      {' – '}
                      {new Date(slot.end).toLocaleTimeString(bcp47, { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div className="text-xs text-gray-400 mt-1">{slot.match_reason}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">{slot.sales_rep_name}</div>
                    {slot.sales_rep_email && <div className="text-xs text-gray-400">{slot.sales_rep_email}</div>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {bookingSlot && selected && (
        <BookModal
          projectId={projectId}
          lead={selected}
          slot={bookingSlot}
          bcp47={bcp47}
          onClose={() => setBookingSlot(null)}
          onBooked={() => {
            setBookingSlot(null)
            setSelected(null)
            setSlots(null)
            setQ('')
          }}
        />
      )}
    </>
  )
}

// ─── Boek-modal ─────────────────────────────────────────────────────────────

function BookModal({
  projectId, lead, slot, bcp47, onClose, onBooked,
}: {
  projectId: string
  lead: SearchResult
  slot: SlotProposal
  bcp47: string
  onClose: () => void
  onBooked: () => void
}) {
  const t = useTranslations('dashboard.planner.book')
  const [notes, setNotes] = useState('')
  const [booking, setBooking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleBook() {
    setBooking(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/appointments/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id:      lead.id,
          sales_rep_id: slot.sales_rep_id,
          start:        slot.start,
          end:          slot.end,
          notes:        notes.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('failed'))
        return
      }
      onBooked()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('failed'))
    } finally {
      setBooking(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <h2 className="font-semibold text-gray-900 mb-1">{t('title')}</h2>
        <p className="text-sm text-gray-500 mb-4">
          {lead.business_name} · {slot.sales_rep_name}
        </p>

        <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-4">
          <div className="text-sm font-medium text-gray-900">
            {new Date(slot.start).toLocaleDateString(bcp47, { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <div className="text-sm text-gray-700">
            {new Date(slot.start).toLocaleTimeString(bcp47, { hour: '2-digit', minute: '2-digit' })}
            {' – '}
            {new Date(slot.end).toLocaleTimeString(bcp47, { hour: '2-digit', minute: '2-digit' })}
          </div>
          <div className="text-xs text-gray-500 mt-1">{lead.address}</div>
        </div>

        <label className="block text-sm font-medium text-gray-700 mb-1">{t('notesLabel')}</label>
        <p className="text-xs text-gray-500 mb-2">{t('notesHint')}</p>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={4}
          placeholder={t('notesPlaceholder')}
          className="input resize-none mb-3"
        />

        {error && (
          <p className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded-lg mb-3">{error}</p>
        )}

        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary flex-1" disabled={booking}>
            {t('cancel')}
          </button>
          <button onClick={handleBook} disabled={booking} className="btn-primary flex-1">
            {booking ? t('booking') : t('confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
