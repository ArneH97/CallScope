import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getTranslations } from 'next-intl/server'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/cron/weekly-hour-confirmation
 *
 * Vrijdag 17:00 UTC. Voor elke cc_manager die op minstens één project een
 * tarief/preset heeft ingesteld (= project_caller_rates met niet-NULL waardes),
 * stuurt deze cron een mail met een link per project naar de confirm-hours
 * pagina voor de huidige week.
 *
 * Beveiligd via CRON_SECRET bearer.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET niet geconfigureerd' }, { status: 500 })
  }
  if ((req.headers.get('authorization') ?? '') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Bereken maandag van deze week (ISO)
  const today = new Date()
  const day   = today.getUTCDay()                 // 0=Sun, 1=Mon, ...
  const offset = day === 0 ? -6 : 1 - day
  const monday = new Date(today)
  monday.setUTCDate(today.getUTCDate() + offset)
  const weekStart = monday.toISOString().slice(0, 10)

  // Pak alle projecten waar minstens één caller een rate of preset heeft
  const { data: rateRows, error: rErr } = await sb
    .from('project_caller_rates')
    .select('project_id, weekly_hours_preset, hourly_rate')
    .or('weekly_hours_preset.not.is.null,hourly_rate.not.is.null')

  if (rErr) {
    return NextResponse.json({ error: rErr.message }, { status: 500 })
  }
  type RateRow = { project_id: string; weekly_hours_preset: number | null; hourly_rate: number | null }
  const projectsWithRates = Array.from(new Set(((rateRows ?? []) as RateRow[]).map(r => r.project_id)))

  if (projectsWithRates.length === 0) {
    return NextResponse.json({ ok: true, message: 'Geen projecten met tarieven.', count: 0 })
  }

  // Per project → cc_manager + project-naam ophalen
  const { data: pccRows } = await sb
    .from('project_call_centers')
    .select('project_id, projects!inner(name), call_centers!inner(manager_id)')
    .in('project_id', projectsWithRates)

  type PCC = {
    project_id:   string
    projects:     { name: string } | { name: string }[] | null
    call_centers: { manager_id: string } | { manager_id: string }[] | null
  }

  // Groepeer projecten per cc_manager → één mail per manager met meerdere project-links
  const byManager = new Map<string, { projectId: string; projectName: string }[]>()
  for (const r of (pccRows ?? []) as PCC[]) {
    const proj = Array.isArray(r.projects) ? r.projects[0] : r.projects
    const cc   = Array.isArray(r.call_centers) ? r.call_centers[0] : r.call_centers
    if (!cc?.manager_id || !proj?.name) continue
    const list = byManager.get(cc.manager_id) ?? []
    list.push({ projectId: r.project_id, projectName: proj.name })
    byManager.set(cc.manager_id, list)
  }

  // Manager-profielen voor email-adressen + locale
  const managerIds = Array.from(byManager.keys())
  const { data: profs } = await sb
    .from('profiles')
    .select('id, email, full_name, locale')
    .in('id', managerIds)
  type Prof = {
    id: string; email: string | null; full_name: string | null; locale: string | null
  }
  const profMap = new Map((profs ?? []).map(p => [(p as Prof).id, p as Prof]))

  // Mails versturen
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin
  const apiKey = process.env.RESEND_API_KEY
  const from   = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev'

  if (!apiKey) {
    return NextResponse.json({
      ok:    false,
      sent:  0,
      error: 'RESEND_API_KEY niet geconfigureerd — geen mails verstuurd.',
    }, { status: 500 })
  }

  let sent = 0, failed = 0
  for (const [managerId, projects] of byManager.entries()) {
    const m = profMap.get(managerId)
    if (!m?.email) { failed++; continue }

    const locale = m.locale ?? 'nl'
    const t      = await getTranslations({ locale, namespace: 'emails.weeklyHours' })

    const firstName = (m.full_name?.split(' ')[0] ?? '').trim() || t('firstNameFallback')
    const localePrefix = locale === 'nl' ? '' : `/${locale}`

    const projectsHtml = projects.map(p => `
      <li style="margin-bottom:8px;">
        <a href="${baseUrl}${localePrefix}/dashboard/projects/${p.projectId}/confirm-hours?week=${weekStart}"
           style="color:#1a35e6;text-decoration:none;">
          ${escapeHtml(p.projectName)} →
        </a>
      </li>
    `).join('')

    const subject = projects.length === 1
      ? t('subjectSingle')
      : t('subjectPlural', { count: projects.length })

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;">
          <div style="width:32px;height:32px;background:#1a35e6;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;">CS</div>
          <span style="font-size:18px;font-weight:600;">CallScope</span>
        </div>
        <h1 style="font-size:20px;font-weight:600;color:#111827;margin:0 0 12px;">
          ${escapeHtml(t('headline', { firstName }))}
        </h1>
        <p style="font-size:14px;line-height:1.6;color:#374151;">
          ${escapeHtml(t('intro'))}
        </p>
        <ul style="list-style:none;padding:0;margin:20px 0;font-size:15px;">
          ${projectsHtml}
        </ul>
        <p style="font-size:13px;color:#6b7280;line-height:1.6;">
          ${escapeHtml(t('outro'))}
        </p>
        <p style="font-size:12px;color:#9ca3af;margin-top:24px;border-top:1px solid #f3f4f6;padding-top:14px;">
          ${escapeHtml(t('unsubscribe'))}
        </p>
      </div>
    `

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [m.email], subject, html }),
      })
      if (res.ok) sent++
      else { failed++; console.warn(`[hour-cron] mail naar ${m.email} faalde:`, res.status) }
    } catch (e) {
      failed++
      console.error('[hour-cron] resend error:', e)
    }
  }

  return NextResponse.json({
    ok:        true,
    week:      weekStart,
    managers:  byManager.size,
    sent,
    failed,
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
