'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { Profile, Project } from '@/types/database'
import TrialBanner from '@/components/TrialBanner'
import OnboardingChecklist from '@/components/OnboardingChecklist'
import CostMetricsForProject from '@/components/CostMetricsForProject'

interface ProjectWithDetails extends Project {
  call_center_name?: string
}

type SheetBinding = {
  project_id: string
  caller_id: string
  last_synced_at: string | null
  last_sync_status: string | null
}

export default function ProjectsPage() {
  const t = useTranslations('dashboard.projects')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [projects, setProjects] = useState<ProjectWithDetails[]>([])
  const [bindings, setBindings] = useState<SheetBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [showCreateCallCenter, setShowCreateCallCenter] = useState(false)
  const [callCenterId, setCallCenterId] = useState<string | null>(null)
  const [callCenterName, setCallCenterName] = useState<string>('')

  useEffect(() => { loadData() }, [])

  async function loadData() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: p0 } = await supabase.from('profiles').select('*').eq('id', user.id).single()
    let p = p0 as Profile | null

    // Sync user_metadata → profile (defensief — voor het geval de Supabase
    // auth-trigger niet alle velden goed overneemt na registratie).
    if (p) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updates: any = {}
      const metaRole = user.user_metadata?.role
      const metaIsFreelance = Boolean(user.user_metadata?.is_freelance)
      const metaName = user.user_metadata?.full_name
      if (metaRole && p.role !== metaRole) updates.role = metaRole
      if (metaIsFreelance && !p.is_freelance) updates.is_freelance = true
      if (metaName && (!p.full_name || p.full_name.trim() === '')) updates.full_name = metaName
      if (Object.keys(updates).length > 0) {
        await supabase.from('profiles').update(updates).eq('id', user.id)
        p = { ...p, ...updates }
      }
    }
    setProfile(p)

    if (p?.role === 'cc_manager') {
      const { data: existingCc } = await supabase
        .from('call_centers')
        .select('id, name')
        .eq('manager_id', user.id)
        .maybeSingle()

      let cc = existingCc as { id: string; name: string } | null

      // Auto-create voor freelancers — zij hoeven nooit zelf een call_center
      // aan te maken (zij ZIJN hun eigen call_center).
      if (!cc && p.is_freelance) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ccInsert: any = { manager_id: user.id, name: p.full_name || 'Mijn call center' }
        const { data: newCc, error: newCcError } = await supabase
          .from('call_centers')
          .insert(ccInsert)
          .select('id, name')
          .single()
        if (newCcError) console.error('[projects] auto-create call_center mislukt:', newCcError)
        if (newCc) {
          cc = newCc as { id: string; name: string }
          await supabase
            .from('call_center_members')
            .upsert(
              { call_center_id: newCc.id, profile_id: user.id },
              { onConflict: 'call_center_id,profile_id' },
            )
        }
      }

      if (cc) { setCallCenterId(cc.id); setCallCenterName(cc.name) }
    }

    const { data: proj } = await supabase.from('projects').select('*').order('created_at', { ascending: false })
    setProjects((proj ?? []) as ProjectWithDetails[])

    // Sheet bindings ophalen voor de "Sync nu"-knop op de projectkaarten
    const { data: bnd } = await supabase
      .from('project_google_sheets')
      .select('project_id, caller_id, last_synced_at, last_sync_status')
    setBindings((bnd ?? []) as SheetBinding[])

    setLoading(false)
  }

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>

  const isManager = profile?.role === 'cc_manager'

  // Billing-overzicht: tellingen + maandelijkse kost (€49 per actief abonnement)
  const PRICE_PER_PROJECT = 49
  const activeCount    = projects.filter(p => p.subscription_status === 'active').length
  const trialingCount  = projects.filter(p => p.subscription_status === 'trialing').length
  const cancelledCount = projects.filter(p =>
    ['cancelled', 'past_due', 'paused'].includes(p.subscription_status)
  ).length
  const monthlyCost = activeCount * PRICE_PER_PROJECT

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        {isManager && callCenterId && (
          <Link href="/dashboard/projects/new" className="btn-primary">
            {t('newProject')}
          </Link>
        )}
      </div>

      {/* Onboarding-checklist — alleen voor cc_managers, verbergt zichzelf
          als alle stappen klaar zijn of na expliciete dismiss */}
      {profile && <OnboardingChecklist profileRole={profile.role} />}

      {/* Billing-overzicht — alleen voor cc_managers met projecten */}
      {isManager && projects.length > 0 && (
        <div className="card p-5 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">
                {t('billing.monthlyCost')}
              </div>
              <div className="text-2xl font-semibold text-gray-900">
                €{monthlyCost} <span className="text-sm font-normal text-gray-400">{t('billing.exclVat')}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {activeCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500"/>
                    {activeCount} {t('billing.active')}
                  </span>
                )}
                {trialingCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400"/>
                    {trialingCount} {t('billing.inTrial')}
                  </span>
                )}
                {cancelledCount > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400"/>
                    {cancelledCount} {t('billing.cancelled')}
                  </span>
                )}
              </div>
            </div>
            {activeCount > 0 && (
              <button
                onClick={async () => {
                  const res = await fetch('/api/billing/portal', { method: 'POST' })
                  const data = await res.json()
                  if (res.ok && data.url) window.location.href = data.url
                  else alert(data.error ?? t('billing.portalError'))
                }}
                className="text-sm px-3 py-2 rounded-md border border-gray-200 text-gray-700 hover:border-brand-300 hover:bg-gray-50 transition-colors flex-shrink-0 w-full sm:w-auto text-center"
                title={t('billing.managePortalTip')}
              >
                {t('billing.managePortal')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Call center aanmaken als cc_manager nog geen call center heeft */}
      {isManager && !callCenterId && (
        <div className="card p-6 mb-6 border border-amber-200 bg-amber-50">
          <h2 className="font-medium text-amber-900 mb-1">{t('callCenterBanner.title')}</h2>
          <p className="text-sm text-amber-700 mb-4">
            {t('callCenterBanner.body')}
          </p>
          <button onClick={() => setShowCreateCallCenter(true)} className="btn-primary">
            {t('callCenterBanner.button')}
          </button>
        </div>
      )}

      {/* Call center info banner */}
      {isManager && callCenterId && (
        <div className="card p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="2" width="12" height="12" rx="2" stroke="#2d4fff" strokeWidth="1.5"/>
                <path d="M5 8h6M5 5h6M5 11h3" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <div className="text-sm font-medium text-gray-900">{callCenterName}</div>
              <div className="text-xs text-gray-400">{t('callCenterInfo.label')}</div>
            </div>
          </div>
        </div>
      )}

      {/* Projectenlijst */}
      {projects.length === 0 ? (
        <div className="card p-8 sm:p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-brand-50 flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="3" stroke="#1a35e6" strokeWidth="1.5"/>
              <path d="M8 12h8M8 8h8M8 16h5" stroke="#1a35e6" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          {isManager ? (
            <>
              <h3 className="text-base font-semibold text-gray-900 mb-1.5">{t('empty.manager.title')}</h3>
              <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed mb-5">{t('empty.manager.body')}</p>
              {callCenterId ? (
                <Link href="/dashboard/projects/new" className="btn-primary inline-block text-sm">
                  {t('empty.manager.cta')}
                </Link>
              ) : (
                <p className="text-xs text-amber-600">{t('empty.manager.needCC')}</p>
              )}
            </>
          ) : (
            <>
              <h3 className="text-base font-semibold text-gray-900 mb-1.5">{t('empty.other.title')}</h3>
              <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed">{t('empty.other.body')}</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map(project => (
            <ProjectCard
              key={project.id}
              project={project}
              profile={profile}
              callCenterId={callCenterId}
              bindings={bindings.filter(b => b.project_id === project.id)}
              onSyncDone={loadData}
            />
          ))}
        </div>
      )}

      {showCreateCallCenter && (
        <CreateCallCenterModal
          onClose={() => setShowCreateCallCenter(false)}
          onCreated={() => { setShowCreateCallCenter(false); loadData() }}
        />
      )}

      {showCreateProject && callCenterId && (
        <CreateProjectModal
          callCenterId={callCenterId}
          onClose={() => setShowCreateProject(false)}
          onCreated={() => { setShowCreateProject(false); loadData() }}
        />
      )}
    </div>
  )
}

