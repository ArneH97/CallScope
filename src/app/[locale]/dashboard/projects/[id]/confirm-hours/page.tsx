'use client'

import { useEffect, useState, Suspense } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useTranslations, useLocale } from 'next-intl'
import { createClient } from '@/lib/supabase/client'

/**
 * Bevestigings-pagina voor wekelijkse uren per cold caller per dag.
 *
 * Cc_manager kan per cold caller voor de actieve week 5 dag-velden invullen
 * (Ma-Vr). hours_actual (in DB) wordt automatisch berekend als sum van de 5
 * dagen — zo blijft de cost-metrics helper en de weekly-hour cron werken
 * zonder dat ze de per-dag splitsing hoeven te kennen.
 *
 * Default bij eerste opening van een week: preset / 5 per werkdag. Bij een
 * legacy bevestiging (alleen hours_actual gezet, dag-kolommen NULL/0) doet de
 * SQL-migratie de evenredige verdeling al, dus die toont zich hier gewoon
 * netjes met 5 gevulde velden.
 */

type CallerRow = {
  caller_id:           string
  full_name:           string
  weekly_hours_preset: number | null
  hourly_rate:         number | null
  hours_mon:           number | ''
  hours_tue:           number | ''
  hours_wed:           number | ''
  hours_thu:           number | ''
  hours_fri:           number | ''
  already_confirmed:   boolean
  /** True = caller is uit project_members verwijderd, maar heeft nog wél
      een uren-registratie voor déze week. Zichtbaar met een chip zodat de
      manager kan zien "dit is een voormalige caller" en niet per abuis
      preset-uren gaat toepassen. */
  is_former:           boolean
}

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri'
const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri']

