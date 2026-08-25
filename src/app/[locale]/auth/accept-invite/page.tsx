'use client'

import { useState, useEffect, Suspense } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { Link, useRouter } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'

type InviteInfo = {
  project_id: string
  project_name: string
  email: string
  role: string
  invited_by_name: string | null
  expires_at: string
  expired: boolean
}

function AcceptInviteContent() {
  const t = useTranslations('auth.acceptInvite')
  const router = useRouter()
  const params = useSearchParams()
  const token = params.get('token') ?? ''

  const [loading, setLoading] = useState(true)
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setLoadError(t('noToken'))
      setLoading(false)
      return
    }
    const sb = createClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sb.rpc as any)('get_invite_info', { p_token: token })
      .then(({ data, error }: { data: InviteInfo[] | null; error: { message: string } | null }) => {
        if (error) {
          setLoadError(error.message)
        } else if (!data || data.length === 0) {
          setLoadError(t('notFound'))
        } else {
          setInfo(data[0])
        }
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!info) return
    if (password.length < 8) {
      setSubmitError(t('errorTooShort'))
      return
    }
    setSubmitting(true)
    setSubmitError(null)

    try {
      const res = await fetch('/api/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, full_name: fullName, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSubmitError(data.error ?? 'Account aanmaken mislukt')
        setSubmitting(false)
        return
      }

      const sb = createClient()
      const { error: loginErr } = await sb.auth.signInWithPassword({
        email: info.email,
        password,
      })
      if (loginErr) {
        router.push(`/auth/login?email=${encodeURIComponent(info.email)}`)
        return
      }
      router.push('/dashboard')
      router.refresh()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Onbekende fout')
      setSubmitting(false)
    }
  }

  // Vertaal de role-string ('cold_caller' / 'sales_rep' / 'sales_manager').
  // Onbekende rol → val terug op de raw string.
  const roleLabel = (() => {
    if (!info) return ''
    try { return t(`roles.${info.role}`) } catch { return info.role }
  })()

  const inviterName = info?.invited_by_name ?? t('inviterFallback')

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4 py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-2">
            <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="5.5" stroke="white" strokeWidth="1.5"/>
                <path d="M8 3v2M8 11v2M3 8h2M11 8h2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                <circle cx="8" cy="8" r="1.4" fill="white"/>
              </svg>
            </div>
            <span className="text-xl font-semibold tracking-tight">CallScope</span>
          </div>
          <p className="text-sm text-gray-500">{t('subtitle')}</p>
        </div>

        <div className="card p-6">
          {loading && (
            <p className="text-sm text-gray-400 text-center py-2">{t('checking')}</p>
          )}

          {!loading && loadError && (
            <div className="text-center py-2">
              <div className="text-3xl mb-2">⚠</div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">{t('invalidTitle')}</h2>
              <p className="text-sm text-gray-500 mb-4">{loadError}</p>
              <Link href="/auth/login" className="btn-primary inline-block text-sm">
                {t('toLogin')}
              </Link>
            </div>
          )}

          {!loading && info && info.expired && (
            <div className="text-center py-2">
              <div className="text-3xl mb-2">⏱</div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">{t('expiredTitle')}</h2>
              <p className="text-sm text-gray-500 mb-4">
                {t('expiredBody', { inviter: info.invited_by_name ?? t('expiredFallback') })}
              </p>
            </div>
          )}

          {!loading && info && !info.expired && (
            <>
              <div className="mb-5 p-3 bg-brand-50 border border-brand-100 rounded-lg">
                <p className="text-sm text-brand-900">
                  {t('invitedBy', {
                    inviter: inviterName,
                    role:    roleLabel,
                    project: info.project_name,
                  })}
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('emailLabel')}</label>
                  <input
                    type="email"
                    value={info.email}
                    disabled
                    className="input bg-gray-50 text-gray-500"
                  />
                  <p className="text-xs text-gray-400 mt-1">{t('emailLocked')}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('fullNameLabel')}</label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={e => setFullName(e.target.value)}
                    className="input"
                    placeholder={t('fullNamePlaceholder')}
                    required
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('passwordLabel')}</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="input"
                    placeholder={t('passwordPlaceholder')}
                    minLength={8}
                    required
                  />
                </div>

                {submitError && (
                  <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{submitError}</p>
                )}

                <button type="submit" disabled={submitting} className="btn-primary w-full">
                  {submitting ? t('submitting') : t('submit')}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-sm text-gray-500 mt-4">
          {t('haveAccount')}{' '}
          <Link href="/auth/login" className="text-brand-600 hover:underline font-medium">
            {t('signIn')}
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function AcceptInvitePage() {
  const t = useTranslations('auth.acceptInvite')
  return (
    <Suspense fallback={<div className="text-sm text-gray-400 p-8">{t('loading')}</div>}>
      <AcceptInviteContent />
    </Suspense>
  )
}
