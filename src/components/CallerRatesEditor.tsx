'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type CallerOption = {
  profile_id: string
  full_name:  string
  is_self:    boolean   // true wanneer dit de freelance cc_manager zelf is
}

type RateRow = {
  caller_id:           string
  weekly_hours_preset: number | null
  hourly_rate:         number | null
  currency:            string
}

/**
 * Card op de project-settings die per cold caller op het project een
 * weekly_hours_preset + hourly_rate laat instellen. Beide velden zijn
 * optioneel — leeg laten = caller telt niet mee in de kost-metrics.
 *
 * Voor freelance cc_managers: de eigenaar staat OOK in de lijst (hij is
 * tegelijk caller én manager). Hij kan dus voor zichzelf een tarief zetten
 * en zijn eigen uren bevestigen.
 */
export default function CallerRatesEditor({ projectId }: { projectId: string }) {
  const [callers, setCallers]   = useState<CallerOption[]>([])
  const [rates, setRates]       = useState<Record<string, RateRow>>({})
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [message, setMessage]   = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => { load() }, [projectId])

  async function load() {
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) { setLoading(false); return }

    // Haal alle cold_caller project_members op + freelance cc_manager zelf
    const { data: pmRows } = await sb
      .from('project_members')
      .select('profile_id, role, profiles!inner(full_name)')
      .eq('project_id', projectId)
      .eq('role', 'cold_caller')

    type PM = { profile_id: string; role: string; profiles: { full_name: string | null } | { full_name: string | null }[] | null }
    const list: CallerOption[] = ((pmRows ?? []) as PM[]).map(r => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
      return {
        profile_id: r.profile_id,
        full_name:  p?.full_name ?? 'Onbekend',
        is_self:    r.profile_id === user.id,
      }
    })

    // Eigen profiel ophalen — als is_freelance=true en nog niet in de lijst,
    // toevoegen zodat de freelancer voor zichzelf een tarief kan zetten.
    const { data: selfProf } = await sb
      .from('profiles')
      .select('id, full_name, role, is_freelance')
      .eq('id', user.id)
      .single()
    type Self = { id: string; full_name: string | null; role: string; is_freelance: boolean }
    const self = selfProf as Self | null

    if (self?.is_freelance && self.role === 'cc_manager' && !list.some(l => l.profile_id === self.id)) {
      list.unshift({
        profile_id: self.id,
        full_name:  (self.full_name ?? 'Mijzelf') + ' (jij)',
        is_self:    true,
      })
    }

    setCallers(list)

    // Bestaande rates ophalen
    const { data: rateRows } = await sb
      .from('project_caller_rates')
      .select('caller_id, weekly_hours_preset, hourly_rate, currency')
      .eq('project_id', projectId)

    const rateMap: Record<string, RateRow> = {}
    for (const c of list) {
      const existing = (rateRows ?? []).find((r) => (r as RateRow).caller_id === c.profile_id) as RateRow | undefined
      rateMap[c.profile_id] = existing ?? {
        caller_id:           c.profile_id,
        weekly_hours_preset: null,
        hourly_rate:         null,
        currency:            'EUR',
      }
    }
    setRates(rateMap)
    setLoading(false)
  }

  function setField(callerId: string, field: 'weekly_hours_preset' | 'hourly_rate', value: string) {
    const num = value.trim() === '' ? null : Number(value)
    setRates(prev => ({
      ...prev,
      [callerId]: { ...prev[callerId], [field]: num !== null && Number.isFinite(num) ? num : null },
    }))
  }

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    const sb = createClient()

    const upserts = Object.values(rates).map(r => ({
      project_id:          projectId,
      caller_id:           r.caller_id,
      weekly_hours_preset: r.weekly_hours_preset,
      hourly_rate:         r.hourly_rate,
      currency:            r.currency || 'EUR',
    }))

    if (upserts.length === 0) {
      setSaving(false)
      return
    }

    const { error } = await sb
      .from('project_caller_rates')
      .upsert(upserts, { onConflict: 'project_id,caller_id' })

    setSaving(false)
    if (error) {
      setMessage({ type: 'error', text: `Opslaan mislukt: ${error.message}` })
      return
    }
    setMessage({ type: 'ok', text: '✓ Tarieven en presets opgeslagen.' })
  }

  if (loading) return null

  return (
    <div className="card p-5 mb-5">
      <div className="text-sm font-medium text-gray-900 mb-1">Tijdsbudget &amp; uurtarieven</div>
      <p className="text-xs text-gray-500 mb-4 leading-relaxed">
        Optioneel — als je hier per cold caller invult hoeveel uren hij wekelijks zou moeten
        werken en wat het uurtarief is, krijg je elke vrijdag een mail om de gepresteerde uren
        te bevestigen. De data verschijnt dan in het sales-dashboard en het klant-rapport
        (uren/afspraak, kost/afspraak, kost/deal). Leeg laten = feature blijft uit voor deze caller.
      </p>

      {callers.length === 0 ? (
        <p className="text-sm text-gray-400 italic">
          Voeg eerst cold callers toe aan dit project — dan verschijnen ze hier.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {/* Header — alleen op desktop */}
            <div className="hidden sm:grid sm:grid-cols-[1fr,140px,140px] gap-3 text-xs text-gray-500 px-2">
              <div>Cold caller</div>
              <div>Uren / week</div>
              <div>Tarief / uur (€)</div>
            </div>

            {callers.map(c => {
              const rate = rates[c.profile_id]
              return (
                <div
                  key={c.profile_id}
                  className="flex flex-col sm:grid sm:grid-cols-[1fr,140px,140px] gap-2 sm:gap-3 p-3 sm:p-2 rounded-lg border border-gray-100"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 flex-shrink-0">
                      {c.full_name[0]}
                    </div>
                    <span className="text-sm text-gray-700">{c.full_name}</span>
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={rate?.weekly_hours_preset ?? ''}
                    onChange={e => setField(c.profile_id, 'weekly_hours_preset', e.target.value)}
                    placeholder="bv 10"
                    className="input text-sm"
                  />
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={rate?.hourly_rate ?? ''}
                    onChange={e => setField(c.profile_id, 'hourly_rate', e.target.value)}
                    placeholder="bv 55"
                    className="input text-sm"
                  />
                </div>
              )
            })}
          </div>

          {message && (
            <p className={`text-sm mt-3 px-3 py-2 rounded-lg ${
              message.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {message.text}
            </p>
          )}

          <div className="flex justify-end mt-4">
            <button onClick={handleSave} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Opslaan…' : 'Opslaan'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
