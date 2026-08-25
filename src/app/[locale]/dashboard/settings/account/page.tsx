'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/types/database'

type RoleKey = 'cc_manager' | 'cold_caller' | 'sales_rep' | 'sales_manager'

type GoogleStatus = { connected: boolean; email: string | null }

export default function AccountSettingsPage() {
  const t = useTranslations('dashboard.settings.account')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [email, setEmail] = useState('')
  const [google, setGoogle] = useState<GoogleStatus>({ connected: false, email: null })
  const [loading, setLoading] = useState(true)

  // Password change state
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwResult, setPwResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) return
    setEmail(user.email ?? '')

    const [{ data: prof }, { data: gi }] = await Promise.all([
      sb.from('profiles').select('*').eq('id', user.id).single(),
      sb.from('google_integrations').select('google_email').eq('user_id', user.id).maybeSingle(),
    ])
    setProfile(prof as Profile | null)
    setGoogle({
      connected: !!gi,
      email: (gi as { google_email: string | null } | null)?.google_email ?? null,
    })
    setLoading(false)
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault()
    setPwResult(null)

    if (newPassword.length < 8) {
      setPwResult({ ok: false, text: t('password.tooShort') })
      return
    }
    if (newPassword !== confirmPassword) {
      setPwResult({ ok: false, text: t('password.mismatch') })
      return
    }

    setPwSaving(true)
    const sb = createClient()
    const { error } = await sb.auth.updateUser({ password: newPassword })
    setPwSaving(false)

    if (error) {
      setPwResult({ ok: false, text: error.message })
      return
    }
    setPwResult({ ok: true, text: t('password.success') })
    setNewPassword('')
    setConfirmPassword('')
  }

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>

  const roleKey = (profile?.role ?? '') as RoleKey
  const roleLabel = profile && (['cc_manager', 'cold_caller', 'sales_rep', 'sales_manager'] as const).includes(roleKey)
    ? t(`roles.${roleKey}`)
    : ''

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
      </div>

      {/* Profile info */}
      <div className="card p-5 mb-5">
        <div className="text-sm font-medium text-gray-900 mb-3">{t('profile.heading')}</div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">{t('profile.name')}</span>
            <span className="text-gray-900">{profile?.full_name ?? t('profile.empty')}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">{t('profile.email')}</span>
            <span className="text-gray-900">{email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">{t('profile.role')}</span>
            <span className="text-gray-900">
              {roleLabel}
              {profile?.is_freelance && profile.role === 'cc_manager' && (
                <span className="text-gray-400 font-normal"> {t('profile.freelanceSuffix')}</span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Stripe portal — alleen voor cc_managers met al een Stripe customer */}
      {profile?.role === 'cc_manager' && profile?.stripe_customer_id && (
        <div className="card p-5 mb-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-gray-900">{t('billing.heading')}</div>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('billing.subtitle')}
              </p>
            </div>
            <button
              onClick={async () => {
                const res = await fetch('/api/billing/portal', { method: 'POST' })
                const data = await res.json()
                if (res.ok && data.url) {
                  window.location.href = data.url
                } else {
                  alert(data.error ?? t('billing.portalFailed'))
                }
              }}
              className="btn-primary text-sm flex-shrink-0"
            >
              {t('billing.button')}
            </button>
          </div>
        </div>
      )}

      {/* Tutorial replay */}
      <div className="card p-5 mb-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-gray-900">{t('tutorial.heading')}</div>
            <p className="text-xs text-gray-500 mt-0.5">
              {t('tutorial.subtitle')}
            </p>
          </div>
          <button
            onClick={async () => {
              const sb = createClient()
              const { data: { user } } = await sb.auth.getUser()
              if (!user) return
              await sb.from('profiles')
                .update({ tutorial_completed_at: null })
                .eq('id', user.id)
              // Reload zodat de Tutorial-component opnieuw mount + zijn check doet
              window.location.reload()
            }}
            className="text-xs px-3 py-1.5 rounded-md border border-brand-200 bg-brand-50 text-brand-700 hover:border-brand-400 transition-colors flex-shrink-0"
          >
            {t('tutorial.button')}
          </button>
        </div>
      </div>

      {/* Password change */}
      <div className="card p-5 mb-5">
        <div className="text-sm font-medium text-gray-900 mb-3">{t('password.heading')}</div>
        <form onSubmit={handlePasswordChange} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('password.newLabel')}</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="input"
              placeholder={t('password.newPlaceholder')}
              minLength={8}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('password.confirmLabel')}</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="input"
              placeholder={t('password.confirmPlaceholder')}
              minLength={8}
              required
            />
          </div>

          {pwResult && (
            <p className={`text-sm px-3 py-2 rounded-lg ${
              pwResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {pwResult.text}
            </p>
          )}

          <button
            type="submit"
            disabled={pwSaving || !newPassword || !confirmPassword}
            className="btn-primary text-sm"
          >
            {pwSaving ? t('password.submitting') : t('password.submit')}
          </button>
        </form>
      </div>

      {/* Connected tools */}
      <div className="card p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-gray-900">{t('connectedTools.heading')}</div>
          <Link href="/dashboard/settings/integrations" className="text-xs text-brand-600 hover:underline">
            {t('connectedTools.manage')}
          </Link>
        </div>
        <div className="space-y-2">
          {/* Google */}
          <div className="flex items-center gap-3 p-3 border border-gray-100 rounded-lg">
            <div className="w-9 h-9 rounded-lg bg-white border border-gray-200 flex items-center justify-center flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
                <path d="M44.5 20H24v8.5h11.8C34.7 33.9 30 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z" fill="#FFC107"/>
                <path d="M6.3 14.7l7 5.1C15.3 14.9 19.3 12 24 12c3.1 0 5.9 1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 16 2 9 6.7 6.3 14.7z" fill="#FF3D00"/>
                <path d="M24 46c5.5 0 10.4-2 14-5.4l-6.5-5.5c-2 1.5-4.6 2.4-7.5 2.4-6 0-10.7-3.1-12.5-8.5l-6.9 5.3C7.7 41.4 14.5 46 24 46z" fill="#4CAF50"/>
                <path d="M44.5 20H24v8.5h11.8c-.6 1.7-1.6 3.2-2.9 4.4l6.5 5.5C44.5 33 46 28 46 24c0-1.3-.2-2.7-.5-4z" fill="#1976D2"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900">{t('connectedTools.googleTitle')}</div>
              {google.connected ? (
                <div className="text-xs text-gray-500 mt-0.5">
                  {t('connectedTools.connectedAs')} <span className="text-gray-700">{google.email}</span>
                </div>
              ) : (
                <div className="text-xs text-gray-400 mt-0.5">{t('connectedTools.notConnected')}</div>
              )}
            </div>
            <span className={`badge text-xs ${google.connected ? 'badge-green' : 'badge-gray'}`}>
              {google.connected ? t('connectedTools.active') : t('connectedTools.inactive')}
            </span>
          </div>

          {/* Future tools — placeholders */}
          {[
            { name: t('connectedTools.future.hubspotName'),  desc: t('connectedTools.future.hubspotDesc') },
            { name: t('connectedTools.future.lemlistName'),  desc: t('connectedTools.future.lemlistDesc') },
            { name: t('connectedTools.future.aircallName'),  desc: t('connectedTools.future.aircallDesc') },
          ].map(tool => (
            <div key={tool.name} className="flex items-center gap-3 p-3 border border-gray-100 rounded-lg opacity-50">
              <div className="w-9 h-9 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="5.5" stroke="#9ca3af" strokeWidth="1.5"/>
                  <path d="M8 5v3l2 1.5" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-700">{tool.name}</div>
                <div className="text-xs text-gray-400 mt-0.5">{tool.desc}</div>
              </div>
              <span className="badge badge-gray text-xs">{t('connectedTools.comingSoon')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