function ConfirmHoursContent() {
  const t = useTranslations('dashboard.projects.confirmHours')
  const locale = useLocale()
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const projectId = params.id as string

  // ?week=YYYY-MM-DD (maandag van die week). Default = maandag van deze week.
  const weekParam = searchParams.get('week') ?? defaultMondayIso()
  const weekStart = parseIsoDate(weekParam)

  const [projectName, setProjectName]     = useState('')
  const [projectFirstWeek, setFirstWeek]  = useState<string | null>(null)
  const [callers, setCallers]             = useState<CallerRow[]>([])
  const [loading, setLoading]             = useState(true)
  const [saving, setSaving]               = useState(false)
  const [message, setMessage]             = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [allowed, setAllowed]             = useState(true)

  useEffect(() => { load() }, [projectId, weekParam])

  async function load() {
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) { router.push('/auth/login'); return }

    // Project + permissie-check
    const { data: proj } = await sb
      .from('projects')
      .select('id, name, created_at')
      .eq('id', projectId)
      .single()
    if (!proj) { setAllowed(false); setLoading(false); return }
    type ProjLite = { name: string; created_at: string }
    const projData = proj as ProjLite
    setProjectName(projData.name)
    setFirstWeek(mondayOfDate(projData.created_at))

    const { data: ccLink } = await sb
      .from('project_call_centers')
      .select('call_centers!inner(manager_id)')
      .eq('project_id', projectId)
      .maybeSingle()
    type CCRow = { call_centers: { manager_id: string } | { manager_id: string }[] | null }
    const link = ccLink as CCRow | null
    const cc = Array.isArray(link?.call_centers) ? link?.call_centers[0] : link?.call_centers
    if (cc?.manager_id !== user.id) {
      setAllowed(false); setLoading(false); return
    }

    // Cold callers
    const { data: pmRows } = await sb
      .from('project_members')
      .select('profile_id, profiles!inner(full_name)')
      .eq('project_id', projectId)
      .eq('role', 'cold_caller')

    type PM = { profile_id: string; profiles: { full_name: string | null } | { full_name: string | null }[] | null }
    const list: { profile_id: string; full_name: string }[] = ((pmRows ?? []) as PM[]).map(r => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
      return { profile_id: r.profile_id, full_name: p?.full_name ?? t('unknownName') }
    })

    // Freelance cc_manager toevoegen als hij zelf belt
    const { data: selfProf } = await sb
      .from('profiles')
      .select('full_name, is_freelance, role')
      .eq('id', user.id)
      .single()
    type Self = { full_name: string | null; is_freelance: boolean; role: string }
    const self = selfProf as Self | null
    if (self?.is_freelance && self.role === 'cc_manager' && !list.some(l => l.profile_id === user.id)) {
      list.unshift({ profile_id: user.id, full_name: (self.full_name ?? t('selfFallback')) + ' ' + t('selfSuffix') })
    }

    if (list.length === 0) {
      setCallers([])
      setLoading(false)
      return
    }

    // Rates
    const { data: rateRows } = await sb
      .from('project_caller_rates')
      .select('caller_id, weekly_hours_preset, hourly_rate')
      .eq('project_id', projectId)
    type Rate = { caller_id: string; weekly_hours_preset: number | null; hourly_rate: number | null }
    const rates = new Map((rateRows ?? []).map(r => [(r as Rate).caller_id, r as Rate]))

    // Bestaande bevestigingen — incl. per-dag uren
    const { data: confRows } = await sb
      .from('weekly_hour_confirmations')
      .select('caller_id, hours_actual, hours_mon, hours_tue, hours_wed, hours_thu, hours_fri')
      .eq('project_id', projectId)
      .eq('week_start_date', weekStart)
    type Conf = {
      caller_id:    string
      hours_actual: number
      hours_mon:    number | null
      hours_tue:    number | null
      hours_wed:    number | null
      hours_thu:    number | null
      hours_fri:    number | null
    }
    const confs = new Map((confRows ?? []).map(r => [(r as Conf).caller_id, r as Conf]))

    // Voormalige callers: iedereen die een uren-registratie voor déze week
    // heeft, maar niet meer in project_members zit. Nodig zodat de manager
    // historische uren van ontslagen/vertrokken callers nog kan corrigeren.
    // We halen enkel hun naam op — de conf-row zelf zit al in `confs`.
    const activeIds = new Set(list.map(l => l.profile_id))
    const formerIds = Array.from(confs.keys()).filter(id => !activeIds.has(id))
    if (formerIds.length > 0) {
      const { data: formerProfs } = await sb
        .from('profiles')
        .select('id, full_name')
        .in('id', formerIds)
      type FP = { id: string; full_name: string | null }
      for (const fp of ((formerProfs ?? []) as FP[])) {
        list.push({ profile_id: fp.id, full_name: fp.full_name ?? t('unknownName') })
      }
    }
    const formerIdSet = new Set(formerIds)

    setCallers(list.map(c => {
      const rate = rates.get(c.profile_id)
      const conf = confs.get(c.profile_id)
      const preset = rate?.weekly_hours_preset ?? null

      // Default per-dag: preset/5 (afgerond op 1 decimaal) bij eerste opening
      const defaultPerDay = preset != null ? round1(preset / 5) : ''

      return {
        caller_id:           c.profile_id,
        full_name:           c.full_name,
        weekly_hours_preset: preset,
        hourly_rate:         rate?.hourly_rate ?? null,
        hours_mon:           conf?.hours_mon ?? defaultPerDay,
        hours_tue:           conf?.hours_tue ?? defaultPerDay,
        hours_wed:           conf?.hours_wed ?? defaultPerDay,
        hours_thu:           conf?.hours_thu ?? defaultPerDay,
        hours_fri:           conf?.hours_fri ?? defaultPerDay,
        already_confirmed:   confs.has(c.profile_id),
        is_former:           formerIdSet.has(c.profile_id),
      }
    }).sort((a, b) => {
      // Actieve callers eerst, voormalige onderaan — anders raakt de UI
      // druk bij projecten met meerdere ontslagen callers historisch.
      if (a.is_former !== b.is_former) return a.is_former ? 1 : -1
      return a.full_name.localeCompare(b.full_name)
    }))
    setLoading(false)
  }

  function setDay(callerId: string, day: DayKey, val: string) {
    const num = val.trim() === '' ? '' : Number(val)
    setCallers(prev => prev.map(c =>
      c.caller_id === callerId
        ? { ...c, [`hours_${day}`]: typeof num === 'number' && Number.isFinite(num) ? num : '' }
        : c,
    ))
  }

  /** Reset alle 5 dag-velden naar preset/5 voor elke ACTIEVE caller.
      Voormalige callers laten we ongemoeid — de manager past hun uren
      handmatig aan, we willen niet dat "alle presets"-knop een net
      gecorrigeerde vertrokken caller weer overschrijft. */
  function applyAllPresets() {
    setCallers(prev => prev.map(c => {
      if (c.is_former) return c
      const perDay = c.weekly_hours_preset != null ? round1(c.weekly_hours_preset / 5) : ''
      return {
        ...c,
        hours_mon: perDay,
        hours_tue: perDay,
        hours_wed: perDay,
        hours_thu: perDay,
        hours_fri: perDay,
      }
    }))
  }

  /** Som van de 5 dag-velden voor één caller. */
  function callerTotal(c: CallerRow): number {
    return DAY_KEYS.reduce((sum, key) => {
      const v = c[`hours_${key}`]
      return sum + (typeof v === 'number' ? v : 0)
    }, 0)
  }

  async function handleSubmit() {
    setSaving(true)
    setMessage(null)
    const sb = createClient()

    // Bouw rows: enkel callers met minstens één dag ingevuld of een totaal > 0
    const rows = callers
      .map(c => {
        const total = callerTotal(c)
        return {
          project_id:      projectId,
          caller_id:       c.caller_id,
          week_start_date: weekStart,
          hours_mon:       Number(c.hours_mon) || 0,
          hours_tue:       Number(c.hours_tue) || 0,
          hours_wed:       Number(c.hours_wed) || 0,
          hours_thu:       Number(c.hours_thu) || 0,
          hours_fri:       Number(c.hours_fri) || 0,
          hours_actual:    total,
          confirmed_at:    new Date().toISOString(),
        }
      })
      // Filter callers waar ALLE dagen leeg/0 zijn én die niet eerder bevestigd
      // waren — geen zin om lege rijen weg te schrijven. Een caller die op 0u
      // wil zetten kan dat door bewust nullen in te tikken (typeof === 'number').
      .filter((r, idx) => {
        const c = callers[idx]
        const hasAny = DAY_KEYS.some(key => typeof c[`hours_${key}`] === 'number')
        return hasAny || c.already_confirmed
      })

    if (rows.length === 0) {
      setMessage({ type: 'error', text: t('emptyError') })
      setSaving(false)
      return
    }

    const { error } = await sb
      .from('weekly_hour_confirmations')
      .upsert(rows, { onConflict: 'project_id,caller_id,week_start_date' })

    setSaving(false)
    if (error) {
      setMessage({ type: 'error', text: t('submitFailed', { error: error.message }) })
      return
    }
    setMessage({ type: 'ok', text: t('saveSuccess', { count: rows.length }) })

    const confirmedIds = new Set(rows.map(r => r.caller_id))
    setCallers(prev => prev.map(c =>
      confirmedIds.has(c.caller_id) ? { ...c, already_confirmed: true } : c
    ))
  }

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>
  if (!allowed) return (
    <div className="card p-8 text-center max-w-md">
      <p className="text-sm text-gray-500">{t('noAccess')}</p>
      <Link href="/dashboard/projects" className="text-brand-600 hover:underline text-sm mt-3 inline-block">
        {t('backToProjectsArrow')}
      </Link>
    </div>
  )

  const weekEnd = new Date(weekStart + 'T00:00:00Z')
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6)
  const weekLabel = `${formatDate(weekStart, locale)} → ${formatDate(weekEnd.toISOString().slice(0, 10), locale)}`

  const totalHours = callers.reduce((sum, c) => sum + callerTotal(c), 0)
  const totalCost  = callers.reduce((sum, c) => sum + callerTotal(c) * (c.hourly_rate ?? 0), 0)

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <Link href="/dashboard/projects" className="text-sm text-gray-400 hover:text-gray-600 inline-flex items-center gap-1.5 mb-3">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('backToProjects')}
        </Link>
        <h1 className="text-2xl font-semibold text-gray-900">{t('title', { projectName })}</h1>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {(() => {
            const atFirstWeek = projectFirstWeek != null && weekStart <= projectFirstWeek
            return (
              <button
                onClick={() => !atFirstWeek && router.push(`/dashboard/projects/${projectId}/confirm-hours?week=${shiftWeek(weekStart, -1)}`)}
                disabled={atFirstWeek}
                className="text-xs px-3 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:border-brand-300 hover:text-brand-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-200 disabled:hover:text-gray-600"
                title={atFirstWeek ? t('previousWeekDisabledTip') : t('previousWeekTip')}
              >
                {t('previousWeek')}
              </button>
            )
          })()}
          <span className="text-sm text-gray-700 font-medium px-2">{t('weekOf', { label: weekLabel })}</span>
          <button
            onClick={() => router.push(`/dashboard/projects/${projectId}/confirm-hours?week=${shiftWeek(weekStart, +1)}`)}
            className="text-xs px-3 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:border-brand-300 hover:text-brand-700 transition-colors"
            title={t('nextWeekTip')}
          >
            {t('nextWeek')}
          </button>
          {weekStart !== defaultMondayIso() && (
            <button
              onClick={() => router.push(`/dashboard/projects/${projectId}/confirm-hours`)}
              className="text-xs text-brand-600 hover:underline ml-1"
            >
              {t('toThisWeek')}
            </button>
          )}
        </div>
        {projectFirstWeek != null && weekStart < projectFirstWeek && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-800">
            {t('beforeCreationWarning')}
          </div>
        )}
      </div>

      {callers.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-gray-500">
            {t('noCallers')}{' '}
            <Link href={`/dashboard/projects/${projectId}/settings`} className="text-brand-600 hover:underline">
              {t('projectSettingsLink')}
            </Link>.
          </p>
        </div>
      ) : (
        <>
          <div className="card p-5 mb-4">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <p className="text-sm text-gray-500">{t('intro')}</p>
              <button
                onClick={applyAllPresets}
                className="text-xs text-brand-600 hover:underline whitespace-nowrap"
              >
                {t('resetPresets')}
              </button>
            </div>

            <div className="space-y-3">
              {callers.map(c => (
                <CallerCard
                  key={c.caller_id}
                  caller={c}
                  total={callerTotal(c)}
                  onChange={(day, val) => setDay(c.caller_id, day, val)}
                />
              ))}
            </div>
          </div>

          <div className="card p-4 mb-4 bg-gray-50/50">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">{t('totalWeek')}</span>
              <span className="font-medium text-gray-900">
                {totalHours.toFixed(1)}u
                {totalCost > 0 && ` · €${totalCost.toFixed(0)}`}
              </span>
            </div>
          </div>

          {message && (
            <div className={`mb-4 px-3 py-2 rounded-lg text-sm ${
              message.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
            }`}>
              {message.text}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Link href="/dashboard/projects" className="btn-secondary text-sm">
              {t('cancel')}
            </Link>
            <button onClick={handleSubmit} disabled={saving} className="btn-primary text-sm">
              {saving ? t('submitting') : t('submit')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Eén caller-rij met de 5 dag-inputs. Op desktop staat alles op één rij,
 * op mobile stack we de inputs onder elkaar voor leesbaarheid.
 */
function CallerCard({
  caller, total, onChange,
}: {
  caller: CallerRow
  total:  number
  onChange: (day: DayKey, val: string) => void
}) {
  const t = useTranslations('dashboard.projects.confirmHours')
  const presetValue = caller.weekly_hours_preset != null
    ? t('card.presetUnit', { hours: caller.weekly_hours_preset })
    : t('card.presetEmpty')

  return (
    <div className="rounded-lg border border-gray-100 p-3">
      {/* Header rij: naam + preset + total + badge */}
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 flex-shrink-0">
            {caller.full_name[0]}
          </div>
          <span className="text-sm text-gray-700 font-medium">{caller.full_name}</span>
          {caller.is_former && (
            <span className="badge badge-gray text-xs" title={t('card.formerTooltip')}>
              {t('card.former')}
            </span>
          )}
          {caller.already_confirmed && (
            <span className="badge badge-green text-xs">{t('card.alreadyConfirmed')}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-gray-400">
            {t('card.preset', { value: presetValue })}
          </span>
          <span className="font-medium text-gray-700">
            {t('card.total', { hours: total.toFixed(1) })}
          </span>
        </div>
      </div>

      {/* 5 dag-inputs */}
      <div className="grid grid-cols-5 gap-2">
        {DAY_KEYS.map(key => (
          <div key={key}>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1 text-center">
              {t(`days.${key}`)}
            </label>
            <input
              type="number"
              min="0"
              max="24"
              step="0.5"
              value={caller[`hours_${key}`] === '' ? '' : caller[`hours_${key}`]}
              onChange={e => onChange(key, e.target.value)}
              placeholder="0"
              className="input text-sm text-center w-full"
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function defaultMondayIso(): string {
  const d = new Date()
  const day = d.getUTCDay()
  const offset = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

function shiftWeek(iso: string, weeks: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + weeks * 7)
  return d.toISOString().slice(0, 10)
}

function mondayOfDate(iso: string): string {
  const d = new Date(iso)
  const day = d.getUTCDay()
  const offset = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

function parseIsoDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return defaultMondayIso()
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  // Map next-intl locale codes naar BCP-47 (nl → nl-BE voor consistent
  // "10 mei"-formaat; en → en-US voor "May 10").
  const bcp47 = locale === 'nl' ? 'nl-BE' : locale
  return d.toLocaleDateString(bcp47, { day: 'numeric', month: 'short' })
}

export default function ConfirmHoursPage() {
  return (
    <Suspense fallback={<FallbackLoading />}>
      <ConfirmHoursContent />
    </Suspense>
  )
}

function FallbackLoading() {
  const t = useTranslations('dashboard.projects.confirmHours')
  return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>
}
