import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { getTranslations } from 'next-intl/server'

export const runtime = 'nodejs'

type Role = 'cold_caller' | 'sales_rep' | 'sales_manager'

/**
 * POST /api/invites/send
 * body: { project_id, email, role }
 *
 * Twee-paden:
 *  - Email heeft al een profile → directe project_member insert + 'added' email
 *  - Geen profile → maak invite-token, stuur 'invited' email met accept-link
 *
 * Locale-keuze voor de mail:
 *  - 'added'  → existing user's profile.locale (we kennen die)
 *  - 'invite' → inviter.locale (geen profile nog van uitgenodigde)
 *
 * Auth: cc_manager of sales_manager van het project.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const projectId: string | undefined = body.project_id
    const email = String(body.email ?? '').trim().toLowerCase()
    const role = body.role as Role | undefined

    if (!projectId || !email || !role) {
      return NextResponse.json({ error: 'project_id, email en role zijn verplicht' }, { status: 400 })
    }
    if (!['cold_caller', 'sales_rep', 'sales_manager'].includes(role)) {
      return NextResponse.json({ error: 'Ongeldige rol' }, { status: 400 })
    }
    if (!/.+@.+\..+/.test(email)) {
      return NextResponse.json({ error: 'Ongeldig e-mailadres' }, { status: 400 })
    }

    const supabase = createSbClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }

    // Inviter's profile incl. locale (voor invite-mail)
    const { data: prof } = await supabase
      .from('profiles')
      .select('id, role, full_name, email, locale')
      .eq('id', user.id)
      .single()
    type ProfileLite = {
      id: string; role: string; full_name: string | null;
      email: string | null; locale: string | null
    }
    const profile = prof as ProfileLite | null
    if (!profile) {
      return NextResponse.json({ error: 'Profiel niet gevonden' }, { status: 401 })
    }

    const sbAdmin = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    let isManager = false
    if (profile.role === 'cc_manager') {
      const { data: cc } = await sbAdmin
        .from('project_call_centers')
        .select('project_id, call_centers!inner(manager_id)')
        .eq('project_id', projectId)
        .maybeSingle()
      type CCRow = { project_id: string; call_centers: { manager_id: string } | { manager_id: string }[] | null }
      const row = cc as CCRow | null
      const ccObj = Array.isArray(row?.call_centers) ? row?.call_centers[0] : row?.call_centers
      isManager = ccObj?.manager_id === user.id
    } else if (profile.role === 'sales_manager') {
      const { data: pm } = await sbAdmin
        .from('project_members')
        .select('id')
        .eq('project_id', projectId)
        .eq('profile_id', user.id)
        .eq('role', 'sales_manager')
        .maybeSingle()
      isManager = !!pm
    }

    if (!isManager) {
      return NextResponse.json({ error: 'Geen rechten om uitnodigingen te versturen voor dit project' }, { status: 403 })
    }

    const { data: project } = await sbAdmin
      .from('projects')
      .select('id, name')
      .eq('id', projectId)
      .single()
    type ProjLite = { id: string; name: string }
    const proj = project as ProjLite | null
    if (!proj) {
      return NextResponse.json({ error: 'Project niet gevonden' }, { status: 404 })
    }

    const inviterLocale = profile.locale ?? 'nl'

    // ── Pad 1: bestaande profile → directe project_member ──────────────
    const { data: existing } = await sbAdmin
      .from('profiles')
      .select('id, full_name, locale')
      .eq('email', email)
      .maybeSingle()
    type ExistingLite = { id: string; full_name: string | null; locale: string | null }
    const existingProfile = existing as ExistingLite | null

    if (existingProfile) {
      if (role === 'cold_caller') {
        const { data: cc } = await sbAdmin
          .from('project_call_centers')
          .select('call_center_id')
          .eq('project_id', projectId)
          .maybeSingle()
        const ccId = (cc as { call_center_id: string } | null)?.call_center_id
        if (ccId) {
          await sbAdmin.from('call_center_members')
            .upsert({ call_center_id: ccId, profile_id: existingProfile.id })
        }
      }

      const { error: pmErr } = await sbAdmin.from('project_members')
        .upsert({ project_id: projectId, profile_id: existingProfile.id, role })

      if (pmErr) {
        return NextResponse.json({ error: `Toevoegen mislukt: ${pmErr.message}` }, { status: 500 })
      }

      // Stuur "you've been added" mail in de TAAL VAN DE TOEGEVOEGDE USER
      await sendAddedEmail({
        toEmail:     email,
        toName:      existingProfile.full_name ?? '',
        projectName: proj.name,
        inviterName: profile.full_name ?? '',
        role,
        locale:      existingProfile.locale ?? 'nl',
      })

      return NextResponse.json({
        ok: true,
        type: 'added',
        profile_id: existingProfile.id,
        message: `${existingProfile.full_name ?? email} toegevoegd aan ${proj.name}.`,
      })
    }

    // ── Pad 2: geen profile → invite-token aanmaken + invite-mail ─────
    const token = crypto.randomBytes(24).toString('base64url')

    await sbAdmin.from('project_invites')
      .delete()
      .eq('project_id', projectId)
      .eq('email', email)
      .is('accepted_at', null)

    const { error: insertErr } = await sbAdmin.from('project_invites').insert({
      project_id:  projectId,
      email,
      role,
      token,
      invited_by:  user.id,
    })
    if (insertErr) {
      return NextResponse.json({ error: `Uitnodiging aanmaken mislukt: ${insertErr.message}` }, { status: 500 })
    }

    // Accept-URL met inviter's locale-prefix (NL = geen prefix)
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin
    const localePrefix = inviterLocale === 'nl' ? '' : `/${inviterLocale}`
    const acceptUrl = `${baseUrl}${localePrefix}/auth/accept-invite?token=${encodeURIComponent(token)}`

    // Invite-mail: in de taal van de uitnodiger (uitgenodigde heeft nog
    // geen profile, dus kunnen niet anders kiezen)
    await sendInviteEmail({
      toEmail:     email,
      projectName: proj.name,
      inviterName: profile.full_name ?? '',
      role,
      acceptUrl,
      locale:      inviterLocale,
    })

    return NextResponse.json({
      ok: true,
      type: 'invited',
      message: `Uitnodiging verstuurd naar ${email}.`,
    })
  } catch (e) {
    console.error('[invites/send] error:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Onbekende fout' }, { status: 500 })
  }
}

async function sendInviteEmail(p: {
  toEmail:     string
  projectName: string
  inviterName: string
  role:        Role
  acceptUrl:   string
  locale:      string
}) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[invites/send] RESEND_API_KEY niet gezet — geen mail verstuurd')
    return
  }
  const from = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev'

  const t      = await getTranslations({ locale: p.locale, namespace: 'emails.invite' })
  const tWrap  = await getTranslations({ locale: p.locale, namespace: 'emails.wrapper' })

  // Fallback voor inviter-naam komt uit added-namespace want we hebben
  // dezelfde fallback nodig voor beide mails.
  const tAdded = await getTranslations({ locale: p.locale, namespace: 'emails.added' })
  const inviterName = p.inviterName.trim() || tAdded('inviterFallback')

  const roleLabel = (() => {
    try { return t(`roles.${p.role}`) } catch { return p.role }
  })()

  const headline = t('headline', { projectName: escapeHtml(p.projectName) })
  // We wikkelen role/projectName hier in <strong>, niet in de i18n-string.
  // next-intl 3.x kan HTML-tags + placeholders in dezelfde string niet
  // renderen → fallt terug op de key-naam.
  const body = t('body', {
    inviter:     escapeHtml(inviterName),
    role:        `<strong>${escapeHtml(roleLabel)}</strong>`,
    projectName: `<strong>${escapeHtml(p.projectName)}</strong>`,
  })

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #111827; max-width: 560px;padding:24px;">
      <h2 style="margin: 0 0 12px;">${headline}</h2>
      <p style="font-size: 14px; line-height: 1.5;">${body}</p>
      <p style="font-size: 14px;">${escapeHtml(t('linkPrompt'))}</p>
      <p>
        <a href="${escapeHtml(p.acceptUrl)}"
           style="display:inline-block;background:#1a35e6;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;">
          ${escapeHtml(t('ctaLabel'))}
        </a>
      </p>
      <p style="font-size: 12px; color: #6b7280;">
        ${escapeHtml(t('fallback'))} <br/>
        <a href="${escapeHtml(p.acceptUrl)}" style="color:#1a35e6;word-break:break-all;">${escapeHtml(p.acceptUrl)}</a>
      </p>
      <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">
        ${escapeHtml(t('expires'))}
      </p>
      <p style="font-size:12px;color:#9ca3af;margin-top:32px;border-top:1px solid #f3f4f6;padding-top:16px;">
        ${escapeHtml(tWrap('footer'))}
      </p>
    </div>
  `
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [p.toEmail],
      subject: t('subject', { projectName: p.projectName }),
      html,
    }),
  }).catch(err => console.error('[invites/send] resend error:', err))
}

async function sendAddedEmail(p: {
  toEmail:     string
  toName:      string
  projectName: string
  inviterName: string
  role:        Role
  locale:      string
}) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return
  const from    = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev'
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.callscope.be'

  const t     = await getTranslations({ locale: p.locale, namespace: 'emails.added' })
  const tWrap = await getTranslations({ locale: p.locale, namespace: 'emails.wrapper' })

  const inviterName = p.inviterName.trim() || t('inviterFallback')
  const firstName   = p.toName ? p.toName.split(' ')[0] : ''

  const roleLabel = (() => {
    try { return t(`roles.${p.role}`) } catch { return p.role }
  })()

  const headline = t('headline', { projectName: escapeHtml(p.projectName) })
  // NB: we wikkelen role/projectName HIER in <strong>, niet in de i18n-strings.
  // Reden: next-intl 3.x kan HTML-tags + variable placeholders in dezelfde
  // string niet renderen — dan valt 't terug op de key-naam (`emails.added.bodyWithName`).
  const roleHtml    = `<strong>${escapeHtml(roleLabel)}</strong>`
  const projectHtml = `<strong>${escapeHtml(p.projectName)}</strong>`
  const body = firstName
    ? t('bodyWithName', {
        firstName:   escapeHtml(firstName),
        inviter:     escapeHtml(inviterName),
        role:        roleHtml,
        projectName: projectHtml,
      })
    : t('bodyNoName', {
        inviter:     escapeHtml(inviterName),
        role:        roleHtml,
        projectName: projectHtml,
      })

  const localePrefix = p.locale === 'nl' ? '' : `/${p.locale}`
  const dashUrl      = `${baseUrl}${localePrefix}${t('ctaPath')}`

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #111827; max-width: 560px;padding:24px;">
      <h2 style="margin: 0 0 12px;">${headline}</h2>
      <p style="font-size: 14px; line-height: 1.5;">${body}</p>
      <p>
        <a href="${escapeHtml(dashUrl)}"
           style="display:inline-block;background:#1a35e6;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;">
          ${escapeHtml(t('ctaLabel'))}
        </a>
      </p>
      <p style="font-size:12px;color:#9ca3af;margin-top:32px;border-top:1px solid #f3f4f6;padding-top:16px;">
        ${escapeHtml(tWrap('footer'))}
      </p>
    </div>
  `
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [p.toEmail],
      subject: t('subject', { projectName: p.projectName }),
      html,
    }),
  }).catch(err => console.error('[invites/send] resend error:', err))
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
