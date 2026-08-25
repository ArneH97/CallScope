'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { GoogleIntegration, Profile } from '@/types/database'

const ERROR_FLAG_KEYS = [
  'missing_params',
  'state_mismatch',
  'token_exchange_failed',
  'no_refresh_token',
  'db_save_failed',
  'access_denied',
  'hubspot_missing_params',
  'hubspot_state_mismatch',
  'hubspot_token_exchange_failed',
  'hubspot_no_refresh_token',
  'hubspot_db_save_failed',
  'hubspot_access_denied',
] as const

type ErrorFlagKey = typeof ERROR_FLAG_KEYS[number]

function isErrorFlagKey(flag: string): flag is ErrorFlagKey {
  return (ERROR_FLAG_KEYS as readonly string[]).includes(flag)
}

type HubSpotIntegrationLite = {
  hubspot_account_name: string | null
  hubspot_user_email:   string | null
  hubspot_account_id:   string | null
  connected_at:         string
}

type LemlistIntegrationLite = {
  lemlist_team_name:  string | null
  lemlist_user_email: string | null
  connected_at:       string
}

function IntegrationsContent() {
  const t = useTranslations('dashboard.settings.integrations')
  const searchParams = useSearchParams()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [google, setGoogle] = useState<Pick<GoogleIntegration, 'google_email' | 'connected_at'> | null>(null)
  const [hubspot, setHubspot] = useState<HubSpotIntegrationLite | null>(null)
  const [lemlist, setLemlist] = useState<LemlistIntegrationLite | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnectingGoogle, setDisconnectingGoogle] = useState(false)
  const [disconnectingHubspot, setDisconnectingHubspot] = useState(false)
  const [disconnectingLemlist, setDisconnectingLemlist] = useState(false)
  const [syncingHubspot, setSyncingHubspot] = useState(false)
  const [syncingHubspotCalls, setSyncingHubspotCalls] = useState(false)
  const [syncingLemlist, setSyncingLemlist] = useState(false)
  const [syncMessage, setSyncMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [lemlistApiKey, setLemlistApiKey] = useState('')
  const [connectingLemlist, setConnectingLemlist] = useState(false)
  const [lemlistError, setLemlistError] = useState<string | null>(null)

  const successFlag = searchParams.get('success')
  const errorFlag = searchParams.get('error')

  useEffect(() => { load() }, [])

  async function load() {
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return

    const [{ data: prof }, { data: g }, { data: h }, { data: l }] = await Promise.all([
      sb.from('profiles').select('*').eq('id', user.id).single(),
      sb.from('google_integrations')
        .select('google_email, connected_at')
        .eq('user_id', user.id)
        .maybeSingle(),
      sb.from('hubspot_integrations')
        .select('hubspot_account_name, hubspot_user_email, hubspot_account_id, connected_at')
        .eq('user_id', user.id)
        .maybeSingle(),
      sb.from('lemlist_integrations')
        .select('lemlist_team_name, lemlist_user_email, connected_at')
        .eq('user_id', user.id)
        .maybeSingle(),
    ])

    setProfile(prof as Profile | null)
    setGoogle(g as { google_email: string | null; connected_at: string } | null)
    setHubspot(h as HubSpotIntegrationLite | null)
    setLemlist(l as LemlistIntegrationLite | null)
    setLoading(false)
  }

  async function handleConnectLemlist() {
    if (!lemlistApiKey.trim()) return
    setConnectingLemlist(true)
    setLemlistError(null)
    try {
      const res = await fetch('/api/integrations/lemlist/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: lemlistApiKey.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setLemlistError(data.error ?? t('common.connectFailed'))
        return
      }
      setLemlist({
        lemlist_team_name:  data.team_name ?? null,
        lemlist_user_email: data.email ?? null,
        connected_at:       new Date().toISOString(),
      })
      setLemlistApiKey('')
    } catch (e) {
      setLemlistError(e instanceof Error ? e.message : t('common.unknownError'))
    } finally {
      setConnectingLemlist(false)
    }
  }

  async function handleDisconnectLemlist() {
    if (!confirm(t('lemlist.disconnectConfirm'))) return
    setDisconnectingLemlist(true)
    try {
      await fetch('/api/integrations/lemlist/disconnect', { method: 'POST' })
      setLemlist(null)
    } finally {
      setDisconnectingLemlist(false)
    }
  }

  async function handleSyncLemlist() {
    setSyncingLemlist(true)
    setSyncMessage(null)
    try {
      const res = await fetch('/api/integrations/lemlist/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days_back: 30 }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSyncMessage({ type: 'error', text: data.error ?? t('common.syncFailed') })
        return
      }
      const calls = data.calls_imported ?? 0
      setSyncMessage({
        type: 'ok',
        text: calls > 0
          ? t('lemlist.syncSummary', { calls, projects: data.projects_touched ?? 0 })
          : data.message ?? t('lemlist.noNewCalls'),
      })
    } catch (e) {
      setSyncMessage({ type: 'error', text: e instanceof Error ? e.message : t('common.unknownError') })
    } finally {
      setSyncingLemlist(false)
    }
  }

  async function handleDisconnectGoogle() {
    if (!confirm(t('google.disconnectConfirm'))) return
    setDisconnectingGoogle(true)
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return
    await sb.from('google_integrations').delete().eq('user_id', user.id)
    setGoogle(null)
    setDisconnectingGoogle(false)
  }

  async function handleDisconnectHubspot() {
    if (!confirm(t('hubspot.disconnectConfirm'))) return
    setDisconnectingHubspot(true)
    try {
      const res = await fetch('/api/integrations/hubspot/disconnect', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(t('common.disconnectFailed', { error: data.error ?? t('common.unknownError') }))
        return
      }
      setHubspot(null)
    } finally {
      setDisconnectingHubspot(false)
    }
  }

  async function handleSyncHubspot() {
    setSyncingHubspot(true)
    setSyncMessage(null)
    try {
      const res = await fetch('/api/integrations/hubspot/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        setSyncMessage({ type: 'error', text: data.error ?? t('common.syncFailed') })
        return
      }
      const synced = data.synced ?? 0
      const notFound = data.not_found ?? 0
      const classifyFailed = data.classify_failed ?? 0
      const classifyErrors = (data.classify_errors as string[] | undefined) ?? []

      // Als classify faalde tonen we dat — anders zou de user niet weten
      // waarom dealstage_raw wel maar dealstage_category niet update.
      if (classifyFailed > 0) {
        const firstError = classifyErrors[0] ?? t('common.unknownError')
        setSyncMessage({
          type: 'error',
          text: t('hubspot.classifyFailed', { synced, projects: classifyFailed, error: firstError }),
        })
        return
      }

      const notFoundSuffix = notFound > 0 ? t('hubspot.syncSummaryNotFoundSuffix', { count: notFound }) : ''
      const text = synced > 0
        ? t('hubspot.syncSummary', { synced, notFoundSuffix })
        : data.message ?? t('common.noUpdatesNeeded')
      setSyncMessage({ type: 'ok', text })
    } catch (e) {
      setSyncMessage({ type: 'error', text: e instanceof Error ? e.message : t('common.unknownError') })
    } finally {
      setSyncingHubspot(false)
    }
  }

  /**
   * cc_manager-side: synct call-engagements vanuit HubSpot voor alle projecten
   * met een gekoppelde HubSpot-list. Aparte knop want het is een andere flow
   * dan de dealstage-sync (die de sales_manager triggert).
   */
  async function handleSyncHubspotCalls() {
    setSyncingHubspotCalls(true)
    setSyncMessage(null)
    try {
      const res = await fetch('/api/integrations/hubspot-cc/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (!res.ok) {
        setSyncMessage({ type: 'error', text: data.error ?? t('common.syncFailed') })
        return
      }
      const calls = data.calls_imported ?? 0
      const text = calls > 0
        ? t('hubspot.syncCallsSummary', { calls, projects: data.projects_touched ?? 0 })
        : data.message ?? t('hubspot.noNewCalls')
      setSyncMessage({ type: 'ok', text })
    } catch (e) {
      setSyncMessage({ type: 'error', text: e instanceof Error ? e.message : t('common.unknownError') })
    } finally {
      setSyncingHubspotCalls(false)
    }
  }

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>

  // Strikte rolafbakening:
  //   - cc_manager    → Google Sheets, Lemlist, HubSpot (calls-sync)
  //   - sales_manager → HubSpot (dealstage-lookup per afspraak)
  // Beide rollen kunnen HubSpot koppelen — de scopes zijn de union van wat
  // sales_manager (deals) en cc_manager (calls + lists) nodig hebben, dus
  // één OAuth-flow volstaat voor beide use cases.
  // Google = Sheets (cc_manager) + Calendar (sales_manager/sales_rep voor
  // de appointment-planner). Eén OAuth-flow met beide scopes — daarom tonen
  // we de card voor alle 3 die rollen. Cold callers hebben 'm niet nodig
  // (zij plannen, ze ontvangen niet).
  const showGoogle  = profile?.role === 'cc_manager'
                   || profile?.role === 'sales_manager'
                   || profile?.role === 'sales_rep'
  const showLemlist = profile?.role === 'cc_manager'
  const showHubspot = profile?.role === 'sales_manager' || profile?.role === 'cc_manager'
  const isCcManager = profile?.role === 'cc_manager'
  // Rol-specifieke copy voor de Google-card: cc_manager ziet Sheets-focus,
  // sales reps/managers de Calendar-focus.
  const isSalesRole = profile?.role === 'sales_manager' || profile?.role === 'sales_rep'

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {t('subtitle')}
        </p>
      </div>

      {/* Banners */}
      {successFlag === 'connected' && (
        <div className="card p-4 mb-5 bg-green-50 border-green-100">
          <p className="text-sm text-green-700 font-medium">
            {t('banners.googleConnected')}
          </p>
        </div>
      )}
      {successFlag === 'hubspot_connected' && (
        <div className="card p-4 mb-5 bg-green-50 border-green-100">
          <p className="text-sm text-green-700 font-medium">
            {t('banners.hubspotConnected')}
          </p>
        </div>
      )}
      {errorFlag && (
        <div className="card p-4 mb-5 bg-red-50 border-red-100">
          <p className="text-sm text-red-700">
            {isErrorFlagKey(errorFlag)
              ? t(`errors.${errorFlag}`)
              : t('banners.genericError', { flag: errorFlag })}
          </p>
        </div>
      )}

      {/* Google Sheets — alleen voor cc_managers */}
      {showGoogle && (
      <div className="card p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-white border border-gray-200 flex items-center justify-center flex-shrink-0">
            <svg width="24" height="24" viewBox="0 0 48 48" fill="none">
              <path d="M44.5 20H24v8.5h11.8C34.7 33.9 30 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z" fill="#FFC107"/>
              <path d="M6.3 14.7l7 5.1C15.3 14.9 19.3 12 24 12c3.1 0 5.9 1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 16 2 9 6.7 6.3 14.7z" fill="#FF3D00"/>
              <path d="M24 46c5.5 0 10.4-2 14-5.4l-6.5-5.5c-2 1.5-4.6 2.4-7.5 2.4-6 0-10.7-3.1-12.5-8.5l-6.9 5.3C7.7 41.4 14.5 46 24 46z" fill="#4CAF50"/>
              <path d="M44.5 20H24v8.5h11.8c-.6 1.7-1.6 3.2-2.9 4.4l6.5 5.5C44.5 33 46 28 46 24c0-1.3-.2-2.7-.5-4z" fill="#1976D2"/>
            </svg>
          </div>

          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-gray-900">
              {isSalesRole ? t('google.titleSales') : t('google.title')}
            </h2>
            <p className="text-sm text-gray-500 mt-1 leading-relaxed">
              {isSalesRole ? t('google.descSales') : t('google.desc')}
            </p>

            {/* Reauth-hint voor users die Google al gekoppeld hadden vóór de
                calendar.events scope was toegevoegd. We kunnen scope niet
                lokaal detecteren zonder een server-call, dus we tonen de hint
                onvoorwaardelijk voor sales roles met een gekoppelde Google. */}
            {google && isSalesRole && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-800 leading-relaxed">
                {t('google.reauthHint')}
              </div>
            )}

            {google ? (
              <div className="mt-4 flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-2 h-2 rounded-full bg-green-500"/>
                  <span className="text-gray-700">
                    {t('common.connectedAs')} <strong>{google.google_email ?? t('common.unknown')}</strong>
                  </span>
                </div>
                {/* Voor sales roles: vooral "Opnieuw verbinden" prominent maken
                    zodat ze de calendar-scope kunnen toevoegen. */}
                {isSalesRole && (
                  <a
                    href="/api/integrations/google/start"
                    className="text-xs px-3 py-1.5 rounded-md border border-brand-300 bg-brand-600 text-white hover:bg-brand-700 transition-colors"
                  >
                    {t('google.reconnect')}
                  </a>
                )}
                <button
                  onClick={handleDisconnectGoogle}
                  disabled={disconnectingGoogle}
                  className="btn-secondary text-xs"
                >
                  {disconnectingGoogle ? t('common.disconnecting') : t('common.disconnect')}
                </button>
              </div>
            ) : (
              <a
                href="/api/integrations/google/start"
                className="btn-primary inline-flex items-center gap-2 mt-4 text-sm"
              >
                {isSalesRole ? t('google.connectSales') : t('google.connect')}
              </a>
            )}
          </div>
        </div>

        {google && (
          <div className="mt-5 pt-5 border-t border-gray-100">
            <p className="text-xs text-gray-500 leading-relaxed">
              💡 <strong>{t('common.next_step')}</strong>: {isSalesRole ? t('google.nextStepSales') : t('google.nextStep')}
            </p>
            {/* Sheet-koppeling per cold caller is alleen voor cc_managers
                relevant — sales roles werken via de planner-pagina. */}
            {!isSalesRole && (
              <Link href="/dashboard/projects" className="text-sm text-brand-600 hover:underline inline-block mt-2">
                {t('google.toProjects')}
              </Link>
            )}
          </div>
        )}
      </div>
      )}

      {/* Lemlist — enkel voor cc_managers */}
      {showLemlist && (
        <div className="card p-6 mt-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-white border border-gray-200 flex items-center justify-center flex-shrink-0">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M3 7l9 6 9-6M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z"
                  stroke="#9333ea" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="font-semibold text-gray-900">{t('lemlist.title')}</h2>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                {t('lemlist.desc')}
              </p>

              {lemlist ? (
                <div className="mt-4 flex flex-col sm:flex-row sm:items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="w-2 h-2 rounded-full bg-green-500"/>
                    <span className="text-gray-700">
                      {lemlist.lemlist_team_name
                        ? <>{t('common.connectedAs')} <strong>{lemlist.lemlist_team_name}</strong></>
                        : t('common.connectedAs')}
                      {lemlist.lemlist_user_email && (
                        <> ({lemlist.lemlist_user_email})</>
                      )}
                    </span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={handleSyncLemlist}
                      disabled={syncingLemlist}
                      className="text-xs px-3 py-1.5 rounded-md border border-brand-300 bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
                    >
                      {syncingLemlist ? t('common.syncing') : t('common.syncNow')}
                    </button>
                    <button
                      onClick={handleDisconnectLemlist}
                      disabled={disconnectingLemlist}
                      className="btn-secondary text-xs"
                    >
                      {disconnectingLemlist ? t('common.disconnecting') : t('common.disconnect')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="password"
                      value={lemlistApiKey}
                      onChange={e => setLemlistApiKey(e.target.value)}
                      placeholder={t('lemlist.apiKeyPlaceholder')}
                      className="input flex-1 text-sm"
                    />
                    <button
                      onClick={handleConnectLemlist}
                      disabled={connectingLemlist || !lemlistApiKey.trim()}
                      className="btn-primary text-sm whitespace-nowrap"
                    >
                      {connectingLemlist ? t('lemlist.connecting') : t('lemlist.connect')}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    {t('lemlist.apiKeyHint')}
                  </p>
                  {lemlistError && (
                    <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg mt-2">
                      {lemlistError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {lemlist && (
            <div className="mt-5 pt-5 border-t border-gray-100">
              <p className="text-xs text-gray-500 leading-relaxed">
                💡 <strong>{t('common.next_step')}</strong>: {t('lemlist.nextStep')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* HubSpot — enkel voor sales_managers */}
      {showHubspot && (
        <div className="card p-6 mt-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-white border border-gray-200 flex items-center justify-center flex-shrink-0">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978 2.2 2.2 0 00-2.197-2.2 2.2 2.2 0 00-2.197 2.2c0 .91.555 1.69 1.345 2.024v2.797a6.215 6.215 0 00-2.95 1.296L4.04 2.184l.057-.166a1.652 1.652 0 10-1.673 1.105L11.236 10.4a6.224 6.224 0 00-1.06 3.486 6.225 6.225 0 003.063 5.367l-.901.901a.484.484 0 00.001.685l1.962 1.96a.484.484 0 00.685 0l3.073-3.073a6.232 6.232 0 002.106-2.106l3.072-3.072a.484.484 0 000-.685l-1.96-1.962a.484.484 0 00-.685 0l-.901.9a6.221 6.221 0 00-2.527-3.971zm-1.29 9.295a3.286 3.286 0 110-6.572 3.286 3.286 0 010 6.572z" fill="#FF7A59"/>
              </svg>
            </div>

            <div className="flex-1 min-w-0">
              <h2 className="font-semibold text-gray-900">{t('hubspot.title')}</h2>
              <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                {isCcManager ? (
                  <>
                    {t('hubspot.descCcManager')}
                    {' '}
                    <span className="block mt-1.5 text-xs text-gray-600">
                      {t('hubspot.descCcManagerCallsHint')}
                    </span>
                  </>
                ) : (
                  <>{t('hubspot.descSalesManager')}</>
                )}
              </p>

              {hubspot ? (
                <div className="mt-4 flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="w-2 h-2 rounded-full bg-green-500"/>
                    <span className="text-gray-700">
                      {hubspot.hubspot_account_name
                        ? <>{t('common.connectedWithPortal')} <strong>{hubspot.hubspot_account_name}</strong></>
                        : t('common.connectedAs')}
                      {hubspot.hubspot_user_email && (
                        <> {t('common.as')} <strong>{hubspot.hubspot_user_email}</strong></>
                      )}
                    </span>
                  </div>
                  {/* Sync dealstages — beschikbaar voor sales_manager én
                      cc_manager. Vooral nuttig voor freelance cc_managers die
                      zelf ook hun HubSpot-deals beheren. De API checkt op
                      user_id, dus iedereen die de OAuth heeft afgerond kan
                      dealstages syncen. */}
                  <button
                    onClick={handleSyncHubspot}
                    disabled={syncingHubspot}
                    className="text-xs px-3 py-1.5 rounded-md border border-brand-300 bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
                    title={t('hubspot.syncDealstagesTip')}
                  >
                    {syncingHubspot ? t('common.syncing') : t('hubspot.syncDealstages')}
                  </button>
                  {/* "Sync calls" knop verhuisd naar project-instellingen —
                      calls-sync gaat nu per project i.p.v. per cc_manager. */}
                  <button
                    onClick={handleDisconnectHubspot}
                    disabled={disconnectingHubspot}
                    className="btn-secondary text-xs"
                  >
                    {disconnectingHubspot ? t('common.disconnecting') : t('common.disconnect')}
                  </button>
                </div>
              ) : (
                <a
                  href="/api/integrations/hubspot/start"
                  className="btn-primary inline-flex items-center gap-2 mt-4 text-sm"
                >
                  {t('hubspot.connect')}
                </a>
              )}

              {syncMessage && (
                <div className={`mt-3 px-3 py-2 rounded-lg text-sm ${
                  syncMessage.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                }`}>
                  {syncMessage.text}
                </div>
              )}
            </div>
          </div>

          {hubspot && (
            <div className="mt-5 pt-5 border-t border-gray-100">
              <p className="text-xs text-gray-500 leading-relaxed">
                💡 {t('hubspot.cronHint')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Toekomstige integraties — Lemlist alleen, HubSpot is nu live */}
      <div className="card p-6 mt-4 opacity-60">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="#9ca3af" strokeWidth="1.5"/>
              <path d="M12 7v5l3 2" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <h2 className="font-medium text-gray-700">{t('future.title')}</h2>
            <p className="text-sm text-gray-400 mt-0.5">{t('future.subtitle')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function SuspenseFallback() {
  const t = useTranslations('dashboard.settings.integrations')
  return <div className="text-sm text-gray-400 p-8">{t('common.suspenseLoading')}</div>
}

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<SuspenseFallback />}>
      <IntegrationsContent />
    </Suspense>
  )
}
