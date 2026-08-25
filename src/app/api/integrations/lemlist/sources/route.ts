import { NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { getLemlistApiKey, testApiKey, listTeamUsers } from '@/lib/lemlist'

export const runtime = 'nodejs'

/**
 * GET /api/integrations/lemlist/sources
 *
 * SINDS refactor 2026-07: we importeren alle team-activities zonder
 * campaign-filter, dus "source" heeft geen selectie-betekenis meer. We
 * blijven wél deze endpoint aanbieden om de bestaande `LemlistCampaignPicker`
 * niet te breken.
 *
 * Response bevat:
 *   - sources: één-element array [{ id: '*', name: 'Alle team activities' }]
 *   - team:    workspace-info voor extra display
 *   - users:   lijst van team-userIds + email (voor mapping-diagnose)
 *
 * De picker toont daarmee gewoon één keuze en de user vinkt aan om Lemlist
 * te activeren voor het project.
 */
export async function GET() {
  const sb = createSbClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }
  let apiKey: string
  try {
    apiKey = await getLemlistApiKey(user.id)
  } catch {
    return NextResponse.json({ error: 'Geen Lemlist-koppeling' }, { status: 400 })
  }

  // Team + users voor diagnose. Falen mag niet fataal zijn — als een
  // van deze mislukt geven we alsnog de `sources` terug zodat de picker
  // niet blokkeert.
  let team: Awaited<ReturnType<typeof testApiKey>> = null
  let users: Awaited<ReturnType<typeof listTeamUsers>> = []
  try { team  = await testApiKey(apiKey)   } catch { /* skip */ }
  try { users = await listTeamUsers(apiKey) } catch { /* skip */ }

  return NextResponse.json({
    sources: [
      {
        id:    '*',
        name:  'Alle team activities',
        count: users.length,   // aantal team-users als indicatie
      },
    ],
    team,
    users,
  })
}
