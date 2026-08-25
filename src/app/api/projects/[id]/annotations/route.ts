import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * POST /api/projects/[id]/annotations
 * Body: { period_key: string, section_key: string, text: string }
 *
 * Upsert een rapport-annotatie voor deze sectie in deze periode.
 * Als text leeg is → delete (opruimen ipv lege regel bewaren).
 *
 * RLS bepaalt of user rechten heeft (cc_manager van de gekoppelde
 * call_center). Bij falen komt er 42501 permission_denied terug.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id
  const sb = createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const periodKey  = (body.period_key  ?? '').trim()
  const sectionKey = (body.section_key ?? '').trim()
  const text       = (body.text        ?? '').trim()

  if (!periodKey || !sectionKey) {
    return NextResponse.json({ error: 'period_key en section_key vereist' }, { status: 400 })
  }

  // Leeg = weghalen. Zo blijft de tabel schoon zonder losse null-rijen.
  if (text === '') {
    await sb.from('report_annotations')
      .delete()
      .eq('project_id', projectId)
      .eq('period_key', periodKey)
      .eq('section_key', sectionKey)
    return NextResponse.json({ ok: true, deleted: true })
  }

  const { error } = await sb.from('report_annotations').upsert({
    project_id:  projectId,
    period_key:  periodKey,
    section_key: sectionKey,
    text,
    updated_at:  new Date().toISOString(),
    updated_by:  user.id,
  }, { onConflict: 'project_id,period_key,section_key' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
