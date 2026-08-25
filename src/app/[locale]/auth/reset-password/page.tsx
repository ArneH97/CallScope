'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'

/**
 * Wordt geopend via de link in de "wachtwoord vergeten"-mail.
 * Supabase's email-link bevat een access_token in de URL hash; de Supabase
 * JS client pikt dat automatisch op en zet een (kortlevende) sessie zodat
 * we via auth.updateUser() het wachtwoord kunnen wijzigen.
 */
export default function ResetPasswordPage() {
  const t = useTranslations('auth.resetPassword')
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSession, setHasSession] = useState<boolean | null>(null)

  useEffect(() => {
    const sb = createClient()
    sb.auth.getSession().then(({ data }) => {
      setHasSession(!!data.session)
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError(t('errorMismatch'))
      return
    }
    if (password.length < 8) {
      setError(t('errorTooShort'))
      return
    }
    setLoading(true)
    setError(null)

    const sb = createClient()
    const { error: err } = await sb.auth.updateUser({ password })
    setLoading(false)

    if (err) {
      setError(err.message)
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

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
          {hasSession === false ? (
            <div className="text-center py-2">
              <div className="text-3xl mb-2">⏱</div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">{t('expiredTitle')}</h2>
              <p className="text-sm text-gray-500 mb-4">
                {t('expiredBody')}
              </p>
              <Link href="/auth/forgot-password" className="btn-primary inline-block text-sm">
                {t('expiredCta')}
              </Link>
            </div>
          ) : hasSession === null ? (
            <p className="text-sm text-gray-400 text-center py-2">{t('checkingSession')}</p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-gray-500">
                {t('intro')}
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('newLabel')}</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="input"
                  placeholder={t('newPlaceholder')}
                  minLength={8}
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('confirmLabel')}</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  className="input"
                  placeholder={t('confirmPlaceholder')}
                  minLength={8}
                  required
                />
              </div>
              {error && (
                <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
              )}
              <button type="submit" disabled={loading} className="btn-primary w-full">
                {loading ? t('submitting') : t('submit')}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
