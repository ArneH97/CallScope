'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useTranslations, useLocale } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { ColumnMapping, Profile, Project, ProjectGoogleSheet, UploadSummary } from '@/types/database'
import TrialBanner from '@/components/TrialBanner'
import LemlistCampaignPicker from '@/components/LemlistCampaignPicker'
import HubSpotListPicker from '@/components/HubSpotListPicker'
import CallerRatesEditor from '@/components/CallerRatesEditor'

type Member = {
  profile_id: string
  full_name: string
  email: string | null
  role: 'cold_caller' | 'sales_rep' | 'sales_manager'
}

type GoogleSheetBinding = ProjectGoogleSheet

export default function ProjectSettingsPage() {
  const t = useTranslations('dashboard.projects.settings')
  const locale = useLocale()
  const bcp47 = locale === 'nl' ? 'nl-BE' : locale
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectId = params.id as string
  // Wordt door de wizard gezet als de gekozen upload/feedback-source nog
  // configuratie nodig heeft (HubSpot list-koppeling, Google Sheets binding,
  // Lemlist campaign). We tonen dan een banner bovenaan en scrollen naar de
  // juiste card.
  const onboardingHint = searchParams.get('onboarding')

  const [profile, setProfile] = useState<Profile | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [bindings, setBindings] = useState<GoogleSheetBinding[]>([])
  const [hasGoogleIntegration, setHasGoogleIntegration] = useState(false)
  const [googleEmail, setGoogleEmail] = useState<string | null>(null)
  const [recentUploads, setRecentUploads] = useState<UploadSummary[]>([])
  const [deletingUpload, setDeletingUpload] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [pickerCallerId, setPickerCallerId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncMessage, setSyncMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const [defaultRepId, setDefaultRepId] = useState<string>('')
  const [salesRepCol, setSalesRepCol] = useState<string>('')
  const [dealstageCol, setDealstageCol] = useState<string>('')
  const [salesSaving, setSalesSaving] = useState(false)
  const [salesMsg, setSalesMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  // Verwijder-project modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) {
      router.push('/auth/login')
      return
    }

    const [{ data: prof }, { data: proj }, { data: pms }, { data: gi }, { data: bnd }, { data: ups }] = await Promise.all([
      sb.from('profiles').select('*').eq('id', user.id).single(),
      sb.from('projects').select('*').eq('id', projectId).single(),
      sb.from('project_members')
        .select('profile_id, role, profiles(full_name, email)')
        .eq('project_id', projectId)
        .returns<{ profile_id: string; role: Member['role']; profiles: { full_name: string; email: string | null } | null }[]>(),
      sb.from('google_integrations').select('google_email').eq('user_id', user.id).maybeSingle(),
      sb.from('project_google_sheets').select('*').eq('project_id', projectId)
        .returns<ProjectGoogleSheet[]>(),
      sb.from('upload_summary')
        .select('*')
        .eq('project_id', projectId)
        .order('uploaded_at', { ascending: false })
        .limit(20)
        .returns<UploadSummary[]>(),
    ])

    setProfile(prof as Profile | null)
    setProject(proj as Project | null)
    const projTyped = proj as Project | null
    if (projTyped) {
      setDefaultRepId(projTyped.default_sales_rep_id ?? '')
      const lcm = (projTyped.last_column_mapping ?? {}) as Partial<ColumnMapping>
      setSalesRepCol(lcm.sales_rep ?? '')
      setDealstageCol(lcm.dealstage ?? '')
    }
    setMembers(
      (pms ?? []).map(m => ({
        profile_id: m.profile_id,
        full_name: m.profiles?.full_name ?? t('members.unknownName'),
        email: m.profiles?.email ?? null,
        role: m.role,
      })),
    )
    setHasGoogleIntegration(!!gi)
    setGoogleEmail((gi as { google_email: string | null } | null)?.google_email ?? null)
    setBindings(bnd ?? [])
    setRecentUploads(ups ?? [])
    setLoading(false)
  }

  async function handleDeleteUpload(uploadId: string, label: string) {
    if (!confirm(t('recentUploads.deleteConfirm', { label }))) return
    setDeletingUpload(uploadId)
    const sb = createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb.rpc as any)('delete_upload', { p_upload_id: uploadId })
    setDeletingUpload(null)
    if (error) {
      alert(t('recentUploads.deleteFailed', { error: error.message }))
      return
    }
    await load()
  }

  async function handleSaveSalesConfig() {
    if (!project) return
    setSalesSaving(true)
    setSalesMsg(null)
    const sb = createClient()
    const merged: Partial<ColumnMapping> = {
      ...(project.last_column_mapping ?? {}),
      sales_rep: salesRepCol.trim(),
      dealstage: dealstageCol.trim(),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: any = {
      default_sales_rep_id: defaultRepId || null,
      last_column_mapping:  merged,
    }
    const { error } = await sb.from('projects').update(update).eq('id', projectId)
    setSalesSaving(false)
    if (error) {
      setSalesMsg({ type: 'error', text: t('salesConfig.saveFailed', { error: error.message }) })
      return
    }
    setSalesMsg({ type: 'ok', text: t('salesConfig.saveSuccess') })
    await load()
  }

  async function handleDeleteProject() {
    if (deleteConfirmText.trim() !== project?.name) {
      setDeleteError(t('deleteModal.mismatch'))
      return
    }
    setDeleting(true)
    setDeleteError(null)
    const sb = createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb.rpc as any)('delete_project', { p_project_id: projectId })
    if (error) {
      setDeleting(false)
      setDeleteError(t('deleteModal.deleteFailed', { error: error.message }))
      return
    }
    // Niet meer setLoading(false) doen — pagina navigeert weg.
    router.push('/dashboard/projects')
  }

  // Welke sheet zit in het "kies een periode"-menu (null = menu dicht).
  const [rangePickerBinding, setRangePickerBinding] = useState<string | null>(null)

  /** Sync één binding voor een gegeven datum-window.
   *  Default: enkel vandaag (backwards-compat). Bij een expliciete range
   *  (b.v. vorige week ma-vr) worden alle dagen binnen die window geïmporteerd
   *  — elke dag als aparte upload met `uploaded_at = call_date` zodat het
   *  dashboard-filter de calls in het juiste dagbucket zet. */
  async function handleSync(bindingId: string, opts: { from?: string; to?: string } = {}) {
    setSyncing(bindingId)
    setSyncMessage(null)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = { binding_id: bindingId }
      if (opts.from) body.from_date = opts.from
      if (opts.to)   body.to_date   = opts.to
      const res = await fetch(`/api/projects/${projectId}/google-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setSyncMessage({ type: 'error', text: data.error ?? t('google.syncFailed') })
      } else {
        const text = data.imported > 0
          ? t('google.syncSummary', { count: data.imported })
          : data.message ?? t('google.noLeadsToday')
        setSyncMessage({ type: 'ok', text })
        await load()
      }
    } catch (e) {
      setSyncMessage({ type: 'error', text: e instanceof Error ? e.message : t('google.unknownError') })
    } finally {
      setSyncing(null)
      setRangePickerBinding(null)
    }
  }

  /** Helper: (from, to) YYYY-MM-DD voor een preset. Brussel-tijd. */
  function presetRange(preset: 'today' | 'thisWeek' | 'lastWeek'): { from: string; to: string } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Brussels',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(new Date())
    const y = Number(parts.find(p => p.type === 'year')!.value)
    const m = Number(parts.find(p => p.type === 'month')!.value)
    const d = Number(parts.find(p => p.type === 'day')!.value)
    const wd = parts.find(p => p.type === 'weekday')!.value
    const dowMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
    const dow = dowMap[wd] ?? 1
    const today = new Date(Date.UTC(y, m - 1, d))
    const iso = (dt: Date) => dt.toISOString().slice(0, 10)

    if (preset === 'today') {
      const t = iso(today)
      return { from: t, to: t }
    }
    if (preset === 'thisWeek') {
      // maandag van deze week → vandaag
      const mon = new Date(today); mon.setUTCDate(today.getUTCDate() - (dow - 1))
      return { from: iso(mon), to: iso(today) }
    }
    // lastWeek: maandag vorige week → vrijdag vorige week
    const monLast = new Date(today); monLast.setUTCDate(today.getUTCDate() - (dow - 1) - 7)
    const friLast = new Date(monLast); friLast.setUTCDate(monLast.getUTCDate() + 4)
    return { from: iso(monLast), to: iso(friLast) }
  }

  /** Verbreek één sheet-koppeling. RLS `pgs_delete_cc_manager` staat DELETE
   *  toe voor de cc_manager van het project. */
  async function handleUnlink(bindingId: string, sheetName: string) {
    if (!confirm(t('google.unlinkConfirm', { name: sheetName }))) return
    setSyncing(bindingId)
    setSyncMessage(null)
    try {
      const sb = createClient()
      const { error } = await sb
        .from('project_google_sheets')
        .delete()
        .eq('id', bindingId)
      if (error) {
        setSyncMessage({ type: 'error', text: error.message })
      } else {
        setSyncMessage({ type: 'ok', text: t('google.unlinkSuccess', { name: sheetName }) })
        await load()
      }
    } catch (e) {
      setSyncMessage({ type: 'error', text: e instanceof Error ? e.message : t('google.unknownError') })
    } finally {
      setSyncing(null)
    }
  }

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>
  if (!project) return <div className="card p-8 text-center text-sm text-gray-400">{t('notFound')}</div>

  const isManager = profile?.role === 'cc_manager'
  const callerMembers = members.filter(m => m.role === 'cold_caller')
  const callerOptions: Member[] = [
    ...callerMembers,
    ...(isManager && profile && !callerMembers.some(c => c.profile_id === profile.id)
      ? [{ profile_id: profile.id, full_name: profile.full_name + t('selfSuffix'), email: profile.email, role: 'cold_caller' as const }]
      : []),
  ]

  /** Alle sheets die aan een specifieke caller gekoppeld zijn. Gesorteerd
   *  op sheet_name voor consistente UI. */
  function bindingsFor(callerId: string): GoogleSheetBinding[] {
    return bindings
      .filter(b => b.caller_id === callerId)
      .sort((a, b) => (a.sheet_name ?? '').localeCompare(b.sheet_name ?? ''))
  }

  const hasMapping = !!project.unique_id_label || !!(project.last_column_mapping?.lead_name)
  const futureItems = t.raw('futureIntegrations.items') as string[]

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <Link href={`/dashboard/projects`} className="text-sm text-gray-400 hover:text-gray-600 inline-flex items-center gap-1.5 mb-3">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold text-gray-900">{project.name}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
      </div>

      {/* Trial / billing status — alleen voor cc_managers. Andere rollen
          (sales_manager, sales_rep, cold_caller) zien geen billing-info. */}
      {isManager && <TrialBanner project={project} />}

      {/* Onboarding-banner — verschijnt zodra de wizard een upload-source
          heeft gekozen die per-project setup vereist. Wijst de cc_manager
          recht naar de juiste card hieronder. */}
      {onboardingHint === 'hubspot' && isManager && (
        <div className="card p-4 mb-5 border-blue-200 bg-blue-50">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-white border border-blue-200 flex items-center justify-center flex-shrink-0">
              <span className="text-blue-600 font-semibold text-sm">{t('onboarding.step')}</span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-blue-900">{t('onboarding.hubspot.title')}</h3>
              <p
                className="text-xs text-blue-800 mt-1 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: t('onboarding.hubspot.body') }}
              />
            </div>
          </div>
        </div>
      )}
      {onboardingHint === 'google_sheets' && isManager && (
        <div className="card p-4 mb-5 border-blue-200 bg-blue-50">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-white border border-blue-200 flex items-center justify-center flex-shrink-0">
              <span className="text-blue-600 font-semibold text-sm">{t('onboarding.step')}</span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-blue-900">{t('onboarding.google.title')}</h3>
              <p
                className="text-xs text-blue-800 mt-1 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: t('onboarding.google.body') }}
              />
            </div>
          </div>
        </div>
      )}
      {onboardingHint === 'lemlist' && isManager && (
        <div className="card p-4 mb-5 border-blue-200 bg-blue-50">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-white border border-blue-200 flex items-center justify-center flex-shrink-0">
              <span className="text-blue-600 font-semibold text-sm">{t('onboarding.step')}</span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-blue-900">{t('onboarding.lemlist.title')}</h3>
              <p
                className="text-xs text-blue-800 mt-1 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: t('onboarding.lemlist.body') }}
              />
            </div>
          </div>
        </div>
      )}

      <div className="card p-5 mb-5">
        <div className="text-sm font-medium text-gray-900 mb-3">{t('general.title')}</div>
        <div className="space-y-2 sm:space-y-2 text-sm">
          <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-4"><span className="text-gray-500 text-xs sm:text-sm">{t('general.name')}</span><span className="text-gray-900 break-words">{project.name}</span></div>
          {project.description && (
            <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-4"><span className="text-gray-500 text-xs sm:text-sm">{t('general.description')}</span><span className="text-gray-900 sm:max-w-[60%] sm:text-right break-words">{project.description}</span></div>
          )}
          <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-4"><span className="text-gray-500 text-xs sm:text-sm">{t('general.uniqueIdLabel')}</span><span className="text-gray-900">{project.unique_id_label ?? <span className="text-gray-300">{t('general.uniqueIdNotMapped')}</span>}</span></div>
          <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-4"><span className="text-gray-500 text-xs sm:text-sm">{t('general.customFields')}</span><span className="text-gray-900">{project.custom_field_definitions?.length ?? 0}</span></div>
          <div className="flex flex-col sm:flex-row sm:justify-between gap-0.5 sm:gap-4"><span className="text-gray-500 text-xs sm:text-sm">{t('general.createdAt')}</span><span className="text-gray-900">{new Date(project.created_at).toLocaleDateString(bcp47, { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
        </div>
      </div>

      <div className="card p-5 mb-5">
        <div className="text-sm font-medium text-gray-900 mb-3">
          {t('members.title')} <span className="text-gray-400 font-normal">({members.length})</span>
        </div>
        {members.length === 0 ? (
          <p className="text-sm text-gray-400">{t('members.empty')}</p>
        ) : (
          <div className="space-y-2">
            {members.map(m => (
              <div key={m.profile_id} className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
                <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 flex-shrink-0">
                  {m.full_name[0]}
                </div>
                <span className="text-gray-700">{m.full_name}</span>
                {m.email && <span className="text-xs text-gray-400 truncate">— {m.email}</span>}
                <span className={`badge ml-auto ${
                  m.role === 'sales_manager' ? 'badge-amber' :
                  m.role === 'sales_rep'     ? 'badge-purple' :
                                               'badge-blue'
                }`}>
                  {m.role === 'sales_manager' ? t('members.roles.sales_manager') :
                   m.role === 'sales_rep'     ? t('members.roles.sales_rep') :
                                                t('members.roles.caller')}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-400 mt-4">
          {t('members.manageHint')}{' '}
          <Link href="/dashboard/projects" className="text-brand-600 hover:underline">{t('members.manageLink')}</Link>.
        </p>
      </div>

      {/* Lemlist campaign-picker — alleen voor cc_managers met een Lemlist-koppeling */}
      {isManager && (
        <LemlistCampaignPicker
          projectId={projectId}
          initialCampaignId={project.lemlist_campaign_id}
          initialCampaignName={project.lemlist_campaign_name}
        />
      )}

      {/* HubSpot calls-list-picker — voor cc_managers die hun cold-calls in
          HubSpot doen. Calls op contacts in de gekoppelde list worden
          dagelijks gesynced. */}
      {isManager && (
        <div className="card p-5 mb-5">
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">{t('hubspot.title')}</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('hubspot.subtitle')}
              </p>
            </div>
          </div>
          <div className="mt-3">
            <HubSpotListPicker
              projectId={projectId}
              initialListId={project.hubspot_calls_list_id ?? null}
              initialListName={project.hubspot_calls_list_name ?? null}
            />
          </div>

          {/* Inline setup-uitleg — toont vier stappen die de cc_manager in
              HubSpot moet uitvoeren om de volledige call → afspraak →
              dealstage feedback-loop te activeren. */}
          <details className="mt-4 rounded-lg border border-gray-200 bg-gray-50">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 hover:bg-gray-100 select-none">
              {t('hubspot.helpSummary')}
            </summary>
            <div className="px-4 py-3 border-t border-gray-200 text-sm text-gray-700 space-y-4">

              {/* Stap 1: List */}
              <div>
                <div className="font-medium text-gray-900 mb-1">{t('hubspot.step1.title')}</div>
                <p
                  className="text-gray-600 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: t('hubspot.step1.body') }}
                />
              </div>

              {/* Stap 2: Custom call outcome */}
              <div>
                <div className="font-medium text-gray-900 mb-1">{t('hubspot.step2.title')}</div>
                <p
                  className="text-gray-600 leading-relaxed mb-2"
                  dangerouslySetInnerHTML={{ __html: t('hubspot.step2.intro') }}
                />
                <ol className="list-decimal list-inside text-gray-600 space-y-1 leading-relaxed ml-1">
                  <li dangerouslySetInnerHTML={{ __html: t('hubspot.step2.li1') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('hubspot.step2.li2') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('hubspot.step2.li3') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('hubspot.step2.li4') }} />
                  <li dangerouslySetInnerHTML={{ __html: t('hubspot.step2.li5') }} />
                </ol>
                <p className="text-xs text-gray-500 mt-2 italic">
                  {t('hubspot.step2.note')}
                </p>
              </div>

              {/* Stap 3: Workflow */}
              <div>
                <div className="font-medium text-gray-900 mb-1">{t('hubspot.step3.title')}</div>
                <p
                  className="text-gray-600 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: t('hubspot.step3.body') }}
                />
              </div>

              {/* Stap 4: Deals + dealstage */}
              <div>
                <div className="font-medium text-gray-900 mb-1">{t('hubspot.step4.title')}</div>
                <p
                  className="text-gray-600 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: t('hubspot.step4.body') }}
                />
              </div>

              <div
                className="pt-2 mt-2 border-t border-gray-200 text-xs text-gray-500"
                dangerouslySetInnerHTML={{ __html: t('hubspot.footer') }}
              />
            </div>
          </details>
        </div>
      )}

      {/* Tijdsbudget & uurtarieven — alleen voor cc_manager. */}
      {isManager && (
        <>
          <CallerRatesEditor projectId={projectId} />
          <div className="card p-4 mb-5 border-blue-100 bg-blue-50/40">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p
                className="text-sm text-gray-700"
                dangerouslySetInnerHTML={{ __html: t('hoursBanner.intro') }}
              />
              <Link
                href={`/dashboard/projects/${projectId}/confirm-hours`}
                className="text-xs px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors whitespace-nowrap font-medium"
              >
                {t('hoursBanner.open')}
              </Link>
            </div>
          </div>
        </>
      )}

      {/* Template-download — beschikbaar voor élk project. */}
      <div className="card p-5 mb-5 border-brand-100 bg-brand-50/40">
        <div className="flex flex-col sm:flex-row items-start gap-3 sm:gap-4">
          <div className="w-10 h-10 rounded-lg bg-white border border-brand-100 flex items-center justify-center flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#1a35e6" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M14 2v6h6M9 13h6M9 17h6" stroke="#1a35e6" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 mb-0.5">
              {t('template.title')}
            </div>
            <p className="text-xs text-gray-600 leading-relaxed">
              {t('template.body', { uniqueIdSuffix: project.unique_id_label ? ' (' + project.unique_id_label + ')' : '' })}
            </p>
          </div>
          <a
            href={`/api/projects/${projectId}/template`}
            className="text-xs px-3 py-2 rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors flex-shrink-0 font-medium inline-flex items-center gap-1.5 w-full sm:w-auto justify-center"
            title={t('template.buttonTitle')}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v9M4 7l4 4 4-4M2 14h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t('template.button')}
          </a>
        </div>
      </div>

      {isManager && (
        <div className="card p-5 mb-5">
          <div className="flex items-start justify-between mb-4 gap-4">
            <div>
              <div className="text-sm font-medium text-gray-900">{t('google.title')}</div>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                {t('google.subtitle')}
              </p>
            </div>
            {hasGoogleIntegration && googleEmail && (
              <div className="text-xs text-gray-500 text-right flex-shrink-0">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500"/>
                  {t('google.connected')}
                </div>
                <div className="text-gray-400">{googleEmail}</div>
              </div>
            )}
          </div>

          {!hasGoogleIntegration && (
            <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg text-sm">
              <p className="text-amber-800 mb-2">
                {t('google.notConnected')}
              </p>
              <Link href="/dashboard/settings/integrations" className="text-xs text-brand-600 hover:underline font-medium">
                {t('google.toIntegrations')}
              </Link>
            </div>
          )}

          {hasGoogleIntegration && callerOptions.length === 0 && (
            <p className="text-sm text-gray-400 italic">
              {t('google.noCallers')}
            </p>
          )}

          {hasGoogleIntegration && !hasMapping && (
            <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg text-sm mb-3">
              <p className="text-amber-800 font-medium mb-1">{t('google.noMappingWarning')}</p>
              <p className="text-xs text-amber-700">
                {t.rich('google.noMappingHint', {
                  link: (chunks) => (
                    <Link href="/dashboard/upload" className="underline font-medium">{chunks}</Link>
                  ),
                })}
              </p>
            </div>
          )}

          {syncMessage && (
            <div className={`mb-3 p-2.5 rounded-lg text-sm ${
              syncMessage.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {syncMessage.text}
            </div>
          )}

          {hasGoogleIntegration && callerOptions.length > 0 && (
            <div className="space-y-3">
              {callerOptions.map(c => {
                const cBindings = bindingsFor(c.profile_id)
                return (
                  <div key={c.profile_id} className="border border-gray-100 rounded-lg p-3">
                    {/* Caller-header met naam + "+ Sheet toevoegen"-knop */}
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 flex-shrink-0">
                        {c.full_name[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{c.full_name}</div>
                        <div className="text-xs text-gray-400">
                          {cBindings.length === 0
                            ? t('google.noSheet')
                            : t('google.sheetsCount', { count: cBindings.length })}
                        </div>
                      </div>
                      <button
                        onClick={() => setPickerCallerId(c.profile_id)}
                        className="text-xs px-3 py-1.5 rounded-md border border-brand-200 bg-brand-50 text-brand-700 hover:border-brand-400 transition-colors flex items-center gap-1 flex-shrink-0"
                      >
                        <span>+</span> {t('google.addSheet')}
                      </button>
                    </div>

                    {/* Per-sheet subrijen — één rij per binding */}
                    {cBindings.length > 0 && (
                      <div className="space-y-1.5 pl-10">
                        {cBindings.map(b => (
                          <div key={b.id} className="flex items-center gap-2 py-1.5 border-t border-gray-50 first:border-0">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-gray-800 truncate">
                                {t('google.sheetIcon')} {b.sheet_name}
                              </div>
                              {b.last_synced_at && (
                                <div className="text-xs text-gray-400 mt-0.5">
                                  {t('google.lastSynced', { date: new Date(b.last_synced_at).toLocaleString(bcp47, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}
                                </div>
                              )}
                              {b.last_sync_status === 'error' && b.last_sync_error && (
                                <div className="text-xs text-red-600 mt-0.5">⚠ {b.last_sync_error}</div>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 flex-shrink-0 relative">
                              {hasMapping && (
                                <div className="inline-flex">
                                  {/* Hoofdknop: sync vandaag (backwards-compat) */}
                                  <button
                                    onClick={() => handleSync(b.id, presetRange('today'))}
                                    disabled={syncing === b.id}
                                    className="text-xs px-2.5 py-1 rounded-l-md border border-r-0 border-brand-300 bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
                                    title={t('google.syncNowTip')}
                                  >
                                    {syncing === b.id ? t('google.syncing') : t('google.syncNow')}
                                  </button>
                                  {/* Split-arrow: opent periode-menu */}
                                  <button
                                    onClick={() => setRangePickerBinding(rangePickerBinding === b.id ? null : b.id)}
                                    disabled={syncing === b.id}
                                    className="text-xs px-1.5 py-1 rounded-r-md border border-brand-300 bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50 border-l border-l-brand-500"
                                    title={t('google.syncMoreOptions')}
                                  >
                                    ▾
                                  </button>
                                </div>
                              )}
                              <button
                                onClick={() => handleUnlink(b.id, b.sheet_name ?? '')}
                                disabled={syncing === b.id}
                                className="text-xs px-2.5 py-1 rounded-md border border-red-200 text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                                title={t('google.unlinkTip')}
                              >
                                {t('google.unlink')}
                              </button>

                              {/* Periode-menu (klein dropdown-panel) */}
                              {rangePickerBinding === b.id && (
                                <div className="absolute right-0 top-full mt-1 z-10 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[180px]">
                                  {(['today', 'thisWeek', 'lastWeek'] as const).map(p => (
                                    <button
                                      key={p}
                                      onClick={() => handleSync(b.id, presetRange(p))}
                                      className="w-full text-left text-xs px-3 py-1.5 hover:bg-gray-50 text-gray-700"
                                    >
                                      {t(`google.syncRange.${p}`)}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {(profile?.role === 'cc_manager' || profile?.role === 'sales_manager') && (
        <div className="card p-5 mb-5">
          <div className="text-sm font-medium text-gray-900 mb-1">{t('salesConfig.title')}</div>
          <p className="text-xs text-gray-500 mb-4 leading-relaxed">
            {t('salesConfig.subtitle')}
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('salesConfig.defaultLabel')}</label>
              <select
                value={defaultRepId}
                onChange={e => setDefaultRepId(e.target.value)}
                className="input"
              >
                <option value="">{t('salesConfig.defaultNone')}</option>
                {members
                  .filter(m => m.role === 'sales_rep' || m.role === 'sales_manager')
                  .map(m => (
                    <option key={m.profile_id} value={m.profile_id}>
                      {m.full_name} {m.role === 'sales_manager' ? t('salesConfig.managerSuffix') : ''}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {t('salesConfig.defaultHint')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('salesConfig.salesRepColLabel')}</label>
                <input
                  type="text"
                  value={salesRepCol}
                  onChange={e => setSalesRepCol(e.target.value)}
                  placeholder={t('salesConfig.salesRepColPlaceholder')}
                  className="input"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('salesConfig.dealstageColLabel')}</label>
                <input
                  type="text"
                  value={dealstageCol}
                  onChange={e => setDealstageCol(e.target.value)}
                  placeholder={t('salesConfig.dealstageColPlaceholder')}
                  className="input"
                />
              </div>
            </div>
            <p className="text-xs text-gray-400">
              {t('salesConfig.caseHint')}
            </p>

            {salesMsg && (
              <p className={`text-sm px-3 py-2 rounded-lg ${
                salesMsg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}>
                {salesMsg.text}
              </p>
            )}

            <div className="flex justify-end pt-1">
              <button
                onClick={handleSaveSalesConfig}
                disabled={salesSaving}
                className="btn-primary text-sm"
              >
                {salesSaving ? t('salesConfig.saving') : t('salesConfig.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isManager && (
        <div className="card p-5 mb-5 opacity-60">
          <div className="text-sm font-medium text-gray-700 mb-2">{t('futureIntegrations.title')}</div>
          <ul className="text-xs text-gray-500 space-y-1">
            {futureItems.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {isManager && recentUploads.length > 0 && (
        <div className="card p-5 mb-5">
          <div className="text-sm font-medium text-gray-900 mb-3">
            {t('recentUploads.title')} <span className="text-gray-400 font-normal">({recentUploads.length})</span>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            {t('recentUploads.subtitle')}
          </p>
          <div className="space-y-1">
            {recentUploads.map(u => {
              const isGoogle = u.tool === 'google_sheets'
              const stat = u.status
              return (
                <div key={u.id} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                  <div className="w-7 h-7 rounded-md bg-gray-50 flex items-center justify-center text-gray-400 flex-shrink-0">
                    {isGoogle ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                        <path d="M14 2v6h6M9 13h6M9 17h6M9 9h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M4 2h6l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.5"/>
                        <path d="M10 2v4h4" stroke="currentColor" strokeWidth="1.5"/>
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <a href={`/dashboard/upload/${u.id}`} className="text-sm font-medium text-gray-900 truncate hover:text-brand-600 transition-colors">
                        {u.filename}
                      </a>
                      {isGoogle && <span className="badge badge-blue text-xs">{t('recentUploads.googleSyncBadge')}</span>}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {new Date(u.uploaded_at).toLocaleString(bcp47, {
                        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                      {' · '}{u.caller_name ?? t('recentUploads.unknownCaller')}
                      {u.total_calls > 0 && t('recentUploads.recordsSuffix', { count: u.total_calls })}
                      {u.appointments > 0 && t('recentUploads.appointmentsSuffix', { count: u.appointments })}
                    </div>
                  </div>
                  <span className={`badge text-xs ${
                    stat === 'done' ? 'badge-green' :
                    stat === 'processing' ? 'badge-amber' :
                    stat === 'error' ? 'badge-red' : 'badge-gray'
                  }`}>
                    {stat === 'done' ? t('recentUploads.status.done') :
                     stat === 'processing' ? t('recentUploads.status.processing') :
                     stat === 'error' ? t('recentUploads.status.error') :
                                        t('recentUploads.status.queued')}
                  </span>
                  <button
                    onClick={() => handleDeleteUpload(u.id, u.filename)}
                    disabled={deletingUpload === u.id}
                    className="text-xs text-gray-400 hover:text-red-600 transition-colors disabled:opacity-50"
                    title={t('recentUploads.deleteTip')}
                  >
                    {deletingUpload === u.id ? t('recentUploads.deleting') : t('recentUploads.delete')}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Gevarenzone — alleen voor cc_manager ────────────────── */}
      {isManager && (
        <div className="card p-5 mb-5 border-red-200 bg-red-50/30">
          <div className="text-sm font-medium text-red-900 mb-1">{t('dangerZone.title')}</div>
          <p className="text-xs text-red-700 mb-3 leading-relaxed">
            {t('dangerZone.body')}
          </p>
          <button
            onClick={() => {
              setShowDeleteModal(true)
              setDeleteConfirmText('')
              setDeleteError(null)
            }}
            className="text-xs px-3 py-1.5 rounded-md border border-red-300 bg-white text-red-700 hover:bg-red-50 transition-colors font-medium"
          >
            {t('dangerZone.button')}
          </button>
        </div>
      )}

      {pickerCallerId && (
        <SheetPickerModal
          projectId={projectId}
          callerId={pickerCallerId}
          existingBindings={bindingsFor(pickerCallerId)}
          onClose={() => setPickerCallerId(null)}
          onSaved={() => {
            setPickerCallerId(null)
            load()
          }}
        />
      )}

      {/* ── Verwijder-bevestiging modal ─────────────────────────── */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.5L1.5 13.5h13L8 1.5z" stroke="#dc2626" strokeWidth="1.5" strokeLinejoin="round"/>
                  <path d="M8 6v3M8 11.5v.5" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">{t('deleteModal.title', { name: project.name })}</h2>
                <p className="text-sm text-gray-500 mt-1">
                  {t('deleteModal.body')}
                </p>
              </div>
            </div>

            <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-4">
              <p
                className="text-xs text-gray-600 mb-2"
                dangerouslySetInnerHTML={{ __html: t('deleteModal.confirmPrompt', { name: project.name }) }}
              />
              <input
                type="text"
                value={deleteConfirmText}
                onChange={e => setDeleteConfirmText(e.target.value)}
                className="input text-sm"
                placeholder={project.name}
                autoFocus
              />
            </div>

            {deleteError && (
              <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">
                {deleteError}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowDeleteModal(false)
                  setDeleteConfirmText('')
                  setDeleteError(null)
                }}
                className="btn-secondary flex-1"
                disabled={deleting}
              >
                {t('deleteModal.cancel')}
              </button>
              <button
                onClick={handleDeleteProject}
                disabled={deleting || deleteConfirmText.trim() !== project.name}
                className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? t('deleteModal.submitting') : t('deleteModal.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ──────────────────────────────────────────────────────────────
// Sheet picker modal
// ──────────────────────────────────────────────────────────────

type SpreadsheetItem = { id: string; name: string; modifiedTime: string; webViewLink: string }
type TabItem = { id: number; title: string }

function SheetPickerModal({ projectId, callerId, existingBindings, onClose, onSaved }: {
  projectId: string
  callerId: string
  existingBindings?: GoogleSheetBinding[]
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('dashboard.projects.settings.sheetPicker')
  const locale = useLocale()
  const bcp47 = locale === 'nl' ? 'nl-BE' : locale
  const [step, setStep] = useState<'list' | 'tabs'>('list')
  const [spreadsheets, setSpreadsheets] = useState<SpreadsheetItem[]>([])
  const [filter, setFilter] = useState('')
  const [chosenSheet, setChosenSheet] = useState<SpreadsheetItem | null>(null)
  const [tabs, setTabs] = useState<TabItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/integrations/google/spreadsheets')
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error)
        else setSpreadsheets(d.spreadsheets ?? [])
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  async function pickSheet(sheet: SpreadsheetItem) {
    setChosenSheet(sheet)
    setStep('tabs')
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/integrations/google/spreadsheets/${sheet.id}/tabs`)
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      setTabs(d.tabs ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function saveBinding(tabName: string) {
    if (!chosenSheet) return
    setSaving(true)
    setError(null)
    const sb = createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = {
      project_id:     projectId,
      caller_id:      callerId,
      spreadsheet_id: chosenSheet.id,
      sheet_name:     tabName,
      sheet_url:      chosenSheet.webViewLink,
    }
    const { data: { user } } = await sb.auth.getUser()
    if (user) payload.created_by = user.id

    // Multi-sheet: dedup nu op (project_id, caller_id, spreadsheet_id,
    // sheet_name) i.p.v. per caller. Zo kunnen dezelfde caller MEERDERE
    // sheets koppelen zonder dat de tweede de eerste overschrijft.
    // Als de precieze combi (caller + spreadsheet + tab) al bestaat,
    // wordt de rij enkel bijgewerkt (bv. sheet_url wijzigde).
    const { error: dbErr } = await sb.from('project_google_sheets')
      .upsert(payload, { onConflict: 'project_id,caller_id,spreadsheet_id,sheet_name' })
    setSaving(false)
    if (dbErr) {
      setError(dbErr.message)
      return
    }
    onSaved()
  }

  const filtered = spreadsheets.filter(s =>
    s.name.toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="card p-6 w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">
            {step === 'list' ? t('titleList') : t('titleTabs', { sheetName: chosenSheet?.name ?? '' })}
          </h2>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-500 text-2xl leading-none">×</button>
        </div>

        {existingBindings && existingBindings.length > 0 && step === 'list' && (
          <div className="text-xs bg-gray-50 border border-gray-100 rounded-lg p-2 mb-3 text-gray-600">
            {t('alreadyLinked', { count: existingBindings.length })}
            <ul className="mt-1 space-y-0.5 pl-3">
              {existingBindings.map(b => (
                <li key={b.id} className="text-gray-500">📊 {b.sheet_name}</li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">{error}</p>
        )}

        {step === 'list' && (
          <>
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="input mb-3 text-sm"
            />
            <div className="overflow-y-auto flex-1">
              {loading ? (
                <p className="text-sm text-gray-400">{t('loadingSheets')}</p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-gray-400">{t('noSheets')}</p>
              ) : (
                <div className="space-y-1">
                  {filtered.map(s => (
                    <button
                      key={s.id}
                      onClick={() => pickSheet(s)}
                      className="w-full text-left p-2.5 rounded-lg hover:bg-gray-50 border border-gray-100 transition-colors"
                    >
                      <div className="text-sm font-medium text-gray-900 truncate">{s.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {t('lastModified', { date: new Date(s.modifiedTime).toLocaleDateString(bcp47, { day: 'numeric', month: 'short' }) })}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {step === 'tabs' && (
          <>
            <div className="overflow-y-auto flex-1">
              {loading ? (
                <p className="text-sm text-gray-400">{t('loadingTabs')}</p>
              ) : tabs.length === 0 ? (
                <p className="text-sm text-gray-400">{t('noTabs')}</p>
              ) : (
                <div className="space-y-1">
                  {tabs.map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => saveBinding(tab.title)}
                      disabled={saving}
                      className="w-full text-left p-2.5 rounded-lg hover:bg-brand-50 border border-gray-100 hover:border-brand-200 transition-colors flex items-center justify-between"
                    >
                      <span className="text-sm font-medium text-gray-900">{tab.title}</span>
                      <span className="text-xs text-brand-600">{t('pickTab')}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => { setStep('list'); setChosenSheet(null) }}
              className="text-xs text-gray-400 hover:text-gray-600 mt-3 self-start"
            >
              {t('backToList')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
