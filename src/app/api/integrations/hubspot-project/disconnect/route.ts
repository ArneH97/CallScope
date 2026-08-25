import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

/**
 * POST /api/integrations/hubspot-project/disconnect
 * Body: { project_id: string }
 *
 * Verwijdert de HubSpot-koppeling van één specifiek project. Andere projecten
 * van dezelfde cc_manager blijven ongemoeid. Wist ook hubspot_calls_list_id
 * + hubspot_calls_synced_by op het project zodat de sync stopt.
 */
export async function POST(req: NextRequest) {
  const supabase = createSbClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const projectId: string | undefined = body.project_id
  if (!projectId) {
    return NextResponse.json({ error: 'project_id ontbreekt' }, { status: 400 })
  }

  // Auth-check: alleen cc_manager van project mag disconnecten
  const { data: ccCheck } = await supabase
    .from('project_call_centers')
    .select('project_id, call_centers!inner(manager_id)')
    .eq('project_id', projectId)
    .maybeSingle()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isManager = (ccCheck as any)?.call_centers?.manager_id === user.id
  if (!isManager) {
    return NextResponse.json({ error: 'Geen toegang' }, { status: 403 })
  }

  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // 1. Verwijder de tokens
  const { error: delErr } = await sbAdmin
    .from('project_hubspot_integrations')
    .delete()
    .eq('project_id', projectId)

  if (delErr) {
    console.error('[hubspot-project/disconnect] failed:', delErr)
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  // 2. Wis list-koppeling op het project (sync zou anders blijven proberen
  //    met een verlopen token). Behoud de list-naam optioneel — gebruiker
  //    kan ontkoppelen + opnieuw koppelen om dezelfde list terug te zetten.
  await sbAdmin.from('projects')
    .update({
      hubspot_calls_list_id:   null,
      hubspot_calls_list_name: null,
      hubspot_calls_synced_by: null,
    })
    .eq('id', projectId)

  return NextResponse.json({ ok: true })
}
