import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/integrations/google/start
 *
 * Start de OAuth-flow: redirect de gebruiker naar Google's autorisatie-pagina.
 * `state` bevat de user-id zodat we 'm in de callback kunnen valideren.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  if (!user) {
    return NextResponse.redirect(new URL('/auth/login', baseUrl))
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.GOOGLE_CLIENT_ID!,
    redirect_uri:  `${baseUrl}/api/integrations/google/callback`,
    scope: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      // Toegevoegd 2026-05-27 voor appointment-planner: lezen van busy
      // slots + all-day provincie-events, schrijven van afspraak-events.
      // Bestaande users moeten 1x reauth om de scope te krijgen — we
      // detecteren dat client-side door bij een 403 op de Calendar API
      // een banner te tonen die naar /api/integrations/google/start linkt.
      'https://www.googleapis.com/auth/calendar.events',
    ].join(' '),
    access_type: 'offline',  // → krijgt refresh_token
    prompt:      'consent',  // → forceer refresh_token bij her-verbinding
    state:       user.id,    // CSRF-bescherming via user-id match
  })

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  return NextResponse.redirect(authUrl)
}
