import { NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

/**
 * POST /api/integrations/lemlist/disconnect
 *
 * Verwijdert de API-key van de ingelogde user. Projecten met een gekoppelde
 * Lemlist-campaign blijven bestaan maar hun sync zal falen tot een nieuwe
 * key wordt ingegeven.
 */
export async function POST() {
  const sb = createSbClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { error } = await sbAdmin
    .from('lemlist_integrations')
    .delete()
    .eq('user_id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
