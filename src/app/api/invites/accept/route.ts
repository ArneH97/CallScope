import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

/**
 * POST /api/invites/accept
 * body: { token, full_name, password }
 *
 * Voltooit een invite-flow door:
 *   1. Token valideren (bestaand + niet verlopen + niet geaccepteerd)
 *   2. Auth user aanmaken via supabase.auth.admin.createUser (email_confirm=true
 *      zodat de user direct kan inloggen zonder mail-confirmatie)
 *   3. Profile aanmaken/updaten met juiste rol via complete_invite RPC
 *   4. Invite markeren als accepted
 *
 * Antwoord: { ok: true, email } zodat client kan auto-inloggen.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const token: string | undefined = body.token
    const fullName = String(body.full_name ?? '').trim()
    const password: string = body.password ?? ''

    if (!token) {
      return NextResponse.json({ error: 'Token ontbreekt' }, { status: 400 })
    }
    if (!fullName) {
      return NextResponse.json({ error: 'Volledige naam is verplicht' }, { status: 400 })
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Wachtwoord moet minstens 8 tekens lang zijn' }, { status: 400 })
    }

    const sbAdmin = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // ── Token-info ophalen + valideren ─────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: infoRows, error: infoErr } = await (sbAdmin.rpc as any)('get_invite_info', { p_token: token })
    if (infoErr) {
      return NextResponse.json({ error: `Uitnodiging ophalen mislukt: ${infoErr.message}` }, { status: 500 })
    }
    type InviteInfo = {
      project_id: string
      project_name: string
      email: string
      role: string
      invited_by_name: string | null
      expires_at: string
      expired: boolean
    }
    const info = (infoRows?.[0] ?? null) as InviteInfo | null
    if (!info) {
      return NextResponse.json({ error: 'Uitnodiging niet gevonden of al gebruikt.' }, { status: 404 })
    }
    if (info.expired) {
      return NextResponse.json({ error: 'Deze uitnodiging is verlopen. Vraag een nieuwe aan je manager.' }, { status: 400 })
    }

    // ── Auth user aanmaken ──────────────────────────────────────────────
    // email_confirm: true → user kan direct inloggen zonder bevestigingsmail.
    // De invite-link in zijn mail is al voldoende verificatie van email-eigenaarschap.
    const { data: created, error: createErr } = await sbAdmin.auth.admin.createUser({
      email:          info.email,
      password,
      email_confirm:  true,
      user_metadata:  { full_name: fullName, role: info.role },
    })

    if (createErr || !created.user) {
      // Vaak: "User already registered" — kan gebeuren als de invitee al een
      // CallScope-account had (bv. cc_manager) maar nu uitgenodigd wordt op
      // een ander project. In dat geval: vertel hem dat hij gewoon kan inloggen
      // en dan toegevoegd wordt — eigenlijk hadden we deze flow al moeten
      // afvangen in /api/invites/send (path 1: directe project_member).
      const msg = createErr?.message ?? 'Account aanmaken mislukt'
      if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('already exists')) {
        return NextResponse.json({
          error: 'Er bestaat al een account met dit e-mailadres. Log in en vraag je manager om je toegang te geven.',
        }, { status: 409 })
      }
      return NextResponse.json({ error: msg }, { status: 500 })
    }

    const userId = created.user.id

    // ── Profile zorgen + rol/leden zetten via RPC ──────────────────────
    // De auth-trigger of een eerste profile-insert door ons; we maken hem
    // expliciet aan voor zekerheid (idempotent via upsert).
    await sbAdmin.from('profiles').upsert({
      id: userId,
      full_name: fullName,
      email: info.email,
      role: info.role,
      is_freelance: false,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: completeErr } = await (sbAdmin.rpc as any)('complete_invite', {
      p_token:   token,
      p_user_id: userId,
    })
    if (completeErr) {
      console.error('[invites/accept] complete_invite error:', completeErr)
      return NextResponse.json({ error: completeErr.message }, { status: 500 })
    }

    return NextResponse.json({
      ok:       true,
      email:    info.email,
      role:     info.role,
      projectName: info.project_name,
    })
  } catch (e) {
    console.error('[invites/accept] error:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Onbekende fout' }, { status: 500 })
  }
}
