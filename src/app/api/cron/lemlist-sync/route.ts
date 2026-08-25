import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runLemlistSyncForUser } from '@/app/api/integrations/lemlist/sync/route'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * GET /api/cron/lemlist-sync
 *
 * Dagelijkse cron via vercel.json. Loopt over alle lemlist_integrations,
 * triggert per user een sync van álle zijn projecten met een gekoppelde
 * Lemlist-campaign.
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

  const { data: integrations, error } = await sb
    .from('lemlist_integrations')
    .select('user_id, lemlist_team_name')

  if (error) {
    return NextResponse.json({ error: `Integraties ophalen mislukt: ${error.message}` }, { status: 500 })
  }

  type IntLite = { user_id: string; lemlist_team_name: string | null }
  const rows = (integrations ?? []) as IntLite[]

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, message: 'Geen Lemlist-koppelingen.', count: 0 })
  }

  const baseUrl = req.nextUrl.origin
  const results: { user_id: string; ok: boolean; calls_imported?: number; error?: string }[] = []

  for (const r of rows) {
    try {
      const res = await runLemlistSyncForUser(r.user_id, undefined, 1, baseUrl) // dagelijkse cron = 1 dag terug
      const data = await res.json() as {
        ok?: boolean; calls_imported?: number; error?: string
      }
      results.push({
        user_id:        r.user_id,
        ok:             !!data.ok,
        calls_imported: data.calls_imported,
        error:          data.error,
      })
    } catch (e) {
      results.push({
        user_id: r.user_id,
        ok:      false,
        error:   e instanceof Error ? e.message : 'Onbekende fout',
      })
    }
  }

  const totalCalls = results.reduce((sum, r) => sum + (r.calls_imported ?? 0), 0)
  return NextResponse.json({
    ok:             true,
    integrations:   rows.length,
    calls_imported: totalCalls,
    results,
  })
}
