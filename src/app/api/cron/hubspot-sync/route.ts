import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runSyncForUser, runDealstageSyncForProject } from '@/app/api/integrations/hubspot/sync/route'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * GET /api/cron/hubspot-sync
 *
 * Dagelijkse cron — synct dealstages uit HubSpot via twee paden:
 *   1. PROJECT-pad — projecten met project_hubspot_integrations
 *      (per-project HubSpot, primair voor cc_managers met meerdere klanten).
 *   2. USER-pad — sales_managers met user-level hubspot_integrations
 *      (legacy / klassieke sales_manager-flow).
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET niet geconfigureerd' }, { status: 500 })
  }
  const authHeader = req.headers.get('authorization') ?? ''
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const baseUrl = req.nextUrl.origin

  // Pad 1: per-project dealstage-sync
  const { data: phiRows, error: phiErr } = await sb
    .from('project_hubspot_integrations')
    .select('project_id')
  if (phiErr) {
    console.warn('[cron/hubspot-sync] project-integraties ophalen mislukt:', phiErr.message)
  }
  type PHI = { project_id: string }
  const projectIds = ((phiRows ?? []) as PHI[]).map(r => r.project_id)

  const projectResults: { project_id: string; ok: boolean; synced?: number; error?: string }[] = []
  for (const projectId of projectIds) {
    try {
      const res = await runDealstageSyncForProject(projectId, false, baseUrl)
      const data = await res.json() as { ok?: boolean; synced?: number; error?: string }
      projectResults.push({ project_id: projectId, ok: !!data.ok, synced: data.synced, error: data.error })
    } catch (e) {
      projectResults.push({ project_id: projectId, ok: false, error: e instanceof Error ? e.message : 'Onbekende fout' })
    }
  }

  // Pad 2: per-user dealstage-sync (legacy)
  const { data: integrations, error: intErr } = await sb
    .from('hubspot_integrations')
    .select('user_id, hubspot_account_name')
  if (intErr) {
    console.warn('[cron/hubspot-sync] user-integraties ophalen mislukt:', intErr.message)
  }

  type IntLite = { user_id: string; hubspot_account_name: string | null }
  const rows = (integrations ?? []) as IntLite[]

  const userResults: { user_id: string; ok: boolean; synced?: number; error?: string }[] = []
  for (const r of rows) {
    try {
      const res = await runSyncForUser(r.user_id, undefined, false, baseUrl)
      const data = await res.json() as { ok?: boolean; synced?: number; error?: string }
      userResults.push({ user_id: r.user_id, ok: !!data.ok, synced: data.synced, error: data.error })
    } catch (e) {
      userResults.push({ user_id: r.user_id, ok: false, error: e instanceof Error ? e.message : 'Onbekende fout' })
    }
  }

  const totalSynced =
    projectResults.reduce((sum, r) => sum + (r.synced ?? 0), 0) +
    userResults.reduce((sum, r) => sum + (r.synced ?? 0), 0)

  return NextResponse.json({
    ok:              true,
    project_count:   projectIds.length,
    user_count:      rows.length,
    synced:          totalSynced,
    project_results: projectResults,
    user_results:    userResults,
  })
}
