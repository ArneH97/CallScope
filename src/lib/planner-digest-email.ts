/**
 * Dagdigest voor de afspraak-planner.
 *
 * Wordt verstuurd:
 *   1. handmatig via een knop op /dashboard/projects/[id]/planner
 *   2. automatisch elke dag om 17:00 Brussel via cron
 *
 * Per sales rep krijgt iedereen z'n eigen e-mail met alle afspraken die
 * VANDAAG voor hem in `appointment_bookings` aangemaakt zijn (filter op
 * created_at, niet scheduled_start — een afspraak die volgende week
 * doorgaat maar vandaag geboekt werd, hoort dus thuis in deze digest).
 *
 * Styling matched onboarding-emails.ts zodat alle mails er herkenbaar uitzien.
 * Verzending via Resend; bij ontbrekende RESEND_API_KEY → no-op + warn.
 */

import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.callscope.be'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Locale-aware datum + uur. NL → "wo 28 mei om 10:30", EN → "Wed 28 May at 10:30".
 */
function formatDateTime(iso: string, locale: string): string {
  const d = new Date(iso)
  const date = new Intl.DateTimeFormat(locale === 'nl' ? 'nl-BE' : 'en-GB', {
    timeZone: 'Europe/Brussels',
    weekday: 'short',
    day:     'numeric',
    month:   'short',
  }).format(d)
  const time = new Intl.DateTimeFormat(locale === 'nl' ? 'nl-BE' : 'en-GB', {
    timeZone: 'Europe/Brussels',
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  return locale === 'nl' ? `${date} om ${time}` : `${date} at ${time}`
}

function wrapBody(headline: string, content: string, footerText: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;">
        <div style="width:32px;height:32px;background:#1a35e6;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;">CS</div>
        <span style="font-size:18px;font-weight:600;">CallScope</span>
      </div>
      <h1 style="font-size:22px;font-weight:600;color:#111827;margin:0 0 8px;line-height:1.3;">${headline}</h1>
      ${content}
      <p style="font-size:12px;color:#9ca3af;margin-top:32px;border-top:1px solid #f3f4f6;padding-top:16px;">
        ${escapeHtml(footerText)}
      </p>
    </div>
  `
}

export type DigestAppointment = {
  start:         string                // ISO scheduled_start
  end:           string                // ISO scheduled_end
  businessName:  string
  address:       string | null
  notes:         string | null
  region:        string | null
  province:      string | null
  coldCallerName: string | null        // wie gebeld heeft
}

async function sendEmail(p: { to: string; subject: string; html: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[planner-digest] RESEND_API_KEY ontbreekt — mail niet verstuurd')
    return false
  }
  const from = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev'
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ from, to: [p.to], subject: p.subject, html: p.html }),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      console.error(`[planner-digest] Resend faalde ${res.status}: ${txt}`)
      return false
    }
    return true
  } catch (e) {
    console.error('[planner-digest] Resend error:', e)
    return false
  }
}

/**
 * Bouwt + verzendt de digest voor één sales rep. Returnt true bij succes.
 */
export async function sendDailyAppointmentsDigest(p: {
  to:           string
  repFirstName: string
  projectName:  string
  appointments: DigestAppointment[]
  locale?:      string
}): Promise<boolean> {
  const locale = (p.locale ?? 'nl').toLowerCase().startsWith('en') ? 'en' : 'nl'
  if (p.appointments.length === 0) return false

  const sorted = [...p.appointments].sort((a, b) => a.start.localeCompare(b.start))

  const subject = locale === 'nl'
    ? `Nieuwe afspraken voor ${p.projectName} (${p.appointments.length})`
    : `New appointments for ${p.projectName} (${p.appointments.length})`

  const headline = locale === 'nl'
    ? `Dag ${escapeHtml(p.repFirstName)}, ${p.appointments.length} ${p.appointments.length === 1 ? 'nieuwe afspraak' : 'nieuwe afspraken'} voor jou`
    : `Hi ${escapeHtml(p.repFirstName)}, ${p.appointments.length} new ${p.appointments.length === 1 ? 'appointment' : 'appointments'} for you`

  const intro = locale === 'nl'
    ? `Onze callers hebben vandaag voor jou ${p.appointments.length === 1 ? 'een afspraak' : 'afspraken'} ingepland in ${escapeHtml(p.projectName)}. Hier het overzicht:`
    : `Our callers booked ${p.appointments.length === 1 ? 'an appointment' : 'appointments'} for you today on ${escapeHtml(p.projectName)}. Here's the overview:`

  const labels = locale === 'nl'
    ? { location: 'Locatie', notes: 'Extra info', region: 'Regio', caller: 'Gebeld door' }
    : { location: 'Location', notes: 'Notes', region: 'Region', caller: 'Booked by' }

  const cards = sorted.map(a => {
    const regionPart = a.region
      ? a.region
      : a.province
        ? a.province.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : null
    return `
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:12px;">
        <div style="font-size:14px;color:#1a35e6;font-weight:600;margin-bottom:6px;">
          ${escapeHtml(formatDateTime(a.start, locale))}
        </div>
        <div style="font-size:16px;font-weight:600;color:#111827;margin-bottom:6px;">
          ${escapeHtml(a.businessName)}
        </div>
        ${a.address ? `
          <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">
            <span style="color:#9ca3af;">${labels.location}:</span> ${escapeHtml(a.address)}
          </div>
        ` : ''}
        ${regionPart ? `
          <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">
            <span style="color:#9ca3af;">${labels.region}:</span> ${escapeHtml(regionPart)}
          </div>
        ` : ''}
        ${a.coldCallerName ? `
          <div style="font-size:13px;color:#6b7280;margin-bottom:4px;">
            <span style="color:#9ca3af;">${labels.caller}:</span> ${escapeHtml(a.coldCallerName)}
          </div>
        ` : ''}
        ${a.notes ? `
          <div style="font-size:13px;color:#374151;margin-top:10px;padding:10px;background:#f9fafb;border-radius:6px;line-height:1.5;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af;margin-bottom:4px;">${labels.notes}</div>
            ${escapeHtml(a.notes).replace(/\n/g, '<br>')}
          </div>
        ` : ''}
      </div>
    `
  }).join('')

  const ctaLabel = locale === 'nl' ? 'Open je afsprakenlijst' : 'Open your appointments'
  const ctaUrl = `${APP_URL}${locale === 'nl' ? '' : `/${locale}`}/dashboard/appointments`

  const footer = locale === 'nl'
    ? 'CallScope — automatisch verstuurd na de werkdag.'
    : 'CallScope — sent automatically at end of day.'

  const content = `
    <p style="font-size:15px;line-height:1.6;color:#374151;margin:8px 0 20px;">${intro}</p>
    ${cards}
    <p style="margin:24px 0;">
      <a href="${escapeHtml(ctaUrl)}"
         style="display:inline-block;background:#1a35e6;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">
        ${escapeHtml(ctaLabel)}
      </a>
    </p>
  `

  return sendEmail({
    to:      p.to,
    subject,
    html:    wrapBody(headline, content, footer),
  })
}

// ── Shared logic voor handmatige + cron trigger ──────────────────────────────

export type DigestResult = {
  projectId:    string
  projectName:  string
  repsNotified: number
  appointments: number
  skipped:      { repId: string; reason: string }[]
}

/**
 * Stuurt voor één project de dag-digest naar alle sales reps die vandaag
 * nieuwe afspraken hebben gekregen. Gebruikt service-role omdat we onder
 * de hood emails van users moeten lezen (geen RLS).
 *
 * `referenceDate` mag een specifieke ISO-datum zijn om de "vandaag"-window
 * te overrulen (handig voor tests / re-sends). Default = nu (Brussel-tijd).
 */
export async function sendDigestForProject(
  sb: SupabaseClient,
  projectId: string,
  referenceDate: Date = new Date(),
): Promise<DigestResult> {
  // Bepaal vandaag-window in Brussel-tijd. Brussels = UTC+1 (CET) of UTC+2
  // (CEST). We berekenen de offset dynamisch via Intl, geen hardcoded shift.
  const brxOffsetMin = brusselsOffsetMinutes(referenceDate)
  const brxNow = new Date(referenceDate.getTime() + brxOffsetMin * 60_000)
  // Brussels midnight van vandaag, terugvertaald naar UTC:
  const brxMidnight = new Date(Date.UTC(
    brxNow.getUTCFullYear(),
    brxNow.getUTCMonth(),
    brxNow.getUTCDate(),
    0, 0, 0, 0,
  ))
  const startUTC = new Date(brxMidnight.getTime() - brxOffsetMin * 60_000)
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60_000)

  // 1. Bookings van vandaag voor dit project, met sales_rep_id niet NULL
  const { data: bookings, error: bErr } = await sb
    .from('appointment_bookings')
    .select('id, lead_id, sales_rep_id, cold_caller_id, scheduled_start, scheduled_end, caller_notes, status')
    .eq('project_id', projectId)
    .gte('created_at', startUTC.toISOString())
    .lt('created_at',  endUTC.toISOString())
    .not('sales_rep_id', 'is', null)
    .neq('status', 'cancelled')

  if (bErr) throw new Error(bErr.message)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (bookings ?? []) as any[]
  const { data: projRow } = await sb.from('projects').select('name').eq('id', projectId).single()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projectName = (projRow as any)?.name ?? 'Project'

  if (rows.length === 0) {
    return { projectId, projectName, repsNotified: 0, appointments: 0, skipped: [] }
  }

  // 2. Leads, sales reps, cold callers in bulk ophalen
  const leadIds   = Array.from(new Set(rows.map(r => r.lead_id)))
  const repIds    = Array.from(new Set(rows.map(r => r.sales_rep_id).filter(Boolean)))
  const callerIds = Array.from(new Set(rows.map(r => r.cold_caller_id).filter(Boolean)))

  const [leadsRes, repsRes, callersRes] = await Promise.all([
    sb.from('lead_pool')
      .select('id, business_name, address, region, province')
      .in('id', leadIds),
    sb.from('profiles')
      .select('id, full_name, email, locale')
      .in('id', repIds),
    callerIds.length > 0
      ? sb.from('profiles').select('id, full_name').in('id', callerIds)
      : Promise.resolve({ data: [] }),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leadById   = new Map<string, any>(((leadsRes.data   ?? []) as any[]).map(l => [l.id, l]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repById    = new Map<string, any>(((repsRes.data    ?? []) as any[]).map(r => [r.id, r]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callerById = new Map<string, any>(((callersRes.data ?? []) as any[]).map(c => [c.id, c]))

  // 3. Groepeer per sales rep
  const byRep = new Map<string, DigestAppointment[]>()
  for (const r of rows) {
    const lead = leadById.get(r.lead_id)
    if (!lead) continue
    const caller = r.cold_caller_id ? callerById.get(r.cold_caller_id) : null
    const item: DigestAppointment = {
      start:          r.scheduled_start,
      end:            r.scheduled_end,
      businessName:   lead.business_name ?? '—',
      address:        lead.address ?? null,
      notes:          r.caller_notes ?? null,
      region:         lead.region ?? null,
      province:       lead.province ?? null,
      coldCallerName: caller?.full_name ?? null,
    }
    const arr = byRep.get(r.sales_rep_id) ?? []
    arr.push(item)
    byRep.set(r.sales_rep_id, arr)
  }

  // 4. Mail per rep
  let notified = 0
  const skipped: { repId: string; reason: string }[] = []
  for (const [repId, items] of byRep.entries()) {
    const rep = repById.get(repId)
    if (!rep?.email) {
      skipped.push({ repId, reason: 'no_email' })
      continue
    }
    const firstName = (rep.full_name?.split(' ')[0] ?? '').trim() || (rep.email.split('@')[0] ?? 'collega')
    const ok = await sendDailyAppointmentsDigest({
      to:           rep.email,
      repFirstName: firstName,
      projectName,
      appointments: items,
      locale:       rep.locale,
    })
    if (ok) notified++
    else    skipped.push({ repId, reason: 'send_failed' })
  }

  return {
    projectId,
    projectName,
    repsNotified: notified,
    appointments: rows.length,
    skipped,
  }
}

/**
 * Brussels UTC-offset in minuten voor een gegeven moment. Hanteert DST
 * automatisch via Intl. Geen libs nodig.
 */
function brusselsOffsetMinutes(d: Date): number {
  const utc = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(),    d.getUTCMinutes(), d.getUTCSeconds(),
  ))
  const brxStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Brussels',
    year:  'numeric', month:  '2-digit', day:    '2-digit',
    hour:  '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => Number(brxStr.find(p => p.type === t)?.value ?? 0)
  const brxAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((brxAsUtc - utc.getTime()) / 60_000)
}

/** Helper voor cron: bouwt een service-role client. */
export function getServiceClient(): SupabaseClient {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}
