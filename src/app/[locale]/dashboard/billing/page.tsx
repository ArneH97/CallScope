'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { Link } from '@/i18n/routing'

export default function BillingPage() {
  const t = useTranslations('dashboard.billing')
  const params = useSearchParams()
  const projectId = params.get('project')
  const cancelled = params.get('checkout') === 'cancelled'

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCheckout() {
    if (!projectId) {
      setError(t('noProject'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('checkoutFailed'))
        setLoading(false)
        return
      }
      window.location.href = data.url
    } catch (e) {
      setError(e instanceof Error ? e.message : t('checkoutFailed'))
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link href="/dashboard/projects" className="text-sm text-gray-400 hover:text-gray-600 inline-flex items-center gap-1.5 mb-3">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {t('subtitle')}
        </p>
      </div>

      {cancelled && (
        <div className="card p-4 mb-5 border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-800">
            {t('cancelled')}
          </p>
        </div>
      )}

      <div className="card p-6">
        <h3 className="font-medium text-gray-900 mb-3">
          {t('planTitle')}{' '}
          <span className="text-sm font-normal text-gray-400">{t('planTaxNote')}</span>
        </h3>
        <ul className="space-y-2 text-sm text-gray-700 mb-5">
          {[1, 2, 3, 4, 5].map(n => (
            <li key={n} className="flex items-start gap-2">
              <CheckIcon /> {t(`feature${n}`)}
            </li>
          ))}
        </ul>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          onClick={handleCheckout}
          disabled={loading || !projectId}
          className="btn-primary w-full"
        >
          {loading ? t('ctaLoading') : t('cta')}
        </button>

        <p className="text-xs text-gray-400 text-center mt-3">
          {t('smallPrint')}
        </p>
      </div>

      <p className="text-xs text-gray-400 text-center mt-6">
        {t('alreadyActive')}{' '}
        <Link href="/dashboard/settings/account" className="underline">{t('accountSettings')}</Link>.
      </p>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="mt-0.5 text-green-600 flex-shrink-0">
      <path d="M3 8L7 12L13 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
