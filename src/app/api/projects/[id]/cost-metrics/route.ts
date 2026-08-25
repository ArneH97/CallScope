import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { calcProjectCostMetrics } from '@/lib/cost-metrics'

export const runtime = 'nodejs'

/**
 * GET /api/projects/[id]/cost-metrics?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Berekent kost-metrics voor één project over de opgegeven periode.
 * Gebruikt door client-side dashboards (sales-overzicht etc.) om de
 * "Tijd & kost"-card te renderen.
 *
 * Toegang: gebruikt user-cookie auth — RLS-policies op project_caller_rates
 * en weekly_hour_confirmations zorgen dat alleen project-leden cijfers zien.
 * De helper draait met service-role om de queries simpel te houden, dus we
 * doen hier een handmatige permissie-check om RLS-bypass te voorkomen.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id
  const sb = createSbClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  // Permissie-check: gebruiker moet project_member zijn OF cc_manager via call_centers.
  // Als RLS pakt — de SELECT met user-context op project_caller_rates is al
  // gegate'd, dus we hoeven hier alleen het bestaan van een access-pad te
  // verifiëren.
  const { data: pm } = await sb
    .from('project_members')
    .select('id')
    .eq('project_id', projectId)
    .eq('profile_id', user.id)
    .maybeSingle()

  let hasAccess = !!pm
  if (!hasAccess) {
    const { data: ccLink } = await sb
      .from('project_call_centers')
      .select('call_centers!inner(manager_id)')
      .eq('project_id', projectId)
      .maybeSingle()
    type CCRow = { call_centers: { manager_id: string } | { manager_id: string }[] | null }
    const link = ccLink as CCRow | null
    const cc = Array.isArray(link?.call_centers) ? link?.call_centers[0] : link?.call_centers
    hasAccess = cc?.manager_id === user.id
  }
  if (!hasAccess) {
    return NextResponse.json({ error: 'Geen toegang tot dit project' }, { status: 403 })
  }

  // Volledige ISO doorgeven (geen .slice(0,10)) — anders shift je grenzen
  // 1-2u en sluipen records van vorige/volgende dag erin.
  const fromIso = req.nextUrl.searchParams.get('from') ??
                  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const toIso   = req.nextUrl.searchParams.get('to') ??
                  new Date().toISOString()

  const metrics = await calcProjectCostMetrics(projectId, fromIso, toIso)
  return NextResponse.json({ metrics })
}
