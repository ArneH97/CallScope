import { NextRequest, NextResponse } from 'next/server'
import { sendDigestForProject, getServiceClient } from '@/lib/planner-digest-email'
import { isPlannerProject } from '@/lib/feature-flags'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * GET /api/cron/daily-appointments-digest
 *
 * Vercel cron triggert dagelijks om 15:00 UTC. In Belgische zomertijd
 * (CEST = UTC+2) is dat exact 17:00 Brussel — perfect voor de end-of-day
 * digest. In wintertijd (CET = UTC+1) komt de mail om 16:00 BE; één uur
 * drift waar we mee leven omdat het Vercel-Hobby-plan slechts 1 trigger
 * per cron per dag toelaat (dual-UTC zou Pro vereisen).
 *
 * Beveiligd via CRON_SECRET (zelfde patroon als de andere cron-routes).
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET niet geconfigureerd' }, { status: 500 })
  }
  if ((req.headers.get('authorization') ?? '') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sb = getServiceClient()

  // Pak alle projecten die de planner-feature aan hebben en loop ze. Voor
  // de huidige beta zijn dat er sowieso weinig (alleen RestoManager), dus
  // sequentieel is prima — geen Promise.all nodig.
  const { data: allProjects, error: pErr } = await sb
    .from('projects')
    .select('id, name')
  if (pErr) {
    return NextResponse.json({ error: pErr.message }, { status: 500 })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plannerProjects = ((allProjects ?? []) as any[]).filter(p =>
    isPlannerProject({ id: p.id, name: p.name }),
  )

  const results = []
  for (const proj of plannerProjects) {
    try {
      const r = await sendDigestForProject(sb, proj.id)
      results.push(r)
    } catch (e) {
      console.error('[cron/daily-appointments-digest] project failed', proj.id, e)
      results.push({
        projectId:    proj.id,
        projectName:  proj.name,
        repsNotified: 0,
        appointments: 0,
        skipped:      [{ repId: '-', reason: e instanceof Error ? e.message : 'error' }],
      })
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      projects:     acc.projects + 1,
      repsNotified: acc.repsNotified + r.repsNotified,
      appointments: acc.appointments + r.appointments,
    }),
    { projects: 0, repsNotified: 0, appointments: 0 },
  )

  return NextResponse.json({ ok: true, ...totals, results })
}
