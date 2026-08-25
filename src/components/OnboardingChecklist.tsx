'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

const DISMISS_KEY = 'callscope_onboarding_dismissed'

type StepKey = 'project' | 'team' | 'upload' | 'appointment'

type Step = {
  key:   StepKey
  title: string
  desc:  string
  href:  string
  cta:   string
  done:  boolean
}

/**
 * Checklist-widget dat cc_managers door de eerste stappen leidt.
 *
 * Verbergt zichzelf automatisch wanneer:
 *   - alle 4 stappen afgevinkt zijn (live uit DB-state)
 *   - de user op "Verberg" geklikt heeft (localStorage flag)
 *
 * Toont enkel voor cc_managers — andere rollen krijgen hem niet.
 */
export default function OnboardingChecklist({ profileRole }: { profileRole: string }) {
  const [loading, setLoading]   = useState(true)
  const [steps, setSteps]       = useState<Step[]>([])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (profileRole !== 'cc_manager') {
      setLoading(false)
      return
    }
    if (typeof window !== 'undefined' && localStorage.getItem(DISMISS_KEY) === '1') {
      setDismissed(true)
      setLoading(false)
      return
    }
    loadProgress()
  }, [profileRole])

  async function loadProgress() {
    const sb = createClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) { setLoading(false); return }

    // Pak alle projecten waar deze cc_manager bij betrokken is via zijn call_center
    const { data: ccRow } = await sb
      .from('call_centers')
      .select('id')
      .eq('manager_id', user.id)
      .maybeSingle()
    const ccId = (ccRow as { id: string } | null)?.id

    if (!ccId) {
      // Geen call_center → ook geen projecten mogelijk
      setSteps(buildSteps({ hasProject: false, hasTeam: false, hasUpload: false, hasAppointment: false }))
      setLoading(false)
      return
    }

    // Project-ids van deze cc_manager
    const { data: pccRows } = await sb
      .from('project_call_centers')
      .select('project_id')
      .eq('call_center_id', ccId)
    const projectIds = ((pccRows ?? []) as { project_id: string }[]).map(r => r.project_id)

    if (projectIds.length === 0) {
      setSteps(buildSteps({ hasProject: false, hasTeam: false, hasUpload: false, hasAppointment: false }))
      setLoading(false)
      return
    }

    // Team: project_members met een rol andere dan cc_manager (= echte teamleden,
    // geen self). Cold_caller / sales_rep / sales_manager tellen.
    const { data: pmRows } = await sb
      .from('project_members')
      .select('id')
      .in('project_id', projectIds)
      .in('role', ['cold_caller', 'sales_rep', 'sales_manager'])
      .limit(1)
    const hasTeam = (pmRows ?? []).length > 0

    // Upload: minstens één upload op één van zijn projecten
    const { data: upRows } = await sb
      .from('uploads')
      .select('id')
      .in('project_id', projectIds)
      .limit(1)
    const hasUpload = (upRows ?? []).length > 0

    // Afspraak: minstens één call_record met status die "afspraak" bevat
    const { data: apptRows } = await sb
      .from('call_records')
      .select('id')
      .in('project_id', projectIds)
      .or('status.ilike.%afspraak%,status.ilike.%appointment%')
      .limit(1)
    const hasAppointment = (apptRows ?? []).length > 0

    setSteps(buildSteps({
      hasProject:     true,
      hasTeam,
      hasUpload,
      hasAppointment,
    }))
    setLoading(false)
  }

  function handleDismiss() {
    if (typeof window !== 'undefined') {
      localStorage.setItem(DISMISS_KEY, '1')
    }
    setDismissed(true)
  }

  if (profileRole !== 'cc_manager') return null
  if (loading) return null
  if (dismissed) return null

  const doneCount = steps.filter(s => s.done).length
  const total     = steps.length

  // Alles klaar → niet meer tonen, en flag zetten zodat hij niet meer terugkomt
  // als de user iets verwijdert.
  if (doneCount === total) {
    if (typeof window !== 'undefined') {
      localStorage.setItem(DISMISS_KEY, '1')
    }
    return null
  }

  const pct = Math.round((doneCount / total) * 100)
  const nextStep = steps.find(s => !s.done)

  return (
    <div className="card p-5 mb-6 border-brand-100 bg-gradient-to-br from-brand-50/60 to-white">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-base">🎯</span>
            <h2 className="font-semibold text-gray-900">Aan de slag met CallScope</h2>
          </div>
          <p className="text-xs text-gray-500">
            {doneCount === 0
              ? 'Vier kleine stappen en je hebt je eerste rapportage.'
              : `${doneCount} van ${total} stappen klaar — bijna er.`}
          </p>
        </div>
        <button
          onClick={handleDismiss}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
          title="Verberg deze checklist"
        >
          Verberg
        </button>
      </div>

      {/* Progressbalk */}
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-4">
        <div
          className="h-full bg-brand-600 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Stappen */}
      <div className="space-y-2">
        {steps.map(step => (
          <div
            key={step.key}
            className={`flex items-start gap-3 p-3 rounded-lg transition-colors ${
              step.done
                ? 'bg-green-50/50'
                : nextStep?.key === step.key
                  ? 'bg-white border border-brand-200'
                  : 'bg-white border border-gray-100'
            }`}
          >
            <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
              step.done ? 'bg-green-500 text-white' : 'border-2 border-gray-300'
            }`}>
              {step.done && (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium ${
                step.done ? 'text-gray-500 line-through' : 'text-gray-900'
              }`}>
                {step.title}
              </div>
              {!step.done && (
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{step.desc}</p>
              )}
            </div>
            {!step.done && (
              <Link
                href={step.href}
                className="text-xs text-brand-600 hover:text-brand-700 font-medium flex-shrink-0 self-center whitespace-nowrap"
              >
                {step.cta} →
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function buildSteps(p: {
  hasProject:     boolean
  hasTeam:        boolean
  hasUpload:      boolean
  hasAppointment: boolean
}): Step[] {
  return [
    {
      key:   'project',
      title: 'Maak je eerste project aan',
      desc:  'Bepaal hoe leads binnenkomen en hoe feedback verloopt.',
      href:  '/dashboard/projects/new',
      cta:   'Start',
      done:  p.hasProject,
    },
    {
      key:   'team',
      title: 'Nodig je team uit',
      desc:  'Cold callers, sales reps en sales managers — per email.',
      href:  '/dashboard/projects',
      cta:   'Open project',
      done:  p.hasTeam,
    },
    {
      key:   'upload',
      title: 'Doe je eerste upload of koppel een Google Sheet',
      desc:  'Sleep een CSV of koppel je sheet voor automatische sync.',
      href:  '/dashboard/upload',
      cta:   'Upload',
      done:  p.hasUpload,
    },
    {
      key:   'appointment',
      title: 'Krijg je eerste afspraak in CallScope',
      desc:  'Zodra een lead met status "afspraak" binnenkomt, zie je de funnel.',
      href:  '/dashboard/appointments',
      cta:   'Bekijk',
      done:  p.hasAppointment,
    },
  ]
}
