'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'
import LanguageSwitcher from '@/components/LanguageSwitcher'

export default function LoginPage() {
  const t = useTranslations('auth.login')
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(t('error'))
      setLoading(false)
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4 py-8">
      <div className="w-full max-w-sm">
        {/* Logo + language switcher */}
        <div className="text-center mb-8 relative">
          <div className="absolute right-0 top-0">
            <LanguageSwitcher />
          </div>
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

        {/* Form */}
        <div className="card p-6">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('emailLabel')}
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="input"
                placeholder={t('emailPlaceholder')}
                required
                autoComplete="email"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">
                  {t('passwordLabel')}
                </label>
                <Link href="/auth/forgot-password" className="text-xs text-brand-600 hover:underline">
                  {t('passwordForgot')}
                </Link>
              </div>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="input"
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? t('submitting') : t('submit')}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-4">
          {t('noAccount')}{' '}
          <Link href="/auth/register" className="text-brand-600 hover:underline font-medium">
            {t('register')}
          </Link>
        </p>
      </div>
    </div>
  )
}
