'use client'

import { useState, Suspense } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { Link } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'

/**
 * Bedank-pagina na registratie. Vraagt de gebruiker om zijn e-mail te
 * bevestigen via de link die Supabase verstuurt.
 *
 * Bereikbaar via: /auth/verify-email?email=jan@bedrijf.be
 */
function VerifyEmailContent() {
  const t = useTranslations('auth.verifyEmail')
  const searchParams = useSearchParams()
  const email = searchParams.get('email') ?? ''

  const [resendLoading, setResendLoading] = useState(false)
  const [resendStatus, setResendStatus] = useState<'idle' | 'sent' | 'error'>('idle')
  const [resendError, setResendError] = useState<string | null>(null)

  async function handleResend() {
    if (!email) return
    setResendLoading(true)
    setResendStatus('idle')
    setResendError(null)

    const supabase = createClient()
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
    })

    if (error) {
      setResendStatus('error')
      setResendError(error.message)
    } else {
      setResendStatus('sent')
    }
    setResendLoading(false)
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
        </div>

        <div className="card p-8 text-center">
          <div className="w-14 h-14 mx-auto mb-5 bg-brand-50 rounded-full flex items-center justify-center">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <path d="M3 7l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>

          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {t('title')}
          </h1>
          <p className="text-sm text-gray-500 mb-6 leading-relaxed">
            {email
              ? t('bodyWithEmail', { email })
              : t('bodyNoEmail')}
          </p>

          <div className="bg-gray-50 rounded-lg p-4 mb-5 text-left">
            <p className="text-xs text-gray-500 mb-2">{t('noMailLabel')}</p>
            <ul className="text-xs text-gray-500 space-y-1 mb-3 list-disc list-inside">
              <li>{t('tip1')}</li>
              <li>{t('tip2')}</li>
              <li>{t('tip3')}</li>
            </ul>

            {email ? (
              <button
                type="button"
                onClick={handleResend}
                disabled={resendLoading || resendStatus === 'sent'}
                className="btn-secondary w-full text-sm"
              >
                {resendLoading
                  ? t('resending')
                  : resendStatus === 'sent'
                  ? t('resent')
                  : t('resend')}
              </button>
            ) : (
              <p className="text-xs text-gray-400 italic">
                {t('noEmailAvailable')}
              </p>
            )}

            {resendStatus === 'error' && resendError && (
              <p className="text-xs text-red-600 mt-2">{resendError}</p>
            )}
          </div>

          <div className="text-sm text-gray-500">
            {t('alreadyActivated')}{' '}
            <Link href="/auth/login" className="text-brand-600 hover:text-brand-700 font-medium">
              {t('signIn')}
            </Link>
          </div>
        </div>

        <div className="text-center mt-6">
          <Link href="/auth/register" className="text-xs text-gray-400 hover:text-gray-600">
            {t('backToRegister')}
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function VerifyEmailPage() {
  const t = useTranslations('auth.verifyEmail')
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center text-sm text-gray-400">{t('loading')}</div>}>
      <VerifyEmailContent />
    </Suspense>
  )
}
