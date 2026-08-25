'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgotPassword')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const baseUrl = typeof window !== 'undefined' ? window.location.origin : ''
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${baseUrl}/auth/reset-password`,
    })

    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }
    setSent(true)
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
          {sent ? (
            <div className="text-center py-2">
              <div className="w-12 h-12 mx-auto mb-4 bg-brand-50 rounded-full flex items-center justify-center">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">{t('sentTitle')}</h2>
              <p className="text-sm text-gray-500 mb-4 leading-relaxed">
                {t('sentBody', { email })}
              </p>
              <p className="text-xs text-gray-400 mb-4">
                {t('sentTip')}
              </p>
              <Link href="/auth/login" className="text-sm text-brand-600 hover:underline font-medium">
                {t('backToLogin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-gray-500 leading-relaxed">
                {t('intro')}
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('emailLabel')}</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="input"
                  placeholder={t('emailPlaceholder')}
                  required
                  autoFocus
                />
              </div>
              {error && (
                <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
              )}
              <button type="submit" disabled={loading || !email} className="btn-primary w-full">
                {loading ? t('submitting') : t('submit')}
              </button>
              <p className="text-center text-sm text-gray-500">
                <Link href="/auth/login" className="text-brand-600 hover:underline font-medium">
                  {t('backToLogin')}
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
