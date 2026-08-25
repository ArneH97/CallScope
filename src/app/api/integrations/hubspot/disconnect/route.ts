import { NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

/**
 * POST /api/integrations/hubspot/disconnect
 *
 * Verwijdert de HubSpot-integratie van de ingelogde user. Niet via DELETE
 * route omdat NextResponse forms makkelijker met POST werken vanuit een UI-knop.
 *
 * NB: we revoken het token niet expliciet bij HubSpot's kant — dat hoeft niet
 * voor security (we gooien gewoon onze tokens weg). Als de user de connectie
 * écht wil intrekken in HubSpot kan dat via Settings → Integrations → Connected Apps.
 */
export async function POST() {
  const supabase = createSbClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { error } = await sbAdmin
    .from('hubspot_integrations')
    .delete()
    .eq('user_id', user.id)

  if (error) {
    console.error('[hubspot/disconnect] failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
