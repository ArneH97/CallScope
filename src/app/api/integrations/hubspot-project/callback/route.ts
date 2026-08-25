import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { exchangeCodeForTokens, fetchTokenInfo } from '@/lib/hubspot'

/**
 * GET /api/integrations/hubspot-project/callback?code=...&state=...
 *
 * Callback voor de per-project OAuth-flow. Decodeert `state` (base64-JSON met
 * user_id + project_id), valideert dat de huidige sessie van die user is,
 * wisselt de code voor tokens en upsert in project_hubspot_integrations.
 */
export async function GET(req: NextRequest) {
  const code  = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin

  // Decoder eerst zodat we de juiste redirect-URL kunnen bouwen bij errors
  let parsed: { u?: string; p?: string; n?: string } = {}
  try {
    if (state) {
      const json = Buffer.from(state, 'base64url').toString('utf8')
      parsed = JSON.parse(json)
    }
  } catch {
    // state corrupt — laat parsed leeg, we vallen terug op generieke fout
  }

  const projectId = parsed.p ?? null
  const fallbackUrl  = projectId
    ? `${baseUrl}/dashboard/projects/${projectId}/settings`
    : `${baseUrl}/dashboard/projects`

  if (error) {
    return NextResponse.redirect(`${fallbackUrl}?error=hubspot_${encodeURIComponent(error)}`)
  }
  if (!code || !state || !parsed.u || !parsed.p) {
    return NextResponse.redirect(`${fallbackUrl}?error=hubspot_missing_params`)
  }

  // Auth-check + state-match
  const supabase = createSbClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.redirect(`${baseUrl}/auth/login?next=${encodeURIComponent(fallbackUrl)}`)
  }
  if (user.id !== parsed.u) {
    return NextResponse.redirect(`${fallbackUrl}?error=hubspot_state_mismatch`)
  }

  // Verify dat user nog steeds cc_manager is van het project (kan veranderd zijn
  // tussen start en callback, hoewel onwaarschijnlijk).
  const { data: ccCheck } = await supabase
    .from('project_call_centers')
    .select('project_id, call_centers!inner(manager_id)')
    .eq('project_id', parsed.p)
    .maybeSingle()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isManager = (ccCheck as any)?.call_centers?.manager_id === user.id
  if (!isManager) {
    return NextResponse.redirect(`${fallbackUrl}?error=hubspot_not_manager`)
  }

  // Code → tokens
  let tokens
  try {
    tokens = await exchangeCodeForTokens(
      code,
      `${baseUrl}/api/integrations/hubspot-project/callback`,
    )
  } catch (e) {
    console.error('[hubspot-project/callback] token exchange:', e)
    return NextResponse.redirect(`${fallbackUrl}?error=hubspot_token_exchange_failed`)
  }

  if (!tokens.refresh_token) {
    return NextResponse.redirect(`${fallbackUrl}?error=hubspot_no_refresh_token`)
  }

  // Portal-info ophalen voor display in UI
  let info: { hub_id: number; hub_domain: string | null; user: string | null } | null = null
  try {
    info = await fetchTokenInfo(tokens.access_token)
  } catch (e) {
    console.warn('[hubspot-project/callback] token-info kon niet opgehaald worden:', e)
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  // Service-role: schrijf direct in project_hubspot_integrations. RLS check
  // hierboven is al uitgevoerd, dus we kunnen veilig service-role gebruiken.
  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upsert: any = {
    project_id:           parsed.p,
    refresh_token:        tokens.refresh_token,
    access_token:         tokens.access_token,
    expires_at:           expiresAt,
    hubspot_account_id:   info?.hub_id ? String(info.hub_id) : null,
    hubspot_account_name: info?.hub_domain ?? null,
    hubspot_user_email:   info?.user ?? null,
    connected_by:         user.id,
    connected_at:         new Date().toISOString(),
  }
  const { error: dbErr } = await sb.from('project_hubspot_integrations').upsert(upsert)

  if (dbErr) {
    console.error('[hubspot-project/callback] db save failed:', dbErr)
    return NextResponse.redirect(`${fallbackUrl}?error=hubspot_db_save_failed`)
  }

  // Mark project ook in projects.hubspot_calls_synced_by zodat oude code-paden
  // (zoals oude cron-versies of bestaande exports) blijven werken tot we ze
  // allemaal overgeschakeld hebben.
  await sb.from('projects')
    .update({ hubspot_calls_synced_by: user.id })
    .eq('id', parsed.p)

  return NextResponse.redirect(`${fallbackUrl}?success=hubspot_connected`)
}
