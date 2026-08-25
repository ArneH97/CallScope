import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { exchangeCodeForTokens, fetchTokenInfo } from '@/lib/hubspot'

/**
 * GET /api/integrations/hubspot/callback?code=...&state=...
 *
 * Wordt aangeroepen door HubSpot na de autorisatie. Wisselt de code voor
 * tokens, valideert de state, haalt portal-info op, en upsert in
 * hubspot_integrations.
 */
export async function GET(req: NextRequest) {
  const code  = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  const baseUrl     = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const settingsUrl = `${baseUrl}/dashboard/settings/integrations`

  if (error) {
    return NextResponse.redirect(`${settingsUrl}?error=hubspot_${encodeURIComponent(error)}`)
  }
  if (!code || !state) {
    return NextResponse.redirect(`${settingsUrl}?error=hubspot_missing_params`)
  }

  // Auth-check + state-match
  const supabase = createSbClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(`${baseUrl}/auth/login?next=${encodeURIComponent(settingsUrl)}`)
  }
  if (user.id !== state) {
    return NextResponse.redirect(`${settingsUrl}?error=hubspot_state_mismatch`)
  }

  // Code → tokens
  let tokens
  try {
    tokens = await exchangeCodeForTokens(
      code,
      `${baseUrl}/api/integrations/hubspot/callback`,
    )
  } catch (e) {
    console.error('[hubspot/callback] token exchange:', e)
    return NextResponse.redirect(`${settingsUrl}?error=hubspot_token_exchange_failed`)
  }

  if (!tokens.refresh_token) {
    return NextResponse.redirect(`${settingsUrl}?error=hubspot_no_refresh_token`)
  }

  // Portal-info ophalen voor display in UI
  let info: { hub_id: number; hub_domain: string | null; user: string | null } | null = null
  try {
    info = await fetchTokenInfo(tokens.access_token)
  } catch (e) {
    console.warn('[hubspot/callback] token-info kon niet opgehaald worden:', e)
    // Niet-fataal; we kunnen zonder maar verliezen de display-naam
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  // Service role schrijft als de target user (bypass RLS)
  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsert: any = {
    user_id:              user.id,
    refresh_token:        tokens.refresh_token,
    access_token:         tokens.access_token,
    expires_at:           expiresAt,
    hubspot_account_id:   info?.hub_id ? String(info.hub_id) : null,
    hubspot_account_name: info?.hub_domain ?? null,
    hubspot_user_email:   info?.user ?? null,
    connected_at:         new Date().toISOString(),
  }
  const { error: dbErr } = await sb.from('hubspot_integrations').upsert(upsert)

  if (dbErr) {
    console.error('[hubspot/callback] db save failed:', dbErr)
    return NextResponse.redirect(`${settingsUrl}?error=hubspot_db_save_failed`)
  }

  return NextResponse.redirect(`${settingsUrl}?success=hubspot_connected`)
}
