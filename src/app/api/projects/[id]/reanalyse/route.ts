import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/projects/[id]/reanalyse
 *
 * Trigger AI-analyse opnieuw voor ALLE uploads in dit project. Wordt gebruikt
 * wanneer de analyse-logica is verbeterd (bv. nieuwe bezwaar-prompt) en de
 * cc_manager de historische data wil herberekenen zodat de team-page de
 * verbeterde inzichten toont.
 *
 * Beveiliging:
 *   - Alleen cc_manager van dit project mag herrekenen
 *   - Server-to-server call naar /api/analyse met CRON_SECRET bearer
 *
 * Retry-friendly: /api/analyse upsert't op upload_id, dus dubbel uitvoeren
 * overschrijft simpelweg de bestaande analyse-rij.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id
  const sb = createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })

  // Permissie-check: enkel cc_manager van het project
  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: ccLink } = await sbAdmin
    .from('project_call_centers')
    .select('call_centers!inner(manager_id)')
    .eq('project_id', projectId)
    .maybeSingle()
  type CCRow = { call_centers: { manager_id: string } | { manager_id: string }[] | null }
  const link = ccLink as CCRow | null
  const cc = Array.isArray(link?.call_centers) ? link?.call_centers[0] : link?.call_centers
  if (cc?.manager_id !== user.id) {
    return NextResponse.json({ error: 'Geen rechten op dit project' }, { status: 403 })
  }

  // Pak alle uploads van dit project
  const { data: uploadRows } = await sbAdmin
    .from('uploads')
    .select('id')
    .eq('project_id', projectId)
  const uploadIds = ((uploadRows ?? []) as { id: string }[]).map(u => u.id)

  if (uploadIds.length === 0) {
    return NextResponse.json({ ok: true, total: 0, succeeded: 0, message: 'Geen uploads in dit project.' })
  }

  // Trigger /api/analyse voor elke upload, server-to-server met CRON_SECRET.
  // We doen ze SEQUENTIEEL om OpenAI rate-limits niet te raken. Voor projecten
  // met veel uploads kan dit even duren — daarom maxDuration=300.
  const baseUrl = req.nextUrl.origin
  const cronSecret = process.env.CRON_SECRET ?? ''
  let succeeded = 0
  let failed = 0
  const errors: string[] = []

  for (const uploadId of uploadIds) {
    try {
      const res = await fetch(`${baseUrl}/api/analyse`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({ uploadId }),
      })
      if (res.ok) {
        succeeded++
      } else {
        failed++
        const txt = await res.text().catch(() => '')
        if (errors.length < 3) errors.push(`${uploadId}: ${res.status} ${txt.slice(0, 80)}`)
      }
    } catch (e) {
      failed++
      if (errors.length < 3) errors.push(`${uploadId}: ${e instanceof Error ? e.message : 'fout'}`)
    }
  }

  return NextResponse.json({
    ok:        failed === 0,
    total:     uploadIds.length,
    succeeded,
    failed,
    errors:    errors.length > 0 ? errors : undefined,
  })
}
