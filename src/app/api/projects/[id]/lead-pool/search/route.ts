import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/projects/[id]/lead-pool/search?q=...&limit=20
 *
 * Autocomplete-endpoint voor de cold caller. Zoekt leads in het project op
 * basis van business_name (ILIKE prefix + substring). Returnt alleen leads
 * met geocode_status='ok' want anders heeft de slot-finder geen provincie
 * om mee te matchen — een lead zonder provincie is voor deze flow nutteloos.
 *
 * Alleen open leads (status='open') worden teruggeven; geboekte/gearchiveerde
 * leads filtert de UI uit zodat een cold caller niet dezelfde lead 2× boekt.
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const q       = (url.searchParams.get('q') ?? '').trim()
  const limit   = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 50)

  // Sanitize % en _ in zoekterm zodat user-input geen ILIKE-wildcards triggert
  const safeQ = q.replace(/[%_]/g, '\\$&')

  let query = supabase
    .from('lead_pool')
    .select('id, business_name, address, postal_code, city, province')
    .eq('project_id',     params.id)
    .eq('status',         'open')
    .eq('geocode_status', 'ok')
    .order('business_name', { ascending: true })
    .limit(limit)

  if (safeQ.length > 0) {
    query = query.ilike('business_name', `%${safeQ}%`)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: `Search mislukt: ${error.message}` }, { status: 500 })
  }
  return NextResponse.json({ leads: data ?? [] })
}
