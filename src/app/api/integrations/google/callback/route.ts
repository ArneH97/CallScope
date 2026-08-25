import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { exchangeCodeForTokens, fetchGoogleUserEmail } from '@/lib/google'

/**
 * GET /api/integrations/google/callback?code=...&state=...
 *
 * Wordt aangeroepen door Google na de autorisatie. Wisselt de code voor
 * tokens, valideert de state, en slaat de tokens op in google_integrations.
 */
export async function GET(req: NextRequest) {
  const code  = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const settingsUrl = `${baseUrl}/dashboard/settings/integrations`

  // Gebruiker drukte op "Cancel" of Google gaf een error terug
  if (error) {
    return NextResponse.redirect(`${settingsUrl}?error=${encodeURIComponent(error)}`)
  }
  if (!code || !state) {
    return NextResponse.redirect(`${settingsUrl}?error=missing_params`)
  }

  // Auth-check — current user moet match'en met de state-user-id
  const supabase = createSbClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(`${baseUrl}/auth/login?next=${encodeURIComponent(settingsUrl)}`)
  }
  if (user.id !== state) {
    return NextResponse.redirect(`${settingsUrl}?error=state_mismatch`)
  }

  // Wissel de code voor tokens
  let tokens
  try {
    tokens = await exchangeCodeForTokens(
      code,
      `${baseUrl}/api/integrations/google/callback`,
    )
  } catch (e) {
    console.error('[google/callback] token exchange:', e)
    return NextResponse.redirect(`${settingsUrl}?error=token_exchange_failed`)
  }

  if (!tokens.refresh_token) {
    // Kan gebeuren als gebruiker al eens verbonden was en niet opnieuw consent gaf.
    // We forceren prompt=consent in /start dus dit zou niet mogen gebeuren.
    return NextResponse.redirect(`${settingsUrl}?error=no_refresh_token`)
  }

  // Haal het Google-mailadres op (voor display in UI)
  const googleEmail = await fetchGoogleUserEmail(tokens.access_token)

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  // Sla op via service_role (bypasst RLS, schrijft als de target user)
  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsert: any = {
    user_id:       user.id,
    refresh_token: tokens.refresh_token,
    access_token:  tokens.access_token,
    expires_at:    expiresAt,
    google_email:  googleEmail,
    connected_at:  new Date().toISOString(),
  }
  const { error: dbErr } = await sb.from('google_integrations').upsert(upsert)

  if (dbErr) {
    console.error('[google/callback] db save failed:', dbErr)
    return NextResponse.redirect(`${settingsUrl}?error=db_save_failed`)
  }

  return NextResponse.redirect(`${settingsUrl}?success=connected`)
}
