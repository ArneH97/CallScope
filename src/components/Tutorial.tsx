'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { Profile, Role } from '@/types/database'

/**
 * Per-rol welkomst-tutorial — een titel/desc + optionele href per stap.
 * De keys mappen naar de tutorial.{role}.steps.{1|2|3|4} entries in messages.
 */
type StepConfig = {
  key: '1' | '2' | '3' | '4'
  href?: string
}

const TUTORIAL_STEPS: Record<Role, StepConfig[]> = {
  cc_manager: [
    { key: '1', href: '/dashboard/projects/new' },
    { key: '2' },
    { key: '3' },
    { key: '4', href: '/dashboard' },
  ],
  cold_caller: [
    { key: '1', href: '/dashboard/projects' },
    { key: '2', href: '/dashboard/upload' },
    { key: '3', href: '/dashboard' },
  ],
  sales_rep: [
    { key: '1', href: '/dashboard/appointments' },
    { key: '2' },
    { key: '3', href: '/dashboard/sales' },
  ],
  sales_manager: [
    { key: '1', href: '/dashboard/appointments' },
    { key: '2', href: '/dashboard/sales' },
    { key: '3' },
  ],
}

const CTA_HREFS: Record<Role, string> = {
  cc_manager:    '/dashboard/projects/new',
  cold_caller:   '/dashboard/upload',
  sales_rep:     '/dashboard/appointments',
  sales_manager: '/dashboard/sales',
}

/**
 * Welkomst-modal die rol-specifieke uitleg toont aan nieuwe gebruikers.
 * Wordt enkel gerenderd als profile.tutorial_completed_at IS NULL.
 *
 * Self-contained: fetcht z'n eigen profile data uit Supabase. Kan dus
 * onvoorwaardelijk in de dashboard-layout staan zonder server-side props.
 */
export default function Tutorial() {
  const t = useTranslations('components.tutorial')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [open, setOpen] = useState(false)
  const [dismissing, setDismissing] = useState(false)

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await sb.from('profiles').select('*').eq('id', user.id).single()
      const p = data as Profile | null
      if (p && p.tutorial_completed_at === null) {
        setProfile(p)
        setOpen(true)
      }
    })
  }, [])

  async function dismiss() {
    if (!profile) return
    setDismissing(true)
    const sb = createClient()
    await sb.from('profiles')
      .update({ tutorial_completed_at: new Date().toISOString() })
      .eq('id', profile.id)
    setOpen(false)
    setDismissing(false)
  }

  if (!open || !profile) return null

  const role = profile.role as Role
  const steps = TUTORIAL_STEPS[role]
  const ctaHref = CTA_HREFS[role]
  if (!steps || !ctaHref) return null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-xl sm:rounded-xl shadow-xl max-w-lg w-full p-6 relative max-h-[90vh] overflow-y-auto">
        <button
          onClick={dismiss}
          disabled={dismissing}
          className="absolute top-4 right-4 text-gray-300 hover:text-gray-600 text-xl leading-none disabled:opacity-50"
          aria-label={t('closeAria')}
        >
          &times;
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-brand-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="white" strokeWidth="1.5"/>
              <path d="M8 3v2M8 11v2M3 8h2M11 8h2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="8" cy="8" r="1.4" fill="white"/>
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 truncate">
              {t('welcome')}
            </h2>
            <p className="text-xs text-gray-500 truncate">
              {profile.full_name?.split(' ')[0]}{t('roleSeparator')}{t(`roles.${role}`)}
            </p>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-5 leading-relaxed">
          {t(`${role}.subtitle`)}
        </p>

        <div className="space-y-3 mb-6">
          {steps.map((step, i) => (
            <div key={step.key} className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-brand-50 text-brand-700 text-xs font-medium flex items-center justify-center flex-shrink-0 mt-0.5">
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 flex items-center gap-2 flex-wrap">
                  {t(`${role}.steps.${step.key}.title`)}
                  {step.href && (
                    <Link
                      href={step.href}
                      onClick={dismiss}
                      className="text-brand-600 hover:underline text-xs font-normal"
                    >
                      {t('stepOpen')}
                    </Link>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                  {t(`${role}.steps.${step.key}.desc`)}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={dismiss}
            disabled={dismissing}
            className="btn-secondary flex-1 disabled:opacity-50"
          >
            {dismissing ? t('skipping') : t('skip')}
          </button>
          <Link
            href={ctaHref}
            onClick={dismiss}
            className="btn-primary flex-1 text-center"
          >
            {t(`${role}.ctaLabel`)}
          </Link>
        </div>

        <p className="text-xs text-gray-400 text-center mt-4">
          {t('accountFootnote')}{' '}
          <Link href="/dashboard/settings/account" className="underline" onClick={dismiss}>
            {t('accountLink')}
          </Link>.
        </p>
      </div>
    </div>
  )
}
