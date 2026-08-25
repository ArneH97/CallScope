'use client'

import { useState, useRef } from 'react'

const MAX_FILES = 5
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 // 10MB totaal

/**
 * Floating "?" knop rechtsonder. Klik opent een modal waar de gebruiker
 * een probleem of vraag kan beschrijven, met optionele screenshots.
 * Submit stuurt alles naar /api/help/submit, dat een mail naar de admin
 * verstuurt via Resend.
 */
export default function HelpButton() {
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitState, setSubmitState] = useState<{ ok: boolean; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function reset() {
    setSubject('')
    setMessage('')
    setFiles([])
    setSubmitState(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function close() {
    setOpen(false)
    // Kleine delay zodat user de success-message nog ziet als hij meteen heropent
    setTimeout(reset, 300)
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(e.target.files ?? [])
    const combined = [...files, ...incoming].slice(0, MAX_FILES)
    const totalBytes = combined.reduce((s, f) => s + f.size, 0)
    if (totalBytes > MAX_TOTAL_BYTES) {
      setSubmitState({ ok: false, text: 'Totaal bestandsformaat te groot (max 10MB).' })
      return
    }
    setFiles(combined)
    setSubmitState(null)
    // Reset input value zodat dezelfde file opnieuw kan worden geselecteerd
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeFile(index: number) {
    setFiles(files.filter((_, i) => i !== index))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!message.trim()) return
    setSubmitting(true)
    setSubmitState(null)

    const formData = new FormData()
    formData.append('subject', subject.trim())
    formData.append('message', message.trim())
    formData.append('page_url', typeof window !== 'undefined' ? window.location.href : '')
    formData.append('user_agent', typeof navigator !== 'undefined' ? navigator.userAgent : '')
    for (const f of files) formData.append('files', f, f.name)

    try {
      const res = await fetch('/api/help/submit', { method: 'POST', body: formData })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSubmitState({ ok: false, text: data.error ?? 'Versturen mislukt — probeer het opnieuw.' })
        setSubmitting(false)
        return
      }
      setSubmitState({ ok: true, text: '✓ Bedankt — we nemen zo snel mogelijk contact op.' })
      setSubmitting(false)
      // Form leegmaken na success
      setSubject('')
      setMessage('')
      setFiles([])
    } catch (err) {
      setSubmitState({
        ok:    false,
        text:  err instanceof Error ? err.message : 'Verbindingsfout — probeer het opnieuw.',
      })
      setSubmitting(false)
    }
  }

  const totalKb = Math.round(files.reduce((s, f) => s + f.size, 0) / 1024)

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 w-12 h-12 rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 hover:shadow-xl transition-all flex items-center justify-center z-40"
        aria-label="Hulp nodig?"
        title="Hulp nodig?"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
          <path d="M9.5 9a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <circle cx="12" cy="17" r="1" fill="currentColor"/>
        </svg>
      </button>

      {/* Modal */}
      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-white rounded-t-xl sm:rounded-xl shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Hulp nodig?</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Beschrijf je vraag of probleem. Voeg eventueel screenshots toe.
                </p>
              </div>
              <button
                onClick={close}
                className="text-gray-300 hover:text-gray-600 text-xl leading-none -mt-1"
                aria-label="Sluiten"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Onderwerp <span className="text-gray-400 font-normal">(optioneel)</span>
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  className="input text-sm"
                  placeholder="bv. Sync werkt niet voor caller X"
                  maxLength={120}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Wat is er aan de hand?
                </label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  className="input text-sm resize-none"
                  rows={5}
                  placeholder="Beschrijf wat je probeerde te doen, wat er gebeurde, en wat je verwachtte..."
                  required
                  maxLength={4000}
                />
                <div className="text-xs text-gray-400 text-right mt-1">{message.length}/4000</div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Screenshots <span className="text-gray-400 font-normal">(optioneel, max {MAX_FILES})</span>
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleFileSelect}
                  className="text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-gray-200 file:bg-white file:text-gray-700 file:hover:bg-gray-50 file:cursor-pointer"
                />
                {files.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs bg-gray-50 px-2 py-1 rounded">
                        <span className="text-gray-700 truncate flex-1">📎 {f.name}</span>
                        <span className="text-gray-400">{Math.round(f.size / 1024)}KB</span>
                        <button
                          type="button"
                          onClick={() => removeFile(i)}
                          className="text-gray-300 hover:text-red-500"
                          aria-label="Verwijderen"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <div className="text-xs text-gray-400">
                      Totaal: {totalKb}KB / {Math.round(MAX_TOTAL_BYTES / 1024)}KB
                    </div>
                  </div>
                )}
              </div>

              {submitState && (
                <p className={`text-sm px-3 py-2 rounded-lg ${
                  submitState.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                }`}>
                  {submitState.text}
                </p>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={close}
                  className="btn-secondary flex-1"
                  disabled={submitting}
                >
                  Sluiten
                </button>
                <button
                  type="submit"
                  disabled={submitting || !message.trim()}
                  className="btn-primary flex-1"
                >
                  {submitting ? 'Verzenden…' : 'Verstuur'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
