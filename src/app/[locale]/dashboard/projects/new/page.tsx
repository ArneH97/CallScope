'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { Profile, UploadSource, FeedbackSource } from '@/types/database'

type Step = 'basics' | 'sources' | 'members' | 'finalize'
type MemberRole = 'cold_caller' | 'sales_rep' | 'sales_manager'

type DraftMember = {
  id: string                // local UI id
  email: string
  role: MemberRole
  // Resolved tijdens save: of de email een bestaand profile heeft
  resolved?: { profile_id: string; full_name: string } | null
}

const STEP_KEYS: Step[] = ['basics', 'sources', 'members', 'finalize']

export default function NewProjectWizard() {
  const t = useTranslations('dashboard.projects.new')
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [step, setStep] = useState<Step>('basics')

  // Step 1 — Basics
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Step 2 — Sources
  const [uploadSource, setUploadSource] = useState<UploadSource>('manual')
  const [feedbackSource, setFeedbackSource] = useState<FeedbackSource>('manual')

  // Step 3 — Members
  const [members, setMembers] = useState<DraftMember[]>([
    { id: crypto.randomUUID(), email: '', role: 'cold_caller' },
  ])

  // Step 4 — Default rep
  const [defaultRepId, setDefaultRepId] = useState<string>('')

  // Submit state
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Billing-context: hoeveel projecten heeft deze cc_manager al + hoeveel actief?
  // Bepaalt of het 1ste/2de+ project is, en of creation überhaupt toegestaan is.
  type BillingContext = {
    existingCount: number
    activeCount:   number
    /** True als ze geen nieuw project mogen maken (existing>0, active=0). */
    blocked: boolean
    /** True als dit een 2de+ project is dat directe betaling vereist. */
    requiresImmediatePayment: boolean
  }
  const [billingContext, setBillingContext] = useState<BillingContext | null>(null)

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/auth/login'); return }
      const { data: prof } = await sb.from('profiles').select('*').eq('id', user.id).single()
      setProfile(prof as Profile | null)
      if ((prof as Profile | null)?.role !== 'cc_manager') {
        // Alleen cc_managers mogen projecten aanmaken
        router.push('/dashboard/projects')
        return
      }

      // Tel bestaande projecten van deze cc_manager + actieve subscriptions.
      // Via call_center → project_call_centers → projects.
      const { data: ccRow } = await sb
        .from('call_centers')
        .select('id')
        .eq('manager_id', user.id)
        .maybeSingle()
      const ccId = (ccRow as { id: string } | null)?.id
      if (!ccId) {
        setBillingContext({ existingCount: 0, activeCount: 0, blocked: false, requiresImmediatePayment: false })
        return
      }

      const { data: pccRows } = await sb
        .from('project_call_centers')
        .select('project_id, projects!inner(subscription_status)')
        .eq('call_center_id', ccId)

      type Row = { project_id: string; projects: { subscription_status: string } | { subscription_status: string }[] | null }
      const rows = (pccRows ?? []) as unknown as Row[]
      let existing = 0, active = 0
      for (const r of rows) {
        existing++
        const p = Array.isArray(r.projects) ? r.projects[0] : r.projects
        if (p?.subscription_status === 'active') active++
      }
      setBillingContext({
        existingCount:            existing,
        activeCount:              active,
        blocked:                  existing > 0 && active === 0,
        requiresImmediatePayment: existing > 0 && active > 0,
      })
    })
  }, [router])

  // ── Step navigation ────────────────────────────────────────────────────
  const stepIndex = STEP_KEYS.findIndex(s => s === step)
  function next() {
    if (stepIndex < STEP_KEYS.length - 1) setStep(STEP_KEYS[stepIndex + 1])
  }
  function prev() {
    if (stepIndex > 0) setStep(STEP_KEYS[stepIndex - 1])
  }

  function canProceedFromStep(s: Step): boolean {
    if (s === 'basics')   return name.trim().length > 0
    if (s === 'sources')  return true
    if (s === 'members')  return true  // members zijn optioneel — kan later toegevoegd
    if (s === 'finalize') return name.trim().length > 0
    return false
  }

  // ── Member helpers ─────────────────────────────────────────────────────
  function updateMember(id: string, patch: Partial<DraftMember>) {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m))
  }
  function addMemberRow() {
    setMembers(prev => [...prev, { id: crypto.randomUUID(), email: '', role: 'cold_caller' }])
  }
  function removeMember(id: string) {
    setMembers(prev => prev.filter(m => m.id !== id))
  }

  // Lijst van geldige (= ingevulde) sales reps voor de default-rep dropdown.
  // Default rep moet uit de leden-lijst komen, anders kan hij niet matchen
  // bij de auto-toewijzing van afspraken.
  const candidateReps = members.filter(m =>
    m.email.trim() !== '' && (m.role === 'sales_rep' || m.role === 'sales_manager')
  )

  // ── Submit ─────────────────────────────────────────────────────────────
  async function handleSubmit() {
    setSubmitting(true)
    setSubmitError(null)
    const sb = createClient()

    const validMembers = members.filter(m => m.email.trim() !== '')

    // 1) Project aanmaken — default rep zetten we later (we kennen profile_ids
    //    pas na de invite-API). RPC = create_project, atomair project + pcc-link.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: created, error: cpErr } = await (sb.rpc as any)('create_project', {
      p_name:                 name.trim(),
      p_description:          description.trim() || null,
      p_upload_source:        uploadSource,
      p_feedback_source:      feedbackSource,
      p_default_sales_rep_id: null,
    })
    if (cpErr || !created) {
      setSubmitError(t('errors.createFailed', { error: cpErr?.message ?? t('errors.unknownError') }))
      setSubmitting(false)
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projectId = (created as any).id as string

    // 2) Leden via /api/invites/send. Bestaande emails → directe project_member
    //    + 'added' mail. Nieuwe emails → token-based invite + 'invited' mail.
    //    We verzamelen profile_ids voor 'added' resultaten zodat we de gekozen
    //    default rep eronder kunnen mappen op een echte user.
    const inviteResults: { draftId: string; email: string; role: MemberRole; profile_id?: string }[] = []
    const inviteFailures: string[] = []

    for (const m of validMembers) {
      try {
        const res = await fetch('/api/invites/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            email:      m.email.trim().toLowerCase(),
            role:       m.role,
          }),
        })
        const data = await res.json()
        if (!res.ok) {
          inviteFailures.push(`${m.email}: ${data.error ?? t('errors.unknownError')}`)
        } else {
          inviteResults.push({
            draftId:    m.id,
            email:      m.email.trim().toLowerCase(),
            role:       m.role,
            profile_id: data.profile_id, // alleen aanwezig bij type='added'
          })
        }
      } catch (e) {
        inviteFailures.push(`${m.email}: ${e instanceof Error ? e.message : t('errors.networkError')}`)
      }
    }

    // 3) Default rep updaten — alleen mogelijk als die persoon al een profile
    //    had (= 'added'-pad). Voor nieuw uitgenodigde reps kan de cc-manager
    //    deze instelling later in de project-settings zetten zodra ze accept'en.
    if (defaultRepId) {
      const chosen = inviteResults.find(r => r.draftId === defaultRepId)
      if (chosen?.profile_id) {
        await sb.from('projects')
          .update({ default_sales_rep_id: chosen.profile_id })
          .eq('id', projectId)
      }
    }

    if (inviteFailures.length > 0) {
      // Project is wel aangemaakt — we tonen de fouten maar gaan verder met
      // de redirect zodat de user niet dubbel hoeft te klikken.
      console.warn('[wizard] invite failures:', inviteFailures)
    }

    // 5) Redirect-logic:
    //    a) 2de+ project (subscription_status='past_due' meteen na create) →
    //       direct naar Stripe Checkout zodat de cc-manager meteen betaalt.
    //    b) 1ste project (trialing) + Google Sheets bron → naar settings voor
    //       sheet-koppeling.
    //    c) Default → naar projecten-overzicht.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createdStatus = (created as any).subscription_status as string

    if (createdStatus === 'past_due') {
      // 2de+ project — auto-launch Stripe checkout
      try {
        const checkoutRes = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId }),
        })
        const checkoutData = await checkoutRes.json()
        if (checkoutRes.ok && checkoutData.url) {
          window.location.href = checkoutData.url
          return
        }
        // Checkout-creatie faalde → toon error en redirect naar billing waar de
        // user zelf opnieuw kan klikken
        setSubmitError(
          t('errors.checkoutFailed', { error: checkoutData.error ?? t('errors.unknownError') }),
        )
        setSubmitting(false)
        return
      } catch (e) {
        setSubmitError(
          t('errors.checkoutError', {
            error:     e instanceof Error ? e.message : t('errors.unknownError'),
            projectId,
          }),
        )
        setSubmitting(false)
        return
      }
    }

    setSubmitting(false)
    // Bronnen die per-project setup vereisen (HubSpot list-koppeling, Google
    // Sheets binding, Lemlist campaign) → redirect naar settings met een
    // onboarding-hint zodat de gebruiker direct weet wat te doen.
    if (uploadSource === 'hubspot' || feedbackSource === 'hubspot') {
      router.push(`/dashboard/projects/${projectId}/settings?onboarding=hubspot`)
    } else if (uploadSource === 'google_sheets') {
      router.push(`/dashboard/projects/${projectId}/settings?onboarding=google_sheets`)
    } else if (uploadSource === 'lemlist') {
      router.push(`/dashboard/projects/${projectId}/settings?onboarding=lemlist`)
    } else {
      router.push('/dashboard/projects')
    }
  }

  if (!profile || !billingContext) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>

  // Geblokkeerd: bestaand project zonder actief abonnement → moet eerst activeren.
  if (billingContext.blocked) {
    return (
      <div className="max-w-2xl">
        <div className="mb-6">
          <Link href="/dashboard/projects" className="text-sm text-gray-400 hover:text-gray-600 inline-flex items-center gap-1.5 mb-3">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t('blocked.back')}
          </Link>
          <h1 className="text-2xl font-semibold text-gray-900">{t('blocked.title')}</h1>
        </div>

        <div className="card p-6 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.5L1.5 13.5h13L8 1.5z" stroke="#d97706" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M8 6v3M8 11.5v.5" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-amber-900 mb-1">
                {t('blocked.heading')}
              </h2>
              <p className="text-sm text-amber-800 leading-relaxed">
                {t('blocked.body')}
              </p>
              <p className="text-xs text-amber-700 mt-2">
                {t('blocked.pricing')}
              </p>
            </div>
          </div>
          <Link
            href="/dashboard/projects"
            className="btn-primary inline-block mt-4"
          >
            {t('blocked.cta')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link href="/dashboard/projects" className="text-sm text-gray-400 hover:text-gray-600 inline-flex items-center gap-1.5 mb-3">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('cancel')}
        </Link>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 sm:gap-2 mb-8 flex-wrap">
        {STEP_KEYS.map((s, i) => (
          <div key={s} className="flex items-center gap-1 sm:gap-2">
            <div className={`flex items-center gap-1 sm:gap-1.5 text-xs sm:text-sm ${
              i < stepIndex  ? 'text-green-600' :
              i === stepIndex ? 'text-brand-700 font-medium' :
                                'text-gray-300'
            }`}>
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs flex-shrink-0 ${
                i < stepIndex  ? 'bg-green-100' :
                i === stepIndex ? 'bg-brand-100' :
                                  'bg-gray-100'
              }`}>
                {i < stepIndex ? '✓' : i + 1}
              </div>
              {t(`steps.${s}`)}
            </div>
            {i < STEP_KEYS.length - 1 && <div className="w-3 sm:w-6 h-px bg-gray-200"/>}
          </div>
        ))}
      </div>

      <div className="card p-6">
        {step === 'basics' && (
          <div>
            <h2 className="font-medium text-gray-900 mb-4">{t('basics.heading')}</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('basics.nameLabel')}</label>
                <input
                  type="text" value={name} onChange={e => setName(e.target.value)}
                  className="input" placeholder={t('basics.namePlaceholder')} autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('basics.descLabel')} <span className="text-gray-400 font-normal">{t('basics.descOptional')}</span>
                </label>
                <textarea
                  value={description} onChange={e => setDescription(e.target.value)}
                  className="input resize-none" rows={3}
                  placeholder={t('basics.descPlaceholder')}
                />
              </div>
            </div>
          </div>
        )}

        {step === 'sources' && (
          <div>
            <h2 className="font-medium text-gray-900 mb-1">{t('sources.heading')}</h2>
            <p className="text-sm text-gray-500 mb-5">
              {t('sources.subtitle')}
            </p>

            <div className="mb-6">
              <div className="text-sm font-medium text-gray-700 mb-2">
                {t('sources.uploadLabel')} <span className="text-red-400">{t('sources.required')}</span>
              </div>
              <p className="text-xs text-gray-500 mb-2">
                {t('sources.uploadHint')}
              </p>
              <div className="space-y-2">
                <SourceCard
                  active={uploadSource === 'manual'}
                  onClick={() => setUploadSource('manual')}
                  title={t('sources.upload.manual.title')}
                  desc={t('sources.upload.manual.desc')}
                  icon="📄"
                  comingSoonLabel={t('sources.comingSoon')}
                />
                <SourceCard
                  active={uploadSource === 'google_sheets'}
                  onClick={() => setUploadSource('google_sheets')}
                  title={t('sources.upload.google_sheets.title')}
                  desc={t('sources.upload.google_sheets.desc')}
                  icon="📊"
                  comingSoonLabel={t('sources.comingSoon')}
                />
                <SourceCard
                  active={uploadSource === 'lemlist'}
                  onClick={() => setUploadSource('lemlist')}
                  title={t('sources.upload.lemlist.title')}
                  desc={t('sources.upload.lemlist.desc')}
                  icon="🔌"
                  comingSoonLabel={t('sources.comingSoon')}
                />
                <SourceCard
                  active={uploadSource === 'hubspot'}
                  onClick={() => setUploadSource('hubspot')}
                  title={t('sources.upload.hubspot.title')}
                  desc={t('sources.upload.hubspot.desc')}
                  icon="🟠"
                  comingSoonLabel={t('sources.comingSoon')}
                />
                <SourceCard
                  active={false}
                  disabled
                  title={t('sources.upload.future.title')}
                  desc={t('sources.upload.future.desc')}
                  icon="🔌"
                  comingSoonLabel={t('sources.comingSoon')}
                />
              </div>
              {uploadSource === 'lemlist' && (
                <div
                  className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-800"
                  dangerouslySetInnerHTML={{ __html: t('sources.warnings.lemlist') }}
                />
              )}
              {uploadSource === 'hubspot' && (
                <div
                  className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-800"
                  dangerouslySetInnerHTML={{ __html: t('sources.warnings.hubspotUpload') }}
                />
              )}
            </div>

            <div>
              <div className="text-sm font-medium text-gray-700 mb-2">
                {t('sources.feedbackLabel')} <span className="text-red-400">{t('sources.required')}</span>
              </div>
              <p className="text-xs text-gray-500 mb-2">
                {t('sources.feedbackHint')}
              </p>
              <div className="space-y-2">
                <SourceCard
                  active={feedbackSource === 'manual'}
                  onClick={() => setFeedbackSource('manual')}
                  title={t('sources.feedback.manual.title')}
                  desc={t('sources.feedback.manual.desc')}
                  icon="✍️"
                  comingSoonLabel={t('sources.comingSoon')}
                />
                <SourceCard
                  active={feedbackSource === 'google_sheets'}
                  onClick={() => setFeedbackSource('google_sheets')}
                  title={t('sources.feedback.google_sheets.title')}
                  desc={t('sources.feedback.google_sheets.desc')}
                  icon="📊"
                  comingSoonLabel={t('sources.comingSoon')}
                />
                <SourceCard
                  active={feedbackSource === 'hubspot'}
                  onClick={() => setFeedbackSource('hubspot')}
                  title={t('sources.feedback.hubspot.title')}
                  desc={t('sources.feedback.hubspot.desc')}
                  icon="🔌"
                  comingSoonLabel={t('sources.comingSoon')}
                />
              </div>
              {feedbackSource === 'google_sheets' && uploadSource !== 'google_sheets' && (
                <div className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-800">
                  {t('sources.warnings.googleFeedbackNeedsGoogleUpload')}
                </div>
              )}
              {feedbackSource === 'hubspot' && (
                <div
                  className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-800"
                  dangerouslySetInnerHTML={{ __html: t('sources.warnings.hubspotFeedback') }}
                />
              )}
            </div>
          </div>
        )}

        {step === 'members' && (
          <div>
            <h2 className="font-medium text-gray-900 mb-1">{t('members.heading')}</h2>
            <p className="text-sm text-gray-500 mb-3">
              {t('members.subtitle')}
            </p>
            <div className="mb-5 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800 leading-relaxed">
              {t('members.tip')}
            </div>

            <div className="space-y-3 sm:space-y-2 mb-3">
              {members.map(m => (
                <div key={m.id} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <input
                    type="email"
                    value={m.email}
                    onChange={e => updateMember(m.id, { email: e.target.value })}
                    placeholder={t('members.emailPlaceholder')}
                    className="input flex-1"
                  />
                  <div className="flex items-center gap-2">
                    <select
                      value={m.role}
                      onChange={e => updateMember(m.id, { role: e.target.value as MemberRole })}
                      className="input flex-1 sm:flex-none sm:w-44"
                    >
                      <option value="cold_caller">{t('members.roles.cold_caller')}</option>
                      <option value="sales_rep">{t('members.roles.sales_rep')}</option>
                      <option value="sales_manager">{t('members.roles.sales_manager')}</option>
                    </select>
                    <button
                      onClick={() => removeMember(m.id)}
                      className="text-gray-300 hover:text-red-500 transition-colors px-2 flex-shrink-0"
                      type="button"
                      title={t('members.removeTip')}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={addMemberRow}
              type="button"
              className="text-xs text-brand-600 hover:underline"
            >
              {t('members.addRow')}
            </button>
          </div>
        )}

        {step === 'finalize' && (
          <div>
            <h2 className="font-medium text-gray-900 mb-1">{t('finalize.heading')}</h2>
            <p className="text-sm text-gray-500 mb-5">{t('finalize.subtitle')}</p>

            {/* Summary */}
            <div className="space-y-3 mb-5 text-sm">
              <SummaryRow label={t('finalize.summary.name')} value={name} />
              {description && <SummaryRow label={t('finalize.summary.description')} value={description} />}
              <SummaryRow label={t('finalize.summary.uploadSource')} value={
                uploadSource === 'google_sheets' ? t('finalize.summary.uploadGoogle') : t('finalize.summary.uploadManual')
              } />
              <SummaryRow label={t('finalize.summary.feedbackSource')} value={
                feedbackSource === 'google_sheets' ? t('finalize.summary.feedbackGoogle') : t('finalize.summary.feedbackManual')
              } />
              <SummaryRow
                label={t('finalize.summary.membersLabel', { count: members.filter(m => m.email.trim()).length })}
                value={
                  members.filter(m => m.email.trim()).length === 0
                    ? t('finalize.summary.noMembers')
                    : members.filter(m => m.email.trim()).map(m => `${m.email} (${t(`members.roles.${m.role}`)})`).join(', ')
                }
              />
            </div>

            <div className="mb-5">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('finalize.defaultRepLabel')} <span className="text-gray-400 font-normal">{t('finalize.defaultRepOptional')}</span>
              </label>
              <select
                value={defaultRepId}
                onChange={e => setDefaultRepId(e.target.value)}
                className="input"
                disabled={candidateReps.length === 0}
              >
                <option value="">{t('finalize.defaultRepNone')}</option>
                {candidateReps.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.email} ({c.role === 'sales_manager' ? t('members.roles.manager') : t('members.roles.rep')})
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {t('finalize.defaultRepHint')}
              </p>
            </div>

            {billingContext.requiresImmediatePayment ? (
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800 mb-3">
                {t('finalize.paymentBanner', { ordinal: billingContext.existingCount + 1 })}
              </div>
            ) : (
              <div className="p-3 bg-green-50 border border-green-100 rounded-lg text-xs text-green-800 mb-3">
                {t('finalize.trialBanner')}
              </div>
            )}

            {uploadSource === 'google_sheets' && !billingContext.requiresImmediatePayment && (
              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800 mb-3">
                {t('finalize.googleNextBanner')}
              </div>
            )}

            {submitError && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700 mb-3">
                {submitError}
              </div>
            )}
          </div>
        )}

        {/* Navigation */}
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-6 mt-6 border-t border-gray-100">
          <button
            type="button"
            onClick={prev}
            disabled={stepIndex === 0 || submitting}
            className="text-sm text-gray-500 hover:text-gray-700 disabled:invisible py-2 sm:py-0 text-center sm:text-left"
          >
            {t('nav.previous')}
          </button>
          {step !== 'finalize' ? (
            <button
              type="button"
              onClick={next}
              disabled={!canProceedFromStep(step)}
              className="btn-primary w-full sm:w-auto"
            >
              {t('nav.next')}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !canProceedFromStep('finalize')}
              className="btn-primary w-full sm:w-auto"
            >
              {submitting ? t('nav.submitting') : t('nav.submit')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SourceCard({
  active, disabled, title, desc, icon, onClick, comingSoonLabel,
}: {
  active: boolean
  disabled?: boolean
  title: string
  desc: string
  icon: string
  onClick?: () => void
  comingSoonLabel: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg border transition-colors ${
        active
          ? 'border-brand-300 bg-brand-50'
          : disabled
            ? 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
            : 'border-gray-200 hover:border-brand-200 hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="text-xl flex-shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
            {title}
            {disabled && <span className="badge badge-gray text-xs">{comingSoonLabel}</span>}
          </div>
          <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
        </div>
        {active && (
          <div className="w-5 h-5 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 8L7 12L13 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        )}
      </div>
    </button>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
      <span className="text-gray-500 flex-shrink-0 text-xs sm:text-sm">{label}</span>
      <span className="text-gray-900 sm:text-right break-words">{value}</span>
    </div>
  )
}
