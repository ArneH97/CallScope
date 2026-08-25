import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'

/**
 * GET /api/integrations/hubspot-project/start?project_id=...
 *
 * Start de HubSpot OAuth-flow voor een SPECIFIEK PROJECT. Anders dan de
 * user-level /hubspot/start, koppelt deze route de tokens straks aan een
 * project_id (project_hubspot_integrations). Zo kan een cc_manager voor elk
 * van zijn projecten een ander HubSpot-portaal gebruiken.
 *
 * `state` = base64(JSON) met { u: user_id, p: project_id, n: nonce } zodat
 * de callback weet bij welk project de tokens horen, én CSRF kan valideren.
 */
export async function GET(req: NextRequest) {
  const supabase = createSbClient()
  const { data: { user } } = await supabase.auth.getUser()

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin

  if (!user) {
    return NextResponse.redirect(new URL('/auth/login', baseUrl))
  }

  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) {
    return NextResponse.redirect(`${baseUrl}/dashboard/projects?error=hubspot_missing_project`)
  }

  // Auth-check: alleen de cc_manager van het project mag de koppeling maken.
  // De RLS zou dit ook afdwingen bij de upsert in callback, maar we verifiëren
  // hier al zodat we de user niet door de hele OAuth-flow sturen om uiteindelijk
  // op een db-error te eindigen.
  const { data: ccCheck } = await supabase
    .from('project_call_centers')
    .select('project_id, call_centers!inner(manager_id)')
    .eq('project_id', projectId)
    .maybeSingle()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isManager = (ccCheck as any)?.call_centers?.manager_id === user.id
  if (!isManager) {
    return NextResponse.redirect(
      `${baseUrl}/dashboard/projects/${projectId}/settings?error=hubspot_not_manager`,
    )
  }

  // State: base64-url van JSON. Korter dan een UUID-list en self-contained.
  const nonce = crypto.randomUUID()
  const stateObj = { u: user.id, p: projectId, n: nonce }
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url')

  // Scopes — alleen-lezen.
  //   - contacts/deals.read   → leads + deals ophalen
  //   - schemas.*.read        → pipeline/stage labels resolven
  //   - crm.lists.read        → contact-lists ophalen (Sales Pro+ feature,
  //                              dev test-accounts hebben dit automatisch)
  //   - oauth                 → token refresh
  //
  // NB: `crm.objects.calls.read` bestaat NIET als publieke scope (enkel voor
  // "Calling Extension"-apps). Custom call-dispositions worden via een
  // fallback in lib/hubspot.ts opgehaald die met de bestaande scopes werkt.
  const scopes = [
    'crm.objects.contacts.read',
    'crm.objects.deals.read',
    'crm.schemas.contacts.read',
    'crm.schemas.deals.read',
    'crm.lists.read',
    'oauth',
  ]

  const params = new URLSearchParams({
    client_id:    process.env.HUBSPOT_CLIENT_ID!,
    redirect_uri: `${baseUrl}/api/integrations/hubspot-project/callback`,
    scope:        scopes.join(' '),
    state,
  })

  const authUrl = `https://app.hubspot.com/oauth/authorize?${params.toString()}`
  return NextResponse.redirect(authUrl)
}
