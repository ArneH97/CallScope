import { NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { sendWelcomeEmail } from '@/lib/onboarding-emails'
import type { Profile } from '@/types/database'

export const runtime = 'nodejs'

/**
 * POST /api/onboarding/send-welcome
 *
 * Stuurt de welkomstmail naar de ingelogde gebruiker — eenmalig, idempotent.
 * Wordt getriggerd vanuit de dashboard-layout op eerste mount.
 *
 * Logica:
 *   - profile.welcome_email_sent_at NULL → mail versturen + timestamp zetten
 *   - timestamp al ingevuld → niets doen (return ok=true, sent=false)
 *
 * Geen UI-feedback nodig in de frontend — dit is een fire-and-forget call
 * die in de achtergrond loopt.
 */
export async function POST() {
  try {
    const sb = createSbClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }

    // Service-role om te schrijven (bypasst RLS-policy 'profile_update_own'
    // die enkel bepaalde kolommen toelaat).
    const sbAdmin = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // Profile ophalen
    const { data: profileRow, error: pErr } = await sbAdmin
      .from('profiles')
      .select('id, full_name, email, role, locale, welcome_email_sent_at')
      .eq('id', user.id)
      .single()

    if (pErr || !profileRow) {
      return NextResponse.json({ error: 'Profiel niet gevonden' }, { status: 404 })
    }

    type ProfileLite = Pick<Profile, 'id' | 'full_name' | 'email' | 'role' | 'locale'> & {
      welcome_email_sent_at: string | null
    }
    const profile = profileRow as ProfileLite

    // Idempotent: al verzonden → return zonder iets te doen
    if (profile.welcome_email_sent_at) {
      return NextResponse.json({ ok: true, sent: false, reason: 'already_sent' })
    }
    if (!profile.email) {
      return NextResponse.json({ ok: true, sent: false, reason: 'no_email' })
    }

    const ok = await sendWelcomeEmail({
      to:       profile.email,
      fullName: profile.full_name,
      role:     profile.role,
      locale:   profile.locale,
    })

    if (!ok) {
      // Mail-verzending faalde — markeer NIET als verzonden zodat we
      // bij volgende dashboard-bezoek opnieuw proberen.
      return NextResponse.json({ ok: false, sent: false, reason: 'send_failed' }, { status: 500 })
    }

    // Markeer als verzonden
    await sbAdmin
      .from('profiles')
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq('id', user.id)

    return NextResponse.json({ ok: true, sent: true })
  } catch (e) {
    console.error('[onboarding/send-welcome] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Onbekende fout' },
      { status: 500 },
    )
  }
}
