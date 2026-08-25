import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/integrations/hubspot/start
 *
 * Start de HubSpot OAuth-flow: redirect naar HubSpot's autorisatie-pagina.
 * `state` bevat de user-id voor CSRF-validatie in de callback.
 *
 * Bedoeld voor sales_managers — koppelt hun HubSpot-portaal aan hun CallScope-
 * profiel zodat dagelijkse cron de dealstages kan binnenhalen voor afspraken
 * op alle projecten waar deze sales_manager lid is.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  if (!user) {
    return NextResponse.redirect(new URL('/auth/login', baseUrl))
  }

  // Scopes — alleen-lezen. Eén HubSpot-koppeling dekt zowel sales_manager
  // (deal-stages) als cc_manager (calls + lists). Voor calls gebruiken we de
  // legacy v1 engagements-API en de v1 contacts-lists API — beide werken met
  // alleen `crm.objects.contacts.read`, dus geen extra scopes nodig.
  // `oauth` wordt automatisch toegevoegd door HubSpot.
  const scopes = [
    'crm.objects.contacts.read',
    'crm.objects.deals.read',
    'crm.schemas.contacts.read',
    'crm.schemas.deals.read',
    'oauth',
  ]

  const params = new URLSearchParams({
    client_id:    process.env.HUBSPOT_CLIENT_ID!,
    redirect_uri: `${baseUrl}/api/integrations/hubspot/callback`,
    scope:        scopes.join(' '),
    state:        user.id,
  })

  const authUrl = `https://app.hubspot.com/oauth/authorize?${params.toString()}`
  return NextResponse.redirect(authUrl)
}
