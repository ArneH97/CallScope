import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { randomBytes } from 'crypto'
import { parseReportPeriod } from '@/lib/report-period'

/**
 * POST /api/projects/[id]/share
 *
 * Body: { to: string, clientName?: string, message?: string }
 *
 * 1. Auth-check: huidige user moet manager zijn van een call_center dat aan
 *    dit project gekoppeld is (RLS dwingt dit ook af).
 * 2. Genereert een random token + insert in report_shares.
 * 3. Stuurt e-mail naar klant via Resend HTTP API.
 *
 * Vereist env-vars:
 *   - RESEND_API_KEY        — van https://resend.com/api-keys
 *   - RESEND_FROM_EMAIL     — bv. "rapporten@jouw-domein.be" (geverifieerd)
 *                             óf "onboarding@resend.dev" (test, alleen naar
 *                             je eigen account-mailadres)
 *   - NEXT_PUBLIC_APP_URL   — basis-URL waar /r/[token] op draait
 *                             (bv. https://callreport.app of http://localhost:3000)
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const projectId = params.id
  const body = await request.json().catch(() => ({}))
  const to: string = String(body.to ?? '').trim().toLowerCase()
  const clientName: string | null = body.clientName ? String(body.clientName).trim() : null
  const message: string | null = body.message ? String(body.message).trim() : null
  // Period uit body — week of month. Default = month. Wordt in de share-URL
  // gecodeerd zodat de klant exact dezelfde filter ziet als de afzender.
  const period = parseReportPeriod(body.period)

  if (!to.includes('@')) {
    return NextResponse.json({ error: 'Geef een geldig e-mailadres in.' }, { status: 400 })
  }

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  // Project-naam ophalen voor de e-mail
  const { data: projectData } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single()
  const project = projectData as { id: string; name: string } | null

  if (!project) {
    return NextResponse.json({ error: 'Project niet gevonden' }, { status: 404 })
  }

  // Token genereren — 32 hex chars = 128 bits randomness
  const token = randomBytes(16).toString('hex')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shareInsert: any = {
    project_id: projectId,
    token,
    created_by: user.id,
    sent_to: to,
    client_name: clientName,
    message,
  }
  const { data: share, error: insertError } = await supabase
    .from('report_shares')
    .insert(shareInsert)
    .select()
    .single()

  if (insertError || !share) {
    console.error('[share] insert failed:', insertError)
    return NextResponse.json(
      { error: insertError?.message ?? 'Kon de share niet aanmaken (RLS?)' },
      { status: 500 },
    )
  }

  // Manager-naam voor de e-mail signature
  const { data: managerData } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', user.id)
    .single()
  const manager = managerData as { full_name: string | null; email: string | null } | null

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  // Periode in querystring meegeven zodat /r/[token] hetzelfde rapport rendert
  // als wat de manager zag bij verzenden. 'month' is default → laten we
  // weg uit de URL voor properheid.
  const periodQs = period === 'month' ? '' : `?period=${period}`
  const shareUrl = `${baseUrl}/r/${token}${periodQs}`

  // ── E-mail versturen via Resend ─────────────────────────────────────────
  const resendKey = process.env.RESEND_API_KEY
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev'

  if (!resendKey) {
    console.warn('[share] RESEND_API_KEY niet gezet — share is aangemaakt maar e-mail niet verstuurd')
    return NextResponse.json({
      ok: true,
      shareUrl,
      emailSent: false,
      warning: 'RESEND_API_KEY ontbreekt in env. De share-link is aangemaakt maar er is geen e-mail verstuurd.',
    })
  }

  const greeting = clientName ? `Beste ${clientName},` : 'Beste,'
  const senderName = manager?.full_name ?? 'CallScope'
  const userMessage = message ?? `In bijlage het rapport van het project "${project.name}".`

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#374151">
      <p>${greeting}</p>
      <p>${userMessage.replace(/\n/g, '<br>')}</p>
      <p style="margin:32px 0">
        <a href="${shareUrl}"
           style="display:inline-block;padding:12px 20px;background:#2d4fff;color:white;text-decoration:none;border-radius:8px;font-weight:500">
          Bekijk rapport →
        </a>
      </p>
      <p style="font-size:13px;color:#6b7280">
        Of kopieer deze link in je browser:<br>
        <a href="${shareUrl}" style="color:#2d4fff">${shareUrl}</a>
      </p>
      <p style="font-size:13px;color:#6b7280;margin-top:24px">
        Met vriendelijke groet,<br>
        ${senderName}
      </p>
      <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">
      <p style="font-size:11px;color:#9ca3af">
        Rapport van het project &quot;${project.name}&quot; · Gegenereerd via CallScope.
      </p>
    </div>
  `

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${senderName} <${fromEmail}>`,
      to: [to],
      subject: `Rapport: ${project.name}`,
      html,
      reply_to: manager?.email ?? undefined,
    }),
  })

  if (!resendResp.ok) {
    const errBody = await resendResp.text().catch(() => '')
    console.error('[share] Resend failed:', resendResp.status, errBody)
    return NextResponse.json({
      ok: true,
      shareUrl,
      emailSent: false,
      warning: `E-mail kon niet verstuurd worden via Resend (${resendResp.status}). De share-link is wel aangemaakt: ${shareUrl}`,
    })
  }

  return NextResponse.json({ ok: true, shareUrl, emailSent: true })
}
