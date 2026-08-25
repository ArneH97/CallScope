'use client'

import { useState, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'

interface Props {
  projectId:   string
  periodKey:   string     // bv "month:2026-07" of "custom:2026-07-01_2026-07-31"
  sectionKey:  string     // bv "funnel", "dealstages", "caller:UUID"
  initialText: string     // huidige waarde uit DB (via report/page.tsx)
  /** Label voor "voeg notitie toe"-knop. Optioneel. */
  placeholder?: string
  /** True = compacter (kleiner lettertype, minder padding). Voor sub-secties. */
  compact?:    boolean
}

/**
 * Inline commentaar-veld voor het rapport. Toont "+ Notitie toevoegen"
 * als er nog niks staat. Bij klik → textarea + Opslaan/Annuleren. Als er
 * al tekst is → tekst zichtbaar in blauw-oranje kader, klikbaar om te
 * bewerken. Print-modus: verbergt de bewerk-knoppen, toont enkel de tekst
 * netjes gerenderd (met behoud van newlines).
 *
 * Persistent via POST /api/projects/[id]/annotations. Auto-save bij blur
 * óók, zodat je niet vergeet op Opslaan te drukken.
 */
export default function AnnotationField({
  projectId, periodKey, sectionKey,
  initialText, placeholder, compact = false,
}: Props) {
  const t = useTranslations('dashboard.projects.report.annotation')
  const [text, setText]         = useState(initialText)
  const [editing, setEditing]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [savedText, setSaved]   = useState(initialText)   // laatst-opgeslagen versie
  const [error, setError]       = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      // Cursor aan einde
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [editing])

  async function save(newText: string) {
    if (newText === savedText) { setEditing(false); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/annotations`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          period_key:  periodKey,
          section_key: sectionKey,
          text:        newText,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? t('saveFailed'))
      }
      setSaved(newText)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setText(savedText)
    setEditing(false)
    setError(null)
  }

  // Render styles — compact vs normal
  const boxCls = compact
    ? 'text-xs px-2.5 py-1.5 rounded border-l-2'
    : 'text-sm px-3 py-2.5 rounded border-l-2'
  const emptyCls = compact
    ? 'text-xs text-gray-400 hover:text-brand-600 no-print'
    : 'text-sm text-gray-400 hover:text-brand-600 no-print'

  // Editor open
  if (editing) {
    return (
      <div className="my-3 no-print">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={() => save(text)}
          rows={compact ? 2 : 3}
          className="w-full text-sm border border-brand-200 focus:border-brand-400 rounded p-2 resize-y bg-brand-50/30"
          placeholder={placeholder ?? t('placeholder')}
        />
        {error && (
          <p className="text-xs text-red-600 mt-1">{error}</p>
        )}
        <div className="flex gap-2 mt-1.5">
          <button
            onClick={() => save(text)}
            disabled={saving}
            className="text-xs px-2.5 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 font-medium"
          >
            {saving ? t('saving') : t('save')}
          </button>
          <button onClick={cancel} className="text-xs px-2.5 py-1 rounded text-gray-500 hover:bg-gray-100">
            {t('cancel')}
          </button>
        </div>
      </div>
    )
  }

  // Bestaande notitie — klikbaar om te bewerken. Print toont alleen de
  // tekst met een subtiele linker-border (geen edit-hint).
  if (savedText) {
    return (
      <div
        onClick={() => setEditing(true)}
        className={`${boxCls} my-3 bg-amber-50/60 border-amber-300 text-gray-700 whitespace-pre-wrap cursor-text hover:bg-amber-50 print:cursor-default print:hover:bg-amber-50/60`}
        title={t('editHint')}
      >
        {savedText}
      </div>
    )
  }

  // Leeg — knop om te starten. Niet zichtbaar in print.
  return (
    <button
      onClick={() => setEditing(true)}
      className={`${emptyCls} my-2 inline-flex items-center gap-1`}
    >
      <span>+</span>
      <span>{placeholder ?? t('addNote')}</span>
    </button>
  )
}
