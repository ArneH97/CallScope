'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { AppointmentStatus, Outcome, AppointmentWithFeedback, Profile } from '@/types/database'
import ProjectFilter from '@/components/ui/ProjectFilter'

type Appointment = AppointmentWithFeedback
type FilterKey = 'alle' | 'geen_feedback' | 'afgesloten'

// Color-mapping blijft hardcoded (CSS classes), labels worden via i18n geresolved.
const STATUS_COLORS: Record<AppointmentStatus, string> = {
  gepland:     'badge-blue',
  uitgevoerd:  'badge-green',
  no_show:     'badge-red',
  geannuleerd: 'badge-gray',
}
const STATUS_VALUES: AppointmentStatus[] = ['gepland', 'uitgevoerd', 'no_show', 'geannuleerd']
const OUTCOME_VALUES: Outcome[] = ['geen', 'offerte', 'deal', 'follow_up', 'verloren']

/** Formatteert een ISO-timestamp (of null) naar "YYYY-MM-DD" zoals
    <input type="date"> verwacht. Gebruikt local timezone zodat wat je
    ziet in de badge matcht met wat er in de picker staat. */
function toDateInputString(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function AppointmentsPage() {
  const t = useTranslations('dashboard.appointments')
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<Profile | null>(null)
  // Sales managers willen standaard álles zien (om te kunnen herzien); anderen
  // krijgen 'Te beoordelen' als startpunt om snel hun werk-todo te zien.
  const [filter, setFilter] = useState<FilterKey>('geen_feedback')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [selectedProject, setSelectedProject] = useState<string>('alle')
  // Per project: lijst beschikbare sales reps (rol sales_rep of sales_manager).
  // Wordt door cc/sales managers gebruikt om handmatig toe te wijzen wanneer
  // sync de naam niet kon resolven of het sheet-veld leeg was.
  const [salesRepsByProject, setSalesRepsByProject] = useState<Map<string, { id: string; name: string }[]>>(new Map())

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: p } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    setProfile(p)

    // Sales managers krijgen 'Alle' als default-filter — zij overzien én
    // kunnen feedback aanpassen, dus moeten alles zien.
    if (p?.role === 'sales_manager') {
      setFilter(prev => prev === 'geen_feedback' ? 'alle' : prev)
    }

    const { data } = await supabase
      .from('appointments_with_feedback')
      .select('*')
      .order('call_date', { ascending: false })
      .returns<Appointment[]>()

    const list: Appointment[] = data ?? []
    setAppointments(list)

    // Projecten ophalen — alle relevante projecten op basis van de afspraken,
    // aangevuld met expliciete project-koppelingen via project_members.
    type ProjectRow = { id: string; name: string }
    const projectMap = new Map<string, string>()

    // Probeer eerst expliciete project-naam-lookups (1 query, alle ids).
    const projectIds = Array.from(new Set(list.map(a => a.project_id).filter(Boolean)))
    if (projectIds.length > 0) {
      const { data: pdata } = await supabase
        .from('projects')
        .select('id, name')
        .in('id', projectIds)
        .returns<ProjectRow[]>()
      for (const p of (pdata ?? [])) projectMap.set(p.id, p.name)
    }

    setProjects(Array.from(projectMap.entries()).map(([id, name]) => ({ id, name })))

    // Sales reps per project ophalen — voor de "wijs toe" dropdown bij
    // afspraken zonder sales_rep_id. Alleen relevant voor cc/sales managers.
    if ((p?.role === 'cc_manager' || p?.role === 'sales_manager') && projectIds.length > 0) {
      type RepRow = {
        project_id: string
        profile_id: string
        role: string
        profiles: { full_name: string } | { full_name: string }[] | null
      }
      const { data: pms } = await supabase
        .from('project_members')
        .select('project_id, profile_id, role, profiles(full_name)')
        .in('project_id', projectIds)
        .in('role', ['sales_rep', 'sales_manager'])
        .returns<RepRow[]>()

      const map = new Map<string, { id: string; name: string }[]>()
      for (const row of (pms ?? [])) {
        const profileObj = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles
        const name = profileObj?.full_name ?? 'Onbekend'
        const list = map.get(row.project_id) ?? []
        if (!list.some(r => r.id === row.profile_id)) {
          list.push({ id: row.profile_id, name })
        }
        map.set(row.project_id, list)
      }
      setSalesRepsByProject(map)
    }

    setLoading(false)
  }

  /** Wordt door AppointmentCard aangeroepen na manuele toewijzing. */
  async function handleManualAssign(callRecordId: string, salesRepId: string) {
    const supabase = createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc('assign_sales_rep_to_call_record', {
      p_call_record_id: callRecordId,
      p_sales_rep_id:   salesRepId,
    })
    if (error) {
      alert(t('errors.assignFailed', { msg: error.message }))
      return
    }
    await loadData()
  }

  const isSales = profile?.role === 'sales_rep' || profile?.role === 'sales_manager'
  const isColdCaller = profile?.role === 'cold_caller'
  // Sales rep ziet enkel afspraken die op hem/haar staan toegewezen — via de
  // sheet-sync wordt de sales_rep_id automatisch op appointment_feedback gezet.
  // Cold caller ziet enkel afspraken die HIJ heeft gegenereerd (caller_id) —
  // zo ziet hij de feedback-loop: wat is er gebeurd met de afspraken die ik
  // heb gemaakt? Sales managers en cc managers krijgen het volledige beeld.
  const isOwnRepOnly      = profile?.role === 'sales_rep'
  const isOwnCallerOnly   = isColdCaller
  const canAssignReps     = profile?.role === 'cc_manager' || profile?.role === 'sales_manager'
  const canEditFeedback   = isSales || profile?.role === 'cc_manager'  // cold caller leest enkel

  const visibleToUser = (a: Appointment) => {
    if (isOwnRepOnly)    return a.sales_rep_id === profile?.id
    if (isOwnCallerOnly) return a.caller_id    === profile?.id
    return true
  }

  const filtered = appointments.filter((a: Appointment) => {
    if (!visibleToUser(a)) return false
    if (selectedProject !== 'alle' && a.project_id !== selectedProject) return false
    if (filter === 'geen_feedback') return !a.appointment_status || a.appointment_status === 'gepland'
    if (filter === 'afgesloten') return ['uitgevoerd', 'no_show', 'geannuleerd'].includes(a.appointment_status ?? '')
    return true
  })

  const pendingCount = appointments.filter((a: Appointment) => {
    if (!visibleToUser(a)) return false
    if (selectedProject !== 'alle' && a.project_id !== selectedProject) return false
    return !a.appointment_status || a.appointment_status === 'gepland'
  }).length

  // Niet-toegewezen afspraken: alleen relevant voor cc/sales manager.
  // Telt afspraken zonder sales_rep_id binnen de gekozen projectfilter.
  const unassignedCount = canAssignReps
    ? appointments.filter((a: Appointment) => {
        if (selectedProject !== 'alle' && a.project_id !== selectedProject) return false
        return !a.sales_rep_id
      }).length
    : 0

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {isSales ? t('subtitleSales') : t('subtitleManager')}
        </p>
      </div>

      {/* Banner: niet-toegewezen afspraken (alleen managers) */}
      {canAssignReps && unassignedCount > 0 && (
        <div className="card p-4 mb-5 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.5L1.5 13.5h13L8 1.5z" stroke="#d97706" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M8 6v3M8 11.5v.5" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-amber-900">
                {t('banner.title', { count: unassignedCount })}
              </div>
              <p className="text-xs text-amber-700 mt-0.5 leading-relaxed">
                {t('banner.body')}
                {' '}<Link href={selectedProject !== 'alle' ? `/dashboard/projects/${selectedProject}/settings` : '/dashboard/projects'} className="underline font-medium">{t('banner.bodyLink')}</Link>{' '}
                {t('banner.bodyAfter')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Filters: status tabs + project dropdown */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
          {([
            { key: 'geen_feedback', label: t('filters.toReview') },
            { key: 'alle',          label: t('filters.all') },
            { key: 'afgesloten',    label: t('filters.closed') },
          ] as { key: FilterKey; label: string }[]).map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                filter === f.key
                  ? 'bg-white text-gray-900 font-medium shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {f.label}
              {f.key === 'geen_feedback' && pendingCount > 0 && (
                <span className="ml-1.5 bg-brand-100 text-brand-700 text-xs px-1.5 py-0.5 rounded-full">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <ProjectFilter
          projects={projects}
          value={selectedProject}
          onChange={setSelectedProject}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="card p-8 sm:p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-brand-50 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="4" width="18" height="17" rx="2" stroke="#1a35e6" strokeWidth="1.5"/>
              <path d="M8 2v4M16 2v4M3 10h18" stroke="#1a35e6" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          {filter === 'geen_feedback' ? (
            <>
              <h3 className="text-base font-semibold text-gray-900 mb-1.5">{t('empty.allDone.title')}</h3>
              <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">{t('empty.allDone.body')}</p>
            </>
          ) : isOwnRepOnly ? (
            <>
              <h3 className="text-base font-semibold text-gray-900 mb-1.5">{t('empty.noneForRep.title')}</h3>
              <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">{t('empty.noneForRep.body')}</p>
            </>
          ) : isOwnCallerOnly ? (
            <>
              <h3 className="text-base font-semibold text-gray-900 mb-1.5">{t('empty.noneForCaller.title')}</h3>
              <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">{t('empty.noneForCaller.body')}</p>
            </>
          ) : (
            <>
              <h3 className="text-base font-semibold text-gray-900 mb-1.5">{t('empty.noneGeneric.title')}</h3>
              <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">{t('empty.noneGeneric.body')}</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((appt: Appointment) => (
            <AppointmentCard
              key={appt.call_record_id}
              appointment={appt}
              isSales={isSales}
              canAssignReps={canAssignReps}
              /* Wie mag "geen afspraak" markeren? cc/sales manager altijd,
                 en de sales_rep die aan de afspraak is toegewezen (hij ging
                 immers de afspraak doen — als hij op locatie merkt dat het
                 er geen was, moet hij het kunnen wegwerken). Cold caller
                 heeft geen dismiss-rechten. */
              canDismiss={
                profile?.role === 'cc_manager' ||
                profile?.role === 'sales_manager' ||
                appt.sales_rep_id === profile?.id
              }
              onDismissed={loadData}
              /* Zelfde authorisatie als dismiss — cc/sales manager altijd,
                 sales rep alleen voor eigen afspraken. Cold caller niet
                 (die zet de datum al bij initial call-logging). */
              canEditDate={
                profile?.role === 'cc_manager' ||
                profile?.role === 'sales_manager' ||
                appt.sales_rep_id === profile?.id
              }
              /* Optimistic mutatie: alleen die ene row aanpassen in de
                 client state — geen refetch van alle appointments. Voelt
                 instant + spaart een dure query. */
              onDateSaved={(newIso) => {
                setAppointments(prev => prev.map(x =>
                  x.call_record_id === appt.call_record_id
                    ? { ...x, appointment_date: newIso }
                    : x
                ))
              }}
              availableReps={salesRepsByProject.get(appt.project_id) ?? []}
              onAssignRep={(repId) => handleManualAssign(appt.call_record_id, repId)}
              isEditing={editingId === appt.call_record_id}
              onEdit={() => setEditingId(appt.call_record_id)}
              onClose={() => setEditingId(null)}
              onSaved={() => { setEditingId(null); loadData() }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── APPOINTMENT CARD ─────────────────────────────────────────────

function AppointmentCard({ appointment: a, isSales, canAssignReps, canDismiss, onDismissed, canEditDate, onDateSaved, availableReps, onAssignRep, isEditing, onEdit, onClose, onSaved }: {
  appointment: Appointment
  isSales: boolean
  /** Of de huidige user (cc/sales manager) handmatig een rep mag toewijzen. */
  canAssignReps: boolean
  /** Of de huidige user deze afspraak mag "geen afspraak" markeren.
      True voor cc_manager, sales_manager, én de toegewezen sales_rep. */
  canDismiss: boolean
  /** Callback na succesvolle dismiss — parent doet loadData(). */
  onDismissed: () => void
  /** Of de huidige user de afspraakdatum mag aanpassen. Zelfde regels
      als canDismiss (cc/sales manager, of eigen sales rep). */
  canEditDate: boolean
  /** Callback na wijziging — krijgt de nieuwe ISO datum (of null bij wissen).
      Parent doet een lokale state-mutatie (geen refetch) zodat de save
      instant voelt. Wordt ook gebruikt voor rollback bij RPC-error. */
  onDateSaved: (newIso: string | null) => void
  /** Lijst sales reps van dit project — gebruikt voor de dropdown. */
  availableReps: { id: string; name: string }[]
  /** Callback bij selectie van een rep in de dropdown. */
  onAssignRep: (repId: string) => void
  isEditing: boolean
  onEdit: () => void
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('dashboard.appointments')
  const [status, setStatus] = useState<AppointmentStatus>(a.appointment_status ?? 'gepland')
  const [outcome, setOutcome] = useState<Outcome>(a.outcome ?? 'geen')
  const [rating, setRating] = useState<number>(a.quality_rating ?? 0)
  const [notes, setNotes] = useState(a.sales_notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState(false)

  // Datum-editor state. Bewust apart van het feedback-formulier zodat
  // een manager de datum kan zetten zonder het volledige feedback-blok
  // te openen (of zonder überhaupt feedback te hoeven geven).
  const [editingDate, setEditingDate] = useState(false)
  const [dateSaving, setDateSaving] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const [dateInput, setDateInput] = useState<string>(() => toDateInputString(a.appointment_date))

  /** Opslaan/wissen van appointment_date via RPC. Lege string of expliciete
      null = wissen. Optioneel `explicitValue` zodat de "Wissen"-knop niet
      hoeft te wachten op een async setState. Editor sluit pas als de RPC
      succesvol is — foutmelding blijft inline zichtbaar bij mislukking. */
  async function handleSaveDate(explicitValue?: string) {
    const raw = explicitValue !== undefined ? explicitValue : dateInput
    // input type=date geeft "2026-08-15" — we ankeren op 12:00 lokaal om
    // timezone-drift naar de vorige/volgende dag te voorkomen.
    const iso = raw ? new Date(`${raw}T12:00:00`).toISOString() : null

    setDateError(null)
    setDateSaving(true)
    // eslint-disable-next-line no-console
    console.log('[appointments] set_appointment_date', { call_record_id: a.call_record_id, iso })

    const supabase = createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: rpcErr } = await (supabase as any).rpc('set_appointment_date', {
      p_call_record_id: a.call_record_id,
      p_appointment_date: iso,
    })
    setDateSaving(false)

    if (rpcErr) {
      // eslint-disable-next-line no-console
      console.error('[appointments] set_appointment_date failed', rpcErr)
      setDateError(rpcErr.message || String(rpcErr))
      return
    }
    // Succes: sluit editor + update parent state (geen refetch nodig).
    setEditingDate(false)
    onDateSaved(iso)
  }

  /** "Geen afspraak" — via RPC dismiss_appointment. De RPC checkt zelf
      of de user (cc_manager, sales_manager, of toegewezen sales_rep)
      hier rechten voor heeft. Fout → alert. Succes → onDismissed(). */
  async function handleDismiss() {
    if (!confirm(t('card.dismissConfirm'))) return
    setDismissing(true)
    const supabase = createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: rpcErr } = await (supabase as any).rpc('dismiss_appointment', {
      p_call_record_id: a.call_record_id,
    })
    setDismissing(false)
    if (rpcErr) {
      alert(t('errors.dismissFailed', { msg: rpcErr.message }))
      return
    }
    onDismissed()
  }

  const currentStatus = a.appointment_status ?? 'gepland'
  const statusColor = STATUS_COLORS[currentStatus]
  // Een sales rep kan partial feedback geven — bv. enkel outcome + notes
  // zonder de status uit 'gepland' te halen. Beschouw feedback als
  // "aanwezig" zodra een van de 4 velden een betekenisvolle waarde heeft.
  // Voorheen keken we enkel naar appointment_status, wat false-negatives gaf
  // (case: outcome=offerte + notes ingevuld, status nog 'gepland' → werd ten
  // onrechte als "Geen feedback" getoond, terwijl de report-pagina dezelfde
  // afspraak wél met outcome + notes liet zien).
  const hasFeedback =
    (!!a.appointment_status && a.appointment_status !== 'gepland') ||
    (!!a.outcome && a.outcome !== 'geen') ||
    a.quality_rating != null ||
    (!!a.sales_notes && a.sales_notes.trim() !== '')

  async function handleSave() {
    setSaving(true)
    setError(null)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setError(t('errors.notLoggedIn'))
      setSaving(false)
      return
    }

    // Auto-bump: een afspraak met een outcome heeft per definitie
    // plaatsgevonden. Als de sales rep een outcome kiest maar de status nog
    // op 'gepland' staat, gaan we automatisch naar 'uitgevoerd'. Veiligheids-
    // net — de UI bumpt ook al inline op outcome-click, maar dit dekt edge
    // cases (legacy data, snelle save zonder re-render, etc.) af.
    const effectiveStatus = status === 'gepland' && outcome !== 'geen' ? 'uitgevoerd' : status

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fbPayload: any = {
      call_record_id: a.call_record_id,
      sales_rep_id: user.id,
      appointment_status: effectiveStatus,
      outcome,
      quality_rating: rating || null,
      notes: notes.trim() || null,
      // ⚠ Nooit resetten naar null bij een gewone feedback-save — anders
      // verliezen we de door de manager (of via de datum-editor) ingestelde
      // afspraakdatum. Behoud wat er al stond.
      appointment_date: a.appointment_date ?? null,
    }
    const { error } = await supabase.from('appointment_feedback').upsert(fbPayload, { onConflict: 'call_record_id' })

    if (error) {
      setError(t('errors.saveFailed', { msg: error.message }))
      setSaving(false)
      return
    }
    onSaved()
  }

  return (
    <div className={`card overflow-hidden transition-all ${isEditing ? 'ring-2 ring-brand-200' : ''}`}>
      {/* Header */}
      <div className="p-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="#2d4fff" strokeWidth="1.5"/>
              <path d="M5 2V4M11 2V4M2 7H14" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="min-w-0">
            <div className="font-medium text-gray-900 text-sm flex items-center gap-2 flex-wrap">
              {a.lead_name ?? t('card.unknownLead')}
              {/* Bestaande afspraakdatum-badge. Klikbaar wanneer de user
                  de datum mag aanpassen (cc/sales manager, of eigen rep). */}
              {a.appointment_date && (
                canEditDate ? (
                  <button
                    onClick={() => {
                      setDateInput(toDateInputString(a.appointment_date))
                      setEditingDate(true)
                    }}
                    className="text-xs font-normal px-2 py-0.5 rounded-md bg-brand-50 text-brand-700 hover:bg-brand-100 hover:ring-1 hover:ring-brand-200 inline-flex items-center gap-1 transition-colors"
                    title={t('card.editDateTooltip')}
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                      <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M5 2V4M11 2V4M2 7H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    {t('card.appointmentPrefix')} {new Date(a.appointment_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </button>
                ) : (
                  <span className="text-xs font-normal px-2 py-0.5 rounded-md bg-brand-50 text-brand-700 inline-flex items-center gap-1">
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                      <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M5 2V4M11 2V4M2 7H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    {t('card.appointmentPrefix')} {new Date(a.appointment_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                  </span>
                )
              )}
              {/* Geen datum + rechten? Toon een subtiele "+ datum" knop.
                  Voorkomt dat de rep/manager naar het feedback-formulier
                  moet grasduinen alleen om een datum toe te voegen. */}
              {!a.appointment_date && canEditDate && (
                <button
                  onClick={() => {
                    setDateInput('')
                    setEditingDate(true)
                  }}
                  className="text-xs font-normal px-2 py-0.5 rounded-md border border-dashed border-gray-300 text-gray-500 hover:border-brand-300 hover:text-brand-600 hover:bg-brand-50 inline-flex items-center gap-1 transition-colors"
                >
                  <span>+</span>
                  <span>{t('card.addDate')}</span>
                </button>
              )}
            </div>
            {/* Uitklap-editor onder de titel. Datetime-local input + drie
                acties: Opslaan, Wissen (als er al een datum was), Annuleren. */}
            {editingDate && (
              <div className="mt-2 p-2 bg-brand-50/50 border border-brand-100 rounded-lg">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    value={dateInput}
                    onChange={e => setDateInput(e.target.value)}
                    className="text-sm border border-gray-200 rounded px-2 py-1"
                  />
                  <button
                    onClick={() => handleSaveDate()}
                    disabled={dateSaving}
                    className="text-xs px-3 py-1 rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 font-medium"
                  >
                    {dateSaving ? t('card.dateSaving') : t('card.dateSave')}
                  </button>
                  {a.appointment_date && (
                    <button
                      onClick={() => handleSaveDate('')}
                      disabled={dateSaving}
                      className="text-xs px-3 py-1 rounded-md text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {t('card.dateClear')}
                    </button>
                  )}
                  <button
                    onClick={() => { setDateError(null); setEditingDate(false) }}
                    className="text-xs px-3 py-1 rounded-md text-gray-500 hover:bg-gray-100"
                  >
                    {t('card.dateCancel')}
                  </button>
                </div>
                {dateError && (
                  <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                    {t('errors.dateSaveFailed', { msg: dateError })}
                  </div>
                )}
              </div>
            )}
            <div className="text-xs text-gray-400 mt-0.5">
              {a.caller_name} · {a.call_center_name}
              {a.call_date && ` · ${t('card.calledPrefix')} ${new Date(a.call_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
            </div>
            {/* Bron-chip: toont uit welke integratie deze call komt.
                - Lemlist: campaign-naam uit custom_fields (bv. "[Halco] – WVL-NW")
                - Google Sheets: sheet-naam uit filename (deel vóór " — ")
                - Manual/onbekend: enkel de tool of niks
                Alleen renderen wanneer we effectief een bron kennen. */}
            {(() => {
              const cf = (a.custom_fields ?? {}) as Record<string, unknown>
              const tool = a.upload_tool ?? ''
              if (tool === 'lemlist') {
                const campaign = String(cf.lemlist_campaign_name ?? '').trim()
                return (
                  <div className="text-xs mt-1">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-50 text-violet-700 border border-violet-100">
                      <span>📞</span>
                      <span>Lemlist</span>
                      {campaign && <span className="text-violet-500">· {campaign}</span>}
                    </span>
                  </div>
                )
              }
              if (tool === 'google_sheets') {
                const filename = a.upload_filename ?? ''
                // filename patroon: "Sheet-naam — 2026-07-30" of legacy "Sheet-naam (Google Sheets sync)"
                const sheetName = filename.split(' — ')[0].replace(/ \(Google Sheets sync\)$/, '').trim()
                return (
                  <div className="text-xs mt-1">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-100">
                      <span>📊</span>
                      <span>Sheet</span>
                      {sheetName && <span className="text-emerald-600">· {sheetName}</span>}
                    </span>
                  </div>
                )
              }
              if (tool && tool !== 'manual') {
                return (
                  <div className="text-xs mt-1">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-50 text-gray-600 border border-gray-100">
                      {tool}
                    </span>
                  </div>
                )
              }
              return null
            })()}
            {/* Sales-rep info: tonen wie toegewezen is + dropdown om (opnieuw)
                toe te wijzen. cc_manager en sales_manager mogen op elk moment
                de rep wijzigen — ook al is er al één toegewezen. De RPC
                assign_sales_rep_to_call_record ondersteunt dit via
                ON CONFLICT DO UPDATE. */}
            <div className="text-xs mt-1 flex items-center gap-2 flex-wrap">
              {a.sales_rep_name ? (
                <span className="text-gray-500">
                  {t('card.salesRepLabel')} <span className="text-gray-700 font-medium">{a.sales_rep_name}</span>
                </span>
              ) : (
                <span className="text-amber-700">{t('card.noRepAssigned')}</span>
              )}
              {canAssignReps && availableReps.length > 0 && (
                <select
                  key={a.sales_rep_id ?? 'none'}   // reset select-state als rep wijzigt
                  value={a.sales_rep_id ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v) onAssignRep(v)
                  }}
                  className={`text-xs border rounded px-2 py-0.5 ${
                    a.sales_rep_id
                      ? 'border-gray-200 bg-white text-gray-600 hover:border-brand-300'
                      : 'border-amber-300 bg-white text-amber-800'
                  }`}
                >
                  <option value="">
                    {a.sales_rep_id ? t('card.changePrompt') : t('card.assignPrompt')}
                  </option>
                  {availableReps.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              )}
            </div>
            {a.caller_notes && (
              <div className="text-xs text-gray-500 mt-1.5 italic">
                &quot;{a.caller_notes.length > 120 ? a.caller_notes.slice(0, 120) + '...' : a.caller_notes}&quot;
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {hasFeedback ? (
            <>
              <span className={`badge ${statusColor}`}>{t(`statusOptions.${currentStatus}`)}</span>
              {a.outcome && a.outcome !== 'geen' && (
                <span
                  className={`badge ${
                    a.outcome === 'deal' ? 'badge-green' :
                    a.outcome === 'verloren' ? 'badge-red' : 'badge-amber'
                  }`}
                  title={a.dealstage_raw ? t('card.dealstageTooltip', { stage: a.dealstage_raw }) : undefined}
                >
                  {t(`outcomeOptions.${a.outcome}`)}
                </span>
              )}
              {a.quality_rating && (
                <div className="flex gap-0.5 items-center">
                  {[1,2,3,4,5].map(s => (
                    <div key={s} className={`w-1.5 h-1.5 rounded-full ${s <= a.quality_rating! ? 'bg-amber-400' : 'bg-gray-200'}`} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <span className="badge badge-gray">{t('card.noFeedback')}</span>
          )}
          {isSales && (
            <button
              onClick={isEditing ? onClose : onEdit}
              className="text-xs text-brand-600 hover:text-brand-700 font-medium"
            >
              {isEditing ? t('card.cancel') : hasFeedback ? t('card.edit') : t('card.giveFeedback')}
            </button>
          )}
          {canDismiss && !isEditing && (
            <button
              onClick={handleDismiss}
              disabled={dismissing}
              className="text-xs text-gray-400 hover:text-red-600 font-medium disabled:opacity-50"
              title={t('card.dismissTooltip')}
            >
              {dismissing ? t('card.dismissing') : t('card.dismiss')}
            </button>
          )}
        </div>
      </div>

      {/* Feedback formulier */}
      {isEditing && (
        <div className="border-t border-gray-100 p-4 bg-gray-50 space-y-4">

          <div>
            <div className="text-xs font-medium text-gray-500 mb-2">{t('form.statusLabel')}</div>
            <div className="flex gap-2 flex-wrap">
              {STATUS_VALUES.map(v => (
                <button
                  key={v}
                  onClick={() => setStatus(v)}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                    status === v
                      ? 'border-brand-400 bg-brand-50 text-brand-700 font-medium'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {t(`statusOptions.${v}`)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-gray-500 mb-2">{t('form.outcomeLabel')}</div>
            <div className="flex gap-2 flex-wrap">
              {OUTCOME_VALUES.map(v => (
                <button
                  key={v}
                  onClick={() => {
                    setOutcome(v)
                    // Auto-bump status naar 'uitgevoerd' wanneer de rep een
                    // echte outcome kiest terwijl status nog 'gepland' is.
                    // Visuele feedback in dezelfde klik — de rep ziet meteen
                    // dat de status-knop ook is gewijzigd. Hij kan dat
                    // manueel terugzetten als hij dat per se wil.
                    if (v !== 'geen' && status === 'gepland') {
                      setStatus('uitgevoerd')
                    }
                  }}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                    outcome === v
                      ? 'border-brand-400 bg-brand-50 text-brand-700 font-medium'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {t(`outcomeOptions.${v}`)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-gray-500 mb-2">
              {t('form.qualityLabel')}
              <span className="font-normal text-gray-400 ml-1">{t('form.qualityHelp')}</span>
            </div>
            <div className="flex items-center gap-2">
              {[1,2,3,4,5].map(s => (
                <button
                  key={s}
                  onClick={() => setRating(s === rating ? 0 : s)}
                  className={`w-9 h-9 rounded-lg border text-sm font-medium transition-colors ${
                    s <= rating
                      ? 'bg-amber-400 border-amber-400 text-white'
                      : 'bg-white border-gray-200 text-gray-400 hover:border-amber-300'
                  }`}
                >
                  {s}
                </button>
              ))}
              <span className="text-xs text-gray-400 ml-1">
                {rating === 0
                  ? t('form.ratingNone')
                  : rating <= 2
                    ? t('form.ratingPoor')
                    : rating === 3
                      ? t('form.ratingAvg')
                      : rating === 4
                        ? t('form.ratingGood')
                        : t('form.ratingPerfect')}
              </span>
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-gray-500 mb-2">{t('form.notesLabel')}</div>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="input resize-none text-sm"
              rows={2}
              placeholder={t('form.notesPlaceholder')}
            />
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn-secondary text-sm">{t('form.cancel')}</button>
            <button onClick={handleSave} disabled={saving} className="btn-primary text-sm">
              {saving ? t('form.saving') : t('form.save')}
            </button>
          </div>
        </div>
      )}

      {/* Bestaande notities tonen */}
      {!isEditing && hasFeedback && a.sales_notes && (
        <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
          <div className="text-xs text-gray-400 mb-0.5">{t('card.salesRepNotes')}</div>
          <div className="text-sm text-gray-600">{a.sales_notes}</div>
        </div>
      )}
    </div>
  )
}
