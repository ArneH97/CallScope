'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'
import type { Role } from '@/types/database'
import LanguageSwitcher from '@/components/LanguageSwitcher'

type RoleChoice = 'cc_manager' | 'freelance'

interface RoleOption {
  value: RoleChoice
  /** i18n keys onder auth.register.* */
  labelKey: string
  descKey:  string
  toDb: { role: Role; is_freelance: boolean }
}

/**
 * Self-registratie is sinds april 2026 enkel voor call center managers en
 * freelance appointment setters. Cold callers, sales reps en sales managers
 * worden uitsluitend via een invite-link toegevoegd door hun cc_manager.
 */
const ROLES: RoleOption[] = [
  {
    value:    'cc_manager',
    labelKey: 'roleCcManager.label',
    descKey:  'roleCcManager.description',
    toDb:     { role: 'cc_manager', is_freelance: false },
  },
  {
    value:    'freelance',
    labelKey: 'roleFreelance.label',
    descKey:  'roleFreelance.description',
    toDb:     { role: 'cc_manager', is_freelance: true },
  },
]

export default function RegisterPage() {
  const t = useTranslations('auth.register')
  const router = useRouter()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [roleChoice, setRoleChoice] = useState<RoleChoice>('cc_manager')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const choice = ROLES.find(r => r.value === roleChoice)!
    const { role, is_freelance } = choice.toDb

    const supabase = createClient()
    const redirectUrl = typeof window !== 'undefined'
      ? `${window.location.origin}/auth/login`
      : '/auth/login'

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, role, is_freelance },
        emailRedirectTo: redirectUrl,
      },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    router.push(`/auth/verify-email?email=${encodeURIComponent(email)}`)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4 py-8">
      <div className="w-full max-w-md">
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

        <div className="card p-6">
          <div className="mb-5 p-3 bg-brand-50 border border-brand-100 rounded-lg">
            <p className="text-xs text-brand-900 leading-relaxed">
              <strong>{t('infoBold')}</strong> {t('info').replace(t('infoBold'), '').trim()}
            </p>
          </div>

          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('fullNameLabel')}</label>
              <input
                type="text"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                className="input"
                placeholder={t('fullNamePlaceholder')}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('emailLabel')}</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="input"
                placeholder={t('emailPlaceholder')}
                required
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

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">{t('roleLabel')}</label>
              <div className="grid grid-cols-1 gap-2">
                {ROLES.map(r => (
                  <label
                    key={r.value}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      roleChoice === r.value
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={r.value}
                      checked={roleChoice === r.value}
                      onChange={() => setRoleChoice(r.value)}
                      className="mt-0.5 accent-brand-600"
                    />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{t(r.labelKey)}</div>
                      <div className="text-xs text-gray-500 mt-0.5">{t(r.descKey)}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? t('submitting') : t('submit')}
            </button>
          </form>
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