// ── PROJECT CARD ─────────────────────────────────────────────────

function ProjectCard({ project, profile, callCenterId, bindings, onSyncDone }: {
  project: ProjectWithDetails
  profile: Profile | null
  callCenterId: string | null
  bindings: SheetBinding[]
  onSyncDone: () => void
}) {
  const t = useTranslations('dashboard.projects')
  const [expanded, setExpanded] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'caller' | 'sales_rep' | 'sales_manager'>('caller')

  // Sales managers default naar 'sales_rep' (enige rol die ze mogen toevoegen)
  useEffect(() => {
    if (profile?.role === 'sales_manager') setInviteRole('sales_rep')
  }, [profile?.role])
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null)
  const [members, setMembers] = useState<{
    profile_id: string
    name: string
    email: string
    role: string
    type: string
  }[]>([])
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const isManager = profile?.role === 'cc_manager'
  const isSalesManager = profile?.role === 'sales_manager'
  const canManageMembers = isManager || isSalesManager
  // Heeft project een mapping uit een eerdere upload?
  const hasMapping = !!project.unique_id_label || !!project.last_column_mapping?.lead_name

  // Per project: welke sync-bronnen zijn geconfigureerd?
  //   - Google Sheets: één of meerdere bindings in project_google_sheets
  //   - HubSpot calls: project.hubspot_calls_list_id != null
  //   - Lemlist:        project.lemlist_campaign_id  != null
  // De knop verschijnt zodra minstens één bron actief is. Voor HubSpot
  // en Lemlist is geen kolom-mapping nodig (data komt rechtstreeks gestructureerd
  // binnen) — alleen Google Sheets vereist nog de mapping-check.
  const sheetBindings   = bindings.filter(b => b.project_id === project.id)
  const hasHubSpotList  = !!project.hubspot_calls_list_id
  const hasLemlistCamp  = !!project.lemlist_campaign_id
  const canSyncSheets   = sheetBindings.length > 0 && hasMapping
  const canSync         = isManager && (canSyncSheets || hasHubSpotList || hasLemlistCamp)

  async function handleSyncAll(e: React.MouseEvent) {
    e.stopPropagation() // voorkom dat de card uitklapt
    if (!canSync) return
    setSyncing(true)
    setSyncMsg(null)
    let totalImported = 0
    const summaryParts: string[] = []
    let firstError: string | null = null

    // 1. Google Sheets — per caller
    if (canSyncSheets) {
      for (const b of sheetBindings) {
        try {
          const res = await fetch(`/api/projects/${project.id}/google-sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caller_id: b.caller_id }),
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
      summaryParts.push(`${sheetBindings.length} sheet${sheetBindings.length !== 1 ? 's' : ''}`)
    }

    // 2. HubSpot calls
    if (hasHubSpotList) {
      try {
        const res = await fetch(`/api/integrations/hubspot-cc/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: project.id, days_back: 7 }),
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
    }

    // 3. Lemlist
    if (hasLemlistCamp) {
      try {
        const res = await fetch(`/api/integrations/lemlist/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: project.id }),
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
      const text = totalImported > 0
        ? `✓ ${totalImported} nieuwe lead${totalImported !== 1 ? 's' : ''}/call${totalImported !== 1 ? 's' : ''} gesynced (${sources}).`
        : `✓ Geen nieuwe data gevonden (${sources}).`
      setSyncMsg({ type: 'ok', text })
      onSyncDone()
    }
  }

  useEffect(() => { if (expanded) loadMembers() }, [expanded])

  async function loadMembers() {
    const supabase = createClient()

    type EmbeddedProfile = { full_name: string | null; email: string | null } | null
    type ProjectMemberRow = { profile_id: string; role: string; profiles: EmbeddedProfile }
    type CCMemberRow = { call_center_id: string; call_centers: { name: string | null } | null }

    // Alle expliciete project members (zowel sales reps als cold callers).
    const { data: projectMembers } = await supabase
      .from('project_members')
      .select('profile_id, role, profiles(full_name, email)')
      .eq('project_id', project.id)
      .returns<ProjectMemberRow[]>()

    // Gekoppelde call centers (informatief — niet meer auto-uitvouwen naar leden).
    const { data: ccMembers } = await supabase
      .from('project_call_centers')
      .select('call_center_id, call_centers(name)')
      .eq('project_id', project.id)
      .returns<CCMemberRow[]>()

    setMembers([
      // Call center info als banner (geen profile_id — niet verwijderbaar)
      ...(ccMembers ?? []).map(m => ({
        profile_id: '',
        name: m.call_centers?.name ?? 'Onbekend call center',
        email: '',
        role: 'call_center',
        type: 'callcenter',
      })),
      // Expliciet toegevoegde leden — geclassificeerd op rol
      ...(projectMembers ?? []).map(m => ({
        profile_id: m.profile_id,
        name: m.profiles?.full_name ?? 'Onbekend',
        email: m.profiles?.email ?? '',
        role: m.role,
        type:
          m.role === 'cold_caller'   ? 'caller' :
          m.role === 'sales_manager' ? 'sales_manager' :
                                       'sales_rep',
      })),
    ])
  }

  /**
   * Verwijder een lid uit het project. RLS bepaalt of de actie lukt:
   *   - cc_manager mag alle rollen verwijderen
   *   - sales_manager mag alleen sales_rep verwijderen
   */
  async function handleRemove(profileId: string, memberName: string) {
    if (!confirm(`${memberName} verwijderen uit dit project?`)) return
    setRemovingId(profileId)
    const supabase = createClient()
    const { error } = await supabase
      .from('project_members')
      .delete()
      .eq('project_id', project.id)
      .eq('profile_id', profileId)
    setRemovingId(null)
    if (error) {
      alert(`Verwijderen mislukt: ${error.message}`)
      return
    }
    loadMembers()
  }

  async function handleInvite() {
    if (!inviteEmail.trim()) return
    setInviteLoading(true)
    setInviteError(null)
    setInviteSuccess(null)

    // Sales managers mogen alleen sales_reps toevoegen — extra permissie-check
    // bovenop wat de API + RLS afdwingt.
    if (isSalesManager && inviteRole !== 'sales_rep') {
      setInviteError('Als sales manager kan je alleen sales reps aan het project toevoegen.')
      setInviteLoading(false)
      return
    }

    // UI-rol → API-rol mapping. 'caller' is een wizard-specifieke alias voor cold_caller.
    const apiRole: 'cold_caller' | 'sales_rep' | 'sales_manager' =
      inviteRole === 'caller' ? 'cold_caller' : inviteRole

    try {
      const res = await fetch('/api/invites/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: project.id,
          email:      inviteEmail.trim().toLowerCase(),
          role:       apiRole,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setInviteError(data.error ?? 'Toevoegen mislukt')
        setInviteLoading(false)
        return
      }

      // type: 'added' = bestaande user direct gekoppeld + 'added' mail gestuurd.
      // type: 'invited' = nieuwe email, invite-link verstuurd voor account-creatie.
      setInviteSuccess(data.message ?? 'Verzonden.')
      setInviteEmail('')
      setInviteLoading(false)
      // Alleen 'added' toont meteen een nieuw lid in de leden-lijst —
      // pending invites tonen we hier nog niet.
      if (data.type === 'added') loadMembers()
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : 'Onbekende fout')
      setInviteLoading(false)
    }
  }

  return (
    <div className="card overflow-hidden">
      <div
        className="p-4 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-50 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 4H14M2 8H14M2 12H9" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div className="font-medium text-gray-900 text-sm flex items-center gap-2">
              {project.name}
              {/* Trial-status enkel voor cc_manager — andere rollen hoeven
                  niet te weten wanneer de trial afloopt of of er betaald wordt. */}
              {isManager && <TrialBanner project={project} variant="compact" />}
            </div>
            {project.description && (
              <div className="text-xs text-gray-400 mt-0.5">{project.description}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap justify-end">
          {canSync && (
            <button
              onClick={handleSyncAll}
              disabled={syncing}
              className="text-xs px-3 py-1.5 rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
              title={t('card.syncTip')}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M2 8a6 6 0 0110.5-4M14 8a6 6 0 01-10.5 4M11 4h3V1M5 12H2v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {syncing ? t('card.syncing') : t('card.syncNow')}
            </button>
          )}
          {isManager && (
            <>
              <a
                href={`/dashboard/projects/${project.id}/settings`}
                onClick={e => e.stopPropagation()}
                className="text-xs px-3 py-1.5 rounded-md border border-gray-200 text-gray-700 hover:border-brand-300 hover:text-brand-700 transition-colors inline-flex items-center gap-1.5"
                title={t('card.settingsTip')}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                {t('card.settings')}
              </a>
              <a
                href={`/dashboard/projects/${project.id}/report`}
                onClick={e => e.stopPropagation()}
                className="text-xs px-3 py-1.5 rounded-md border border-gray-200 text-gray-700 hover:border-brand-300 hover:text-brand-700 transition-colors inline-flex items-center gap-1.5"
                title={t('card.reportTip')}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M4 2h6l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M10 2v4h4M5 9h6M5 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                {t('card.report')}
              </a>
            </>
          )}
          <span className="badge badge-green">{t('card.active')}</span>
          <svg
            width="14" height="14" viewBox="0 0 16 16" fill="none"
            className={`text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {syncMsg && (
        <div className={`px-4 py-2 text-xs border-t ${
          syncMsg.type === 'ok'
            ? 'bg-green-50 text-green-700 border-green-100'
            : 'bg-red-50 text-red-700 border-red-100'
        }`}>
          {syncMsg.text}
        </div>
      )}
      {expanded && (
        <div className="border-t border-gray-100 p-4">
          {members.length > 0 && (
            <div className="mb-4">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">{t('members.title')}</div>
              <div className="space-y-1.5">
                {members.map((m, i) => {
                  // Mag deze user dit lid verwijderen?
                  //   - Call_center info-banner: nooit (geen profile_id)
                  //   - cc_manager: ja, alle members
                  //   - sales_manager: alleen sales_rep
                  const canRemove =
                    m.profile_id !== '' &&
                    (isManager || (isSalesManager && m.role === 'sales_rep'))
                  return (
                    <div key={i} className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm flex-wrap">
                      <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 flex-shrink-0">
                        {m.name[0]}
                      </div>
                      <span className="text-gray-700 truncate max-w-[150px] sm:max-w-none">{m.name}</span>
                      <span className={`badge ml-auto ${
                        m.type === 'sales_manager' ? 'badge-amber' :
                        m.type === 'sales_rep'     ? 'badge-purple' :
                        m.type === 'caller'        ? 'badge-blue'   :
                                                     'badge-gray'
                      }`}>
                        {m.type === 'sales_manager' ? t('members.roles.sales_manager') :
                         m.type === 'sales_rep'     ? t('members.roles.sales_rep') :
                         m.type === 'caller'        ? t('members.roles.caller') :
                                                      t('members.roles.call_center')}
                      </span>
                      {canRemove && (
                        <button
                          onClick={() => handleRemove(m.profile_id, m.name)}
                          disabled={removingId === m.profile_id}
                          className="text-gray-300 hover:text-red-500 transition-colors text-lg leading-none px-1"
                          title={t('members.removeTip', { name: m.name })}
                        >
                          {removingId === m.profile_id ? '…' : '×'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {canManageMembers && (
            <div>
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
                {t('invite.title')}
              </div>
              <div className="flex flex-col sm:flex-row gap-2 mb-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleInvite()}
                  placeholder={t('invite.emailPlaceholder')}
                  className="input flex-1 text-sm"
                />
                <div className="flex gap-2">
                  <select
                    value={inviteRole}
                    onChange={e => setInviteRole(e.target.value as 'caller' | 'sales_rep' | 'sales_manager')}
                    className="input flex-1 sm:flex-none sm:w-40 text-sm"
                    disabled={isSalesManager}
                    title={isSalesManager ? t('invite.roleDisabledTip') : undefined}
                  >
                    {isManager && <option value="caller">{t('invite.roles.caller')}</option>}
                    <option value="sales_rep">{t('invite.roles.sales_rep')}</option>
                    {isManager && <option value="sales_manager">{t('invite.roles.sales_manager')}</option>}
                  </select>
                  <button
                    onClick={handleInvite}
                    disabled={inviteLoading || !inviteEmail}
                    className="btn-primary text-sm px-3 whitespace-nowrap"
                  >
                    {inviteLoading ? t('invite.submitting') : t('invite.submit')}
                  </button>
                </div>
              </div>
              {inviteError && (
                <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{inviteError}</p>
              )}
              {inviteSuccess && (
                <p className="text-xs text-green-600 bg-green-50 px-3 py-2 rounded-lg">✓ {inviteSuccess}</p>
              )}
              <p className="text-xs text-gray-400 mt-2">
                {t('invite.footer')}
              </p>
            </div>
          )}

          {/* Tijd & kost-metrics — alleen voor cc_manager, alleen wanneer het
              project tarieven heeft. Anders rendert de component zichzelf niet. */}
          {isManager && (
            <div className="mt-4 pt-4 border-t border-gray-100">
              <CostMetricsForProject
                projectId={project.id}
                fromIso={new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}
                toIso={new Date().toISOString()}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── MODALS ───────────────────────────────────────────────────────

function CreateCallCenterModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useTranslations('dashboard.projects.createCallCenter')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    if (!name.trim()) return
    setLoading(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setError(t('notLoggedIn')); setLoading(false); return }
    const { data: cc, error } = await supabase
      .from('call_centers')
      .insert({ manager_id: user.id, name: name.trim() })
      .select('id')
      .single()
    if (error || !cc) { setError(error?.message ?? t('createFailed')); setLoading(false); return }

    // Voeg de manager ook meteen als member toe — anders kan hij zelf niet
    // uploaden via /dashboard/upload (die queryt op call_center_members).
    await supabase
      .from('call_center_members')
      .upsert(
        { call_center_id: cc.id, profile_id: user.id },
        { onConflict: 'call_center_id,profile_id' },
      )

    onCreated()
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="card p-6 w-full max-w-md">
        <h2 className="font-semibold text-gray-900 mb-4">{t('title')}</h2>
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('nameLabel')}</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} className="input" placeholder={t('namePlaceholder')} autoFocus />
        </div>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary flex-1">{t('cancel')}</button>
          <button onClick={handleCreate} disabled={loading || !name.trim()} className="btn-primary flex-1">
            {loading ? t('submitting') : t('submit')}
          </button>
        </div>
      </div>
    </div>
  )
}

function CreateProjectModal({ callCenterId, onClose, onCreated }: {
  callCenterId: string; onClose: () => void; onCreated: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    if (!name.trim()) return
    setLoading(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setError('Niet ingelogd'); setLoading(false); return }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.rpc as any)('create_project', {
      p_name:        name.trim(),
      p_description: description.trim() || null,
    })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    onCreated()
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="card p-6 w-full max-w-md">
        <h2 className="font-semibold text-gray-900 mb-4">Nieuw project</h2>
        <div className="space-y-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Naam</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} className="input" autoFocus />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Beschrijving (optioneel)</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} className="input resize-none" rows={2} />
          </div>
        </div>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary flex-1">Annuleren</button>
          <button onClick={handleCreate} disabled={loading || !name.trim()} className="btn-primary flex-1">
            {loading ? 'Aanmaken…' : 'Aanmaken'}
          </button>
        </div>
      </div>
    </div>
  )
}
