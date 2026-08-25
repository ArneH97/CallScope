'use client'

import { useState } from 'react'

type CoachingContext = {
  total_calls:    number
  reached:        number
  appointments:   number
  reach_rate:     number
  conv_rate:      number
  top_objections: { label: string; count: number }[]
  sample_notes:   string[]
  period_days:    number
}

type Props = {
  /** Initieel cached advies (uit DB), of null als er nog niets is. */
  initialAdvice: string | null
  initialContext: CoachingContext | null
  initialGeneratedAt: string | null
  /** Cold caller heeft minstens enkele calls — anders heeft coaching geen zin. */
  hasActivity: boolean
  /** Optioneel: caller_id voor cc_manager-side render. Default: ingelogde user. */
  callerId?: string
}

/**
 * Coaching-blok voor cold callers. Toont gegenereerd AI-advies (~200 woorden)
 * + een "Vernieuw advies"-knop die /api/coaching/generate aanroept. Het advies
 * wordt server-side gecached in caller_coaching_insights, dus regenerate is
 * een expliciete user-actie (kost een GPT-call).
 */
export default function CoachingBlock({
  initialAdvice,
  initialContext,
  initialGeneratedAt,
  hasActivity,
  callerId,
}: Props) {
  const [advice, setAdvice]           = useState<string | null>(initialAdvice)
  const [context, setContext]         = useState<CoachingContext | null>(initialContext)
  const [generatedAt, setGeneratedAt] = useState<string | null>(initialGeneratedAt)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)

  // Geen activity = geen coaching. Beter een lege state dan een hallucinated advies.
  if (!hasActivity) return null

  async function regenerate() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/coaching/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callerId ? { caller_id: callerId } : {}),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Kon geen advies genereren')
        return
      }
      setAdvice(data.advice_text)
      setContext(data.context_summary)
      setGeneratedAt(data.generated_at)
    } catch {
      setError('Netwerkfout — probeer opnieuw')
    } finally {
      setLoading(false)
    }
  }

  const lastUpdated = generatedAt
    ? new Date(generatedAt).toLocaleString('nl-BE', { dateStyle: 'medium', timeStyle: 'short' })
    : null

  return (
    <div className="card p-5 mb-8 bg-gradient-to-br from-brand-50/40 to-white border-brand-100">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-100 flex items-center justify-center text-brand-700">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 1.5l1.85 4.06L14 6.3l-3.1 2.85.85 4.35L8 11.4l-3.75 2.1.85-4.35L2 6.3l4.15-.74L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-900">Coaching op maat</div>
            <div className="text-xs text-gray-500">
              {advice
                ? `Gebaseerd op je laatste ${context?.period_days ?? 30} dagen`
                : 'Krijg een AI-gegenereerd advies op basis van je calls'}
            </div>
          </div>
        </div>

        <button
          onClick={regenerate}
          disabled={loading}
          className="btn-secondary text-xs disabled:opacity-50"
        >
          {loading
            ? 'Bezig…'
            : advice
              ? 'Vernieuw advies'
              : 'Genereer advies'}
        </button>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-100 text-sm text-red-700">
          {error}
        </div>
      )}

      {!advice && !loading && !error && (
        <div className="text-sm text-gray-600 leading-relaxed">
          Klik op <strong>Genereer advies</strong> om een persoonlijk advies te krijgen op basis
          van je belprestaties van de laatste 30 dagen — reach rate, conversie, top bezwaren en
          je eigen callnotities.
        </div>
      )}

      {advice && (
        <>
          <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
            {advice}
          </div>

          {context && (
            <div className="mt-4 pt-3 border-t border-brand-100/60 flex items-center gap-4 flex-wrap text-xs text-gray-500">
              <span>
                <span className="text-gray-400">Calls: </span>
                <span className="text-gray-700 font-medium">{context.total_calls}</span>
              </span>
              <span>
                <span className="text-gray-400">Reach: </span>
                <span className="text-gray-700 font-medium">{context.reach_rate}%</span>
              </span>
              <span>
                <span className="text-gray-400">Conversie: </span>
                <span className="text-gray-700 font-medium">{context.conv_rate}%</span>
              </span>
              {lastUpdated && (
                <span className="ml-auto text-gray-400">
                  Bijgewerkt {lastUpdated}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
