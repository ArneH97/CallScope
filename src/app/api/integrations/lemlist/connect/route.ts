import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { testApiKey } from '@/lib/lemlist'

export const runtime = 'nodejs'

/**
 * POST /api/integrations/lemlist/connect
 * body: { api_key }
 *
 * Valideert de API-key door GET /team aan te roepen. Bij succes upsert
 * in lemlist_integrations met team-info voor display.
 */
export async function POST(req: NextRequest) {
  try {
    const sb = createSbClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const apiKey = String(body.api_key ?? '').trim()
    if (!apiKey) {
      return NextResponse.json({ error: 'API-key ontbreekt' }, { status: 400 })
    }

    // Validatie: roep Lemlist aan om te checken of de key werkt
    const teamInfo = await testApiKey(apiKey)
    if (!teamInfo) {
      return NextResponse.json({
        error: 'Ongeldige API-key. Check Lemlist Settings → Integrations → API.',
      }, { status: 400 })
    }

    const sbAdmin = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upsert: any = {
      user_id:            user.id,
      api_key:            apiKey,
      lemlist_team_id:    teamInfo.team_id,
      lemlist_team_name:  teamInfo.team_name,
      lemlist_user_email: teamInfo.user_email,
      connected_at:       new Date().toISOString(),
    }

    const { error: dbErr } = await sbAdmin.from('lemlist_integrations').upsert(upsert)
    if (dbErr) {
      console.error('[lemlist/connect] db save:', dbErr)
      return NextResponse.json({ error: dbErr.message }, { status: 500 })
    }

    return NextResponse.json({
      ok:        true,
      team_name: teamInfo.team_name,
      email:     teamInfo.user_email,
    })
  } catch (e) {
    console.error('[lemlist/connect] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Onbekende fout' },
      { status: 500 },
    )
  }
}
