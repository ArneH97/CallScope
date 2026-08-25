import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendDigestForProject, getServiceClient } from '@/lib/planner-digest-email'
import { isPlannerProject } from '@/lib/feature-flags'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/projects/[id]/appointments/send-daily-digest
 *
 * Stuurt direct (zonder op de cron te wachten) de dagdigest naar alle sales
 * reps die vandaag voor dit project nieuwe afspraken kregen.
 *
 * Toegestaan voor cc_manager + sales_manager binnen dit project. We checken
 * via RLS (project_members / project_call_centers) of de user het project
 * mag zien — zo niet, 403.
 *
 * Beveiligd extra met de feature-flag: alleen planner-projecten mogen dit.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // RLS-check: of de user dit project mag zien
  const { data: proj, error: pErr } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', params.id)
    .single()
  if (pErr || !proj) {
    return NextResponse.json({ error: 'Project niet gevonden' }, { status: 404 })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projRow = proj as any

  if (!isPlannerProject({ id: projRow.id, name: projRow.name })) {
    return NextResponse.json({ error: 'Planner niet beschikbaar voor dit project' }, { status: 403 })
  }

  // Role check: iedereen die op de planner werkt mag de digest triggeren —
  // cc_manager + sales_manager beheren, sales_rep + cold_caller boeken.
  // Allen hebben legitieme reden om "end-of-day, stuur de mails" te willen
  // doen i.p.v. tot 17u te wachten. RLS op het project zelf is al gecheckt
  // hierboven, dus we beperken alleen op rol-binnen-CallScope.
  const { data: profRow } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = (profRow as any)?.role as string | undefined
  const allowed = ['cc_manager', 'sales_manager', 'sales_rep', 'cold_caller']
  if (!role || !allowed.includes(role)) {
    return NextResponse.json({ error: 'Geen rechten' }, { status: 403 })
  }

  try {
    // Service-role voor de eigenlijke send (we lezen emails + bypassen RLS
    // op profiles van andere users in hetzelfde project).
    const sbAdmin = getServiceClient()
    const result = await sendDigestForProject(sbAdmin, params.id)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error('[send-daily-digest] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Onbekende fout' },
      { status: 500 },
    )
  }
}
