import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runHubSpotCallsSyncForProject } from '@/app/api/integrations/hubspot-cc/sync/route'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * GET /api/cron/hubspot-cc-sync
 *
 * Dagelijkse cron — synct HubSpot calls voor ALLE projecten die:
 *   (a) een project_hubspot_integrations-rij hebben (= per-project OAuth)
 *   (b) een hubspot_calls_list_id ingesteld hebben
 *
 * We loopen per project (niet per user) zodat verschillende klanten met
 * verschillende HubSpot-portalen elk hun eigen tokens gebruiken.
 *
 * Legacy fallback: projecten zonder project_hubspot_integrations maar met
 * hubspot_calls_synced_by gezet worden ook gesynct via de oude user-level
 * tokens — zodat bestaande klanten zonder onderbreking blijven werken.
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

  // Alle projecten met list-koppeling (= klaar om te syncen). De token-
  // resolution in runHubSpotCallsSyncForProject probeert eerst de per-project
  // tokens en valt terug op user-level voor legacy.
  const { data: projRows, error: projErr } = await sb
    .from('projects')
    .select('id, name')
    .not('hubspot_calls_list_id', 'is', null)

  if (projErr) {
    return NextResponse.json({ error: `Projecten ophalen mislukt: ${projErr.message}` }, { status: 500 })
  }

  type ProjLite = { id: string; name: string }
  const projects = (projRows ?? []) as ProjLite[]

  if (projects.length === 0) {
    return NextResponse.json({ ok: true, message: 'Geen projecten met HubSpot calls-koppeling.', count: 0 })
  }

  const baseUrl = req.nextUrl.origin
  const results: { project_id: string; project_name: string; ok: boolean; calls_imported?: number; error?: string }[] = []

  for (const proj of projects) {
    try {
      // Dagelijkse cron = ruim window (2 dagen) om edge-cases rond middernacht
      // / late syncs op te vangen. Dedup via hubspot_call_engagement_id
      // voorkomt dubbele rows.
      const res = await runHubSpotCallsSyncForProject(proj.id, 2, baseUrl)
      results.push({
        project_id:     proj.id,
        project_name:   proj.name,
        ok:             res.ok,
        calls_imported: res.calls_imported,
        error:          res.error,
      })
    } catch (e) {
      results.push({
        project_id:   proj.id,
        project_name: proj.name,
        ok:           false,
        error:        e instanceof Error ? e.message : 'Onbekende fout',
      })
    }
  }

  const totalCalls = results.reduce((sum, r) => sum + (r.calls_imported ?? 0), 0)
  return NextResponse.json({
    ok:             true,
    projects:       projects.length,
    calls_imported: totalCalls,
    results,
  })
}
