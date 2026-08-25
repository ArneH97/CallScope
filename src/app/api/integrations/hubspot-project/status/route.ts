import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * GET /api/integrations/hubspot-project/status?project_id=...
 *
 * Retourneert de status van de HubSpot-koppeling voor één project:
 *   - connected:        boolean
 *   - account_name:     HubSpot portal display-naam (bv. "halco-account")
 *   - account_id:       hub_id als string
 *   - user_email:       email van de HubSpot user die geautoriseerd heeft
 *   - connected_at:     ISO timestamp
 *
 * Gebruikt door de project-settings UI om de juiste card te tonen (Verbind
 * vs. Verbonden + Ontkoppel).
 */
export async function GET(req: NextRequest) {
  const supabase = createSbClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) {
    return NextResponse.json({ error: 'project_id ontbreekt' }, { status: 400 })
  }

  // RLS doet het werk hier: SELECT lukt alleen als de huidige user
  // cc_manager is van het project.
  const { data, error } = await supabase
    .from('project_hubspot_integrations')
    .select('hubspot_account_id, hubspot_account_name, hubspot_user_email, connected_at')
    .eq('project_id', projectId)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!data) {
    return NextResponse.json({ connected: false })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any
  return NextResponse.json({
    connected:    true,
    account_id:   row.hubspot_account_id  ?? null,
    account_name: row.hubspot_account_name ?? null,
    user_email:   row.hubspot_user_email  ?? null,
    connected_at: row.connected_at        ?? null,
  })
}
