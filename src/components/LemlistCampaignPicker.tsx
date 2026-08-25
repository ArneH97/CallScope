'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

type TaskSource = { id: string; name: string; count: number }

const ALL_SOURCES_VALUE = '*'

/**
 * Card op de project-settings die een Lemlist task-source aan het project
 * koppelt. Cold callers in Lemlist zien hun werk als tasks (per call) waar
 * elk een "task source" heeft (= campaign-naam in Lemlist).
 *
 * De cc_manager kiest hier ofwel:
 *   - één specifieke source → enkel tasks van die source landen in dit project
 *   - "alle bronnen" → álle voltooide call-tasks van deze user landen in dit project
 *
 * Toont enkel voor cc_managers met een Lemlist-koppeling.
 */
export default function LemlistCampaignPicker({
  projectId,
  initialCampaignId,
  initialCampaignName,
}: {
  projectId:           string
  initialCampaignId:   string | null
  initialCampaignName: string | null
}) {
  const [hasIntegration, setHasIntegration] = useState<boolean | null>(null)
  const [sources, setSources]               = useState<TaskSource[]>([])
  const [loading, setLoading]               = useState(true)
  const [selectedId, setSelectedId]         = useState<string>(initialCampaignId ?? '')
  const [saving, setSaving]                 = useState(false)
  const [message, setMessage]               = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) { setLoading(false); return }

    const { data: int } = await sb
      .from('lemlist_integrations')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!int) {
      setHasIntegration(false)
      setLoading(false)
      return
    }

    setHasIntegration(true)

    try {
      const res = await fetch('/api/integrations/lemlist/sources')
      const data = await res.json()
      if (res.ok) {
        setSources(data.sources ?? [])
      } else {
        setMessage({ type: 'error', text: data.error ?? 'Sources ophalen mislukt' })
      }
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'Onbekende fout' })
    }
    setLoading(false)
  }

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    const sb = createClient()
    const chosenLabel = selectedId === ALL_SOURCES_VALUE
      ? 'Alle task-sources'
      : sources.find(s => s.id === selectedId)?.name ?? null

    const { error } = await sb
      .from('projects')
      .update({
        lemlist_campaign_id:   selectedId || null,
        lemlist_campaign_name: chosenLabel,
      })
      .eq('id', projectId)

    setSaving(false)
    if (error) {
      setMessage({ type: 'error', text: `Opslaan mislukt: ${error.message}` })
      return
    }
    setMessage({
      type: 'ok',
      text: selectedId
        ? `✓ Gekoppeld aan "${chosenLabel}". Volgende sync: vannacht.`
        : '✓ Lemlist-koppeling verwijderd.',
    })
  }

  if (loading) return null

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M3 7l9 6 9-6M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z"
                stroke="#9333ea" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <h3 className="text-sm font-medium text-gray-900">Lemlist task-source</h3>
          </div>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">
            Kies welke Lemlist task-source bij dit project hoort. CallScope synct elke nacht
            de voltooide call-tasks (en hun outcome + notes) als call_records voor dit project.
          </p>
        </div>
      </div>

      {hasIntegration === false ? (
        <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg text-sm">
          <p className="text-amber-800 mb-2">
            Verbind eerst je Lemlist-account om een task-source te kunnen kiezen.
          </p>
          <Link href="/dashboard/settings/integrations" className="text-xs text-brand-600 hover:underline font-medium">
            Naar integraties →
          </Link>
        </div>
      ) : (
        <>
          <select
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
            className="input text-sm"
          >
            <option value="">— geen Lemlist-koppeling —</option>
            <option value={ALL_SOURCES_VALUE}>
              ⭐ Alle task-sources (al mijn calls landen in dit project)
            </option>
            {sources.length > 0 && (
              <optgroup label="Specifieke sources">
                {sources.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.count} task{s.count === 1 ? '' : 's'})
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          {sources.length === 0 && (
            <p className="text-xs text-amber-600 mt-2">
              Geen task-sources gevonden. Mogelijk heb je nog geen tasks in Lemlist, of werkt
              je API-key niet. Check je verbinding op de integraties-pagina.
            </p>
          )}

          {initialCampaignName && initialCampaignId && !selectedId && (
            <p className="text-xs text-gray-400 mt-1">
              Was gekoppeld aan &quot;{initialCampaignName}&quot;.
            </p>
          )}

          {message && (
            <p className={`text-xs mt-2 px-3 py-2 rounded-lg ${
              message.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {message.text}
            </p>
          )}

          <div className="flex justify-end mt-3">
            <button
              onClick={handleSave}
              disabled={saving || selectedId === (initialCampaignId ?? '')}
              className="btn-primary text-sm"
            >
              {saving ? 'Opslaan…' : 'Opslaan'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
