import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getValidHubSpotAccessToken,
  getValidHubSpotAccessTokenForProject,
  listContactLists,
} from '@/lib/hubspot'

export const runtime = 'nodejs'

/**
 * GET /api/integrations/hubspot-cc/lists?project_id=...
 *
 * Voor de cc_manager: lijst van HubSpot contact-lists. Wordt gebruikt door de
 * project-settings list-picker — de cc_manager kiest welke list gekoppeld is
 * aan welk CallScope-project.
 *
 * Token-resolution (in volgorde van prioriteit):
 *   1. project_hubspot_integrations[project_id]  — per-project koppeling
 *   2. hubspot_integrations[user_id]             — legacy user-level fallback
 *      (voor projecten die nog niet op de nieuwe per-project flow zitten)
 */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get('project_id')

  try {
    let accessToken: string | null = null

    // Pad 1: per-project token (nieuwe flow)
    if (projectId) {
      try {
        accessToken = await getValidHubSpotAccessTokenForProject(projectId)
      } catch {
        // geen project-koppeling — val terug op user-level
      }
    }

    // Pad 2: user-level fallback (legacy / sales_manager-flow)
    if (!accessToken) {
      accessToken = await getValidHubSpotAccessToken(user.id)
    }

    const lists = await listContactLists(accessToken)
    return NextResponse.json({ lists })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
