import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const MAX_FILES = 5
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 // 10MB
const ALLOWED_MIME_PREFIXES = ['image/']

/**
 * POST /api/help/submit
 *
 * Multipart/form-data:
 *   - subject     (string, optional)
 *   - message     (string, required)
 *   - page_url    (string, optional)
 *   - user_agent  (string, optional)
 *   - files       (file[], optional, max 5, total <10MB, image/* only)
 *
 * Verstuurt mail via Resend HTTP API naar HELP_EMAIL_TO (default arne@halcoservices.be).
 * Inclusief user-context: email, naam, rol, IP, page-URL, browser.
 */
export async function POST(req: NextRequest) {
  try {
    // ── User context ──────────────────────────────────────────────────────
    const supabase = createSbClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }

    const { data: prof } = await supabase
      .from('profiles')
      .select('full_name, email, role')
      .eq('id', user.id)
      .single()
    type ProfLite = { full_name: string | null; email: string | null; role: string }
    const profile = (prof as ProfLite | null) ?? { full_name: null, email: user.email ?? null, role: 'unknown' }

    // ── Form data parsen ──────────────────────────────────────────────────
    const formData = await req.formData()
    const subject   = String(formData.get('subject') ?? '').trim()
    const message   = String(formData.get('message') ?? '').trim()
    const pageUrl   = String(formData.get('page_url') ?? '')
    const userAgent = String(formData.get('user_agent') ?? '')

    if (!message) {
      return NextResponse.json({ error: 'Beschrijving is verplicht.' }, { status: 400 })
    }

    // Files extraheren — er kunnen meerdere zijn met dezelfde key 'files'
    const rawFiles = formData.getAll('files') as File[]
    const files = rawFiles.filter((f): f is File => f instanceof File && f.size > 0)

    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Maximaal ${MAX_FILES} bestanden.` }, { status: 400 })
    }
    let totalBytes = 0
    for (const f of files) {
      if (!ALLOWED_MIME_PREFIXES.some(p => f.type.startsWith(p))) {
        return NextResponse.json({ error: `Bestandstype niet toegelaten: ${f.name}` }, { status: 400 })
      }
      totalBytes += f.size
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: 'Totaal bestandsformaat te groot (max 10MB).' }, { status: 400 })
    }

    // Files naar base64 voor Resend attachments
    const attachments = await Promise.all(files.map(async f => {
      const buffer = Buffer.from(await f.arrayBuffer())
      return { filename: f.name, content: buffer.toString('base64') }
    }))

    // ── Email opbouwen ────────────────────────────────────────────────────
    const resendKey = process.env.RESEND_API_KEY
    const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev'
    const toEmail   = process.env.HELP_EMAIL_TO     ?? 'arne@halcoservices.be'

    if (!resendKey) {
      console.error('[help/submit] RESEND_API_KEY niet geconfigureerd')
      return NextResponse.json({ error: 'E-mail-service niet beschikbaar — contacteer support direct.' }, { status: 500 })
    }

    const subjectLine = subject
      ? `[CallScope hulp] ${subject}`
      : `[CallScope hulp] Vraag van ${profile.full_name ?? profile.email ?? 'gebruiker'}`

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #111827; max-width: 640px;">
        <h2 style="margin: 0 0 16px; font-size: 18px;">Nieuwe support-vraag uit CallScope</h2>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px;">
          <tr>
            <td style="padding: 6px 0; color: #6b7280; width: 100px;">Van</td>
            <td style="padding: 6px 0; color: #111827;">${escapeHtml(profile.full_name ?? '—')} &lt;${escapeHtml(profile.email ?? '—')}&gt;</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #6b7280;">Rol</td>
            <td style="padding: 6px 0; color: #111827;">${escapeHtml(profile.role)}</td>
          </tr>
          ${pageUrl ? `
          <tr>
            <td style="padding: 6px 0; color: #6b7280; vertical-align: top;">Pagina</td>
            <td style="padding: 6px 0;"><a href="${escapeHtml(pageUrl)}" style="color: #1a35e6; word-break: break-all;">${escapeHtml(pageUrl)}</a></td>
          </tr>` : ''}
          ${userAgent ? `
          <tr>
            <td style="padding: 6px 0; color: #6b7280; vertical-align: top;">Browser</td>
            <td style="padding: 6px 0; color: #6b7280; font-size: 11px;">${escapeHtml(userAgent)}</td>
          </tr>` : ''}
          ${attachments.length > 0 ? `
          <tr>
            <td style="padding: 6px 0; color: #6b7280;">Bijlages</td>
            <td style="padding: 6px 0; color: #111827;">${attachments.length} screenshot${attachments.length === 1 ? '' : 's'}</td>
          </tr>` : ''}
        </table>

        <div style="background: #f9fafb; border-left: 3px solid #1a35e6; padding: 12px 16px; border-radius: 4px;">
          <div style="font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Bericht</div>
          <div style="white-space: pre-wrap; font-size: 14px; line-height: 1.5;">${escapeHtml(message)}</div>
        </div>

        <p style="margin: 24px 0 0; font-size: 12px; color: #9ca3af;">
          Antwoord direct op deze e-mail om de gebruiker te bereiken (reply-to is ingesteld op hun adres).
        </p>
      </div>
    `

    // ── Resend API call ───────────────────────────────────────────────────
    const resendBody: {
      from: string
      to: string[]
      subject: string
      html: string
      reply_to?: string
      attachments?: { filename: string; content: string }[]
    } = {
      from:    fromEmail,
      to:      [toEmail],
      subject: subjectLine,
      html,
    }
    if (profile.email) resendBody.reply_to = profile.email
    if (attachments.length > 0) resendBody.attachments = attachments

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(resendBody),
    })

    if (!resendResp.ok) {
      const errText = await resendResp.text().catch(() => '')
      console.error('[help/submit] Resend error:', resendResp.status, errText)
      return NextResponse.json({ error: 'E-mail kon niet verzonden worden.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[help/submit] error:', e)
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
