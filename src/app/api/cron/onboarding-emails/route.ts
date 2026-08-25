import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { sendTipEmail, sendTrialReminderEmail } from '@/lib/onboarding-emails'
import type { Role } from '@/types/database'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/cron/onboarding-emails
 *
 * Dagelijkse cron (vercel.json). Twee taken:
 *
 *   1. Tip-mail (dag 3): users die 3-4 dagen geleden geregistreerd zijn en
 *      nog geen tip_email_sent_at hebben → tip-mail versturen + timestamp.
 *
 *   2. Trial-reminder (≈ dag 11): cc_managers met een project waarvan
 *      trial_ends_at over 2-4 dagen verloopt, subscription_status='trialing',
 *      en trial_reminder_sent_at NULL → reminder + timestamp op project.
 *
 * Beveiligd via Bearer-token = CRON_SECRET (Vercel Cron stuurt die mee).
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET niet geconfigureerd' }, { status: 500 })
  }
  const authHeader = req.headers.get('authorization') ?? ''
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // ── 1. TIP-MAIL (dag 3) ─────────────────────────────────────────────────
  // Window: 3-4 dagen geleden geregistreerd. Iets ruimer dan exact 3 dagen
  // zodat we niet stuk gaan als de cron een dag mist door een outage.
  const now = Date.now()
  const tipFrom = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString()
  const tipTo   = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString()

  type ProfileLite = {
    id:                 string
    email:              string | null
    full_name:          string | null
    role:               Role
    locale:             string | null
    tip_email_sent_at:  string | null
  }

  const { data: tipCandidates, error: tipErr } = await sb
    .from('profiles')
    .select('id, email, full_name, role, locale, tip_email_sent_at')
    .gte('created_at', tipFrom)
    .lte('created_at', tipTo)
    .is('tip_email_sent_at', null)
    .returns<ProfileLite[]>()

  if (tipErr) {
    console.error('[onboarding-cron] tip query faalde:', tipErr)
  }

  let tipsSent = 0
  for (const p of tipCandidates ?? []) {
    if (!p.email) continue
    const ok = await sendTipEmail({
      to:       p.email,
      fullName: p.full_name,
      role:     p.role,
      locale:   p.locale ?? 'nl',
    })
    if (ok) {
      await sb.from('profiles')
        .update({ tip_email_sent_at: new Date().toISOString() })
        .eq('id', p.id)
      tipsSent++
    }
  }

  // ── 2. TRIAL-REMINDER (≈ dag 11) ────────────────────────────────────────
  // Window: trial_ends_at over 2-4 dagen vanaf nu. Geeft 3 kansen om de
  // reminder te sturen als de cron eens overslaat.
  const reminderFrom = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString()
  const reminderTo   = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString()

  type ProjLite = {
    id:                       string
    name:                     string
    trial_ends_at:            string | null
    subscription_status:      string
    trial_reminder_sent_at:   string | null
  }

  const { data: trialProjects, error: tpErr } = await sb
    .from('projects')
    .select('id, name, trial_ends_at, subscription_status, trial_reminder_sent_at')
    .eq('subscription_status', 'trialing')
    .gte('trial_ends_at', reminderFrom)
    .lte('trial_ends_at', reminderTo)
    .is('trial_reminder_sent_at', null)
    .returns<ProjLite[]>()

  if (tpErr) {
    console.error('[onboarding-cron] trial-reminder query faalde:', tpErr)
  }

  let remindersSent = 0
  for (const proj of trialProjects ?? []) {
    if (!proj.trial_ends_at) continue

    // Wie is de cc_manager van dit project? Via call_centers.manager_id.
    const { data: ccLink } = await sb
      .from('project_call_centers')
      .select('call_centers!inner(manager_id)')
      .eq('project_id', proj.id)
      .maybeSingle()
    type CCRow = { call_centers: { manager_id: string } | { manager_id: string }[] | null }
    const link = ccLink as CCRow | null
    const cc = Array.isArray(link?.call_centers) ? link?.call_centers[0] : link?.call_centers
    const managerId = cc?.manager_id
    if (!managerId) continue

    const { data: managerProfile } = await sb
      .from('profiles')
      .select('email, full_name, locale')
      .eq('id', managerId)
      .maybeSingle()
    type MProfile = { email: string | null; full_name: string | null; locale: string | null }
    const m = managerProfile as MProfile | null
    if (!m?.email) continue

    const ok = await sendTrialReminderEmail({
      to:           m.email,
      fullName:     m.full_name,
      projectName:  proj.name,
      trialEndsAt:  proj.trial_ends_at,
      locale:       m.locale ?? 'nl',
    })
    if (ok) {
      await sb.from('projects')
        .update({ trial_reminder_sent_at: new Date().toISOString() })
        .eq('id', proj.id)
      remindersSent++
    }
  }

  return NextResponse.json({
    ok:                true,
    tip_candidates:    (tipCandidates ?? []).length,
    tips_sent:         tipsSent,
    trial_candidates:  (trialProjects ?? []).length,
    reminders_sent:    remindersSent,
  })
}
