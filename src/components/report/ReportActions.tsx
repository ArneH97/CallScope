'use client'

import { useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReportPeriod } from '@/lib/report-period'

interface Props {
  projectId:   string
  projectName: string
  /** Huidige periode-filter; default 'month'. Komt uit ?period= op de page. */
  period:      ReportPeriod
  /** Bij period='custom': de gekozen from/to (YYYY-MM-DD). */
  customFrom?: string | null
  customTo?:   string | null
}

/**
 * Actie-balk bovenaan de rapport-pagina:
 *   - Week/Maand toggle (filtert dataset én share-link)
 *   - Download PDF (= window.print)
 *   - Verzend naar klant (modal — gaat via /api/projects/:id/share)
 * Class 'no-print' zorgt dat deze balk niet in de PDF zelf verschijnt.
 */
export default function ReportActions({ projectId, projectName, period, customFrom, customTo }: Props) {
  const t = useTranslations('dashboard.projects.report.actions')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [showSend, setShowSend] = useState(false)
  const [showCustom, setShowCustom] = useState(period === 'custom')
  // Init date-pickers met huidige custom-values óf lege strings.
  const [fromInput, setFromInput] = useState<string>(customFrom ?? '')
  const [toInput,   setToInput]   = useState<string>(customTo   ?? '')

  function handleDownload() {
    // Browser-PDF: gebruiker krijgt 'Bewaren als PDF' optie.
    // We tonen eerst een korte tip zodat de URL/datum-header en pagina-
    // voettekst worden uitgevinkt — die kunnen we NIET via CSS weghalen
    // (browser-controlled), enkel via de print-dialoog instelling
    // "Kop- en voettekst" (Chrome/Edge) of "Print Headers and Footers"
    // (Safari/Firefox).
    const shown = typeof window !== 'undefined' && window.sessionStorage?.getItem('printTipShown')
    if (!shown) {
      alert(t('printTip'))
      try { window.sessionStorage?.setItem('printTipShown', '1') } catch {}
    }
    window.print()
  }

  function switchPeriod(next: ReportPeriod) {
    if (next === period && next !== 'custom') return
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    if (next === 'month') {
      params.delete('period')   // default kort houden
      params.delete('from')
      params.delete('to')
    } else if (next === 'week') {
      params.set('period', 'week')
      params.delete('from')
      params.delete('to')
    } else {
      // custom → panel uitklappen, URL pas updaten bij "Toepassen"
      setShowCustom(true)
      return
    }
    setShowCustom(false)
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  function applyCustom() {
    if (!fromInput || !toInput) return
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    params.set('period', 'custom')
    params.set('from', fromInput)
    params.set('to',   toInput)
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <>
      <div className="no-print flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <a href="/dashboard/projects" className="text-xs text-gray-400 hover:text-gray-600">
            {t('back')}
          </a>
          {/* Week/Maand/Aangepast-pilltoggle */}
          <div className="inline-flex gap-0.5 bg-gray-100 p-0.5 rounded-md">
            <button
              onClick={() => switchPeriod('month')}
              className={`text-xs px-2.5 py-1 rounded transition-colors ${
                period === 'month'
                  ? 'bg-white text-gray-900 font-medium shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t('periodMonth')}
            </button>
            <button
              onClick={() => switchPeriod('week')}
              className={`text-xs px-2.5 py-1 rounded transition-colors ${
                period === 'week'
                  ? 'bg-white text-gray-900 font-medium shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t('periodWeek')}
            </button>
            <button
              onClick={() => switchPeriod('custom')}
              className={`text-xs px-2.5 py-1 rounded transition-colors ${
                period === 'custom'
                  ? 'bg-white text-gray-900 font-medium shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t('periodCustom')}
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={handleDownload} className="btn-secondary inline-flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 12v2h12v-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            {t('download')}
          </button>
          <button onClick={() => setShowSend(true)} className="btn-primary inline-flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M2 8L14 2L9 14L7 9L2 8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
            {t('send')}
          </button>
        </div>
      </div>

      {/* Custom-range panel — uitklap wanneer 'Aangepast' actief is. */}
      {showCustom && (
        <div className="no-print card p-3 mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('customFromLabel')}</label>
            <input
              type="date"
              value={fromInput}
              onChange={e => setFromInput(e.target.value)}
              className="text-sm border border-gray-200 rounded px-2 py-1"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{t('customToLabel')}</label>
            <input
              type="date"
              value={toInput}
              onChange={e => setToInput(e.target.value)}
              className="text-sm border border-gray-200 rounded px-2 py-1"
            />
          </div>
          <button
            onClick={applyCustom}
            disabled={!fromInput || !toInput}
            className="btn-primary text-xs disabled:opacity-50"
          >
            {t('customApply')}
          </button>
          <p className="text-xs text-gray-400 ml-auto">{t('customHint')}</p>
        </div>
      )}

      {/* Verzend-modal */}
      {showSend && (
        <SendModal
          projectId={projectId}
          projectName={projectName}
          period={period}
          onClose={() => setShowSend(false)}
        />
      )}
    </>
  )
}

function SendModal({
  projectId,
  projectName,
  period,
  onClose,
}: {
  projectId:   string
  projectName: string
  period:      ReportPeriod
  onClose:     () => void
}) {
  const t = useTranslations('dashboard.projects.report.actions.sendModal')
  const [to, setTo] = useState('')
  const [clientName, setClientName] = useState('')
  const [message, setMessage] = useState(t('defaultMessage', { projectName }))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ shareUrl: string; emailSent: boolean; warning?: string } | null>(null)

  async function handleSend() {
    if (!to.includes('@')) {
      setError(t('invalidEmail'))
      return
    }
    setError(null)
    setPending(true)
    try {
      const resp = await fetch(`/api/projects/${projectId}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, clientName: clientName || null, message, period }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? t('sendFailed'))
      setSuccess({ shareUrl: data.shareUrl, emailSent: !!data.emailSent, warning: data.warning })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sendFailed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4 no-print">
      <div className="card p-6 w-full max-w-md">
        <h2 className="font-semibold text-gray-900 mb-1">{t('title')}</h2>
        <p className="text-xs text-gray-400 mb-1">{t('projectLabel', { name: projectName })}</p>
        <p className="text-xs text-brand-600 mb-4">
          {period === 'week' ? t('periodHintWeek') : t('periodHintMonth')}
        </p>

        {!success ? (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('clientNameLabel')} <span className="text-gray-400 font-normal">{t('clientNameOptional')}</span>
            </label>
            <input
              type="text"
              value={clientName}
              onChange={e => setClientName(e.target.value)}
              className="input mb-3"
              placeholder={t('clientNamePlaceholder')}
            />
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('clientEmailLabel')}</label>
            <input
              type="email"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="input mb-3"
              placeholder={t('clientEmailPlaceholder')}
              autoFocus
            />
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('messageLabel')}</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={5}
              className="input resize-none mb-4"
            />

            {error && (
              <p className="text-xs text-red-700 bg-red-50 px-3 py-2 rounded-lg mb-3">{error}</p>
            )}

            <div className="flex gap-2">
              <button onClick={onClose} className="btn-secondary flex-1">{t('cancel')}</button>
              <button onClick={handleSend} disabled={pending || !to} className="btn-primary flex-1">
                {pending ? t('sending') : t('send')}
              </button>
            </div>
          </>
        ) : (
          <div className="py-2">
            <div className="text-3xl mb-3 text-center">{success.emailSent ? '✉️' : '🔗'}</div>
            {success.emailSent ? (
              <p className="text-sm text-gray-700 text-center mb-4">
                {t('sentTo')} <strong>{to}</strong>.
              </p>
            ) : (
              <p className="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded-lg mb-3">
                {success.warning ?? t('emailFailedWarning')}
              </p>
            )}

            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{t('shareLinkLabel')}</div>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 mb-3 text-xs text-gray-700 break-all font-mono">
              {success.shareUrl}
            </div>

            <button
              onClick={() => navigator.clipboard?.writeText(success.shareUrl)}
              className="btn-secondary w-full mb-2 text-xs"
            >
              {t('copyLink')}
            </button>
            <button onClick={onClose} className="btn-primary w-full">{t('close')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
