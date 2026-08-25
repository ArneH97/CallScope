import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * POST /api/projects/[id]/simulator-assumptions
 * Body: { no_show_rate?: number, closing_rate?: number, arr_per_deal?: number, enabled?: boolean }
 *
 * Update de aannames die de simulator gebruikt om potentieel te projecteren.
 * Alleen cc_manager mag dit (RLS via policies op projects).
 *
 * Waarden clampen we tussen 0-100 (percentages) en >=0 (ARR).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id
  const sb = createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const patch: Record<string, unknown> = { sim_updated_at: new Date().toISOString() }

  const clampPct = (v: number) => Math.max(0, Math.min(100, v))
  if (typeof body.no_show_rate === 'number' && Number.isFinite(body.no_show_rate)) {
    patch.sim_no_show_rate = clampPct(body.no_show_rate)
  }
  if (typeof body.closing_rate === 'number' && Number.isFinite(body.closing_rate)) {
    patch.sim_closing_rate = clampPct(body.closing_rate)
  }
  if (typeof body.arr_per_deal === 'number' && Number.isFinite(body.arr_per_deal)) {
    patch.sim_arr_per_deal = Math.max(0, body.arr_per_deal)
  }
  if (typeof body.enabled === 'boolean') {
    patch.sim_enabled = body.enabled
  }

  const { error } = await sb.from('projects').update(patch).eq('id', projectId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
