import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getValidAccessToken, listSpreadsheets } from '@/lib/google'

/**
 * GET /api/integrations/google/spreadsheets
 *
 * Geeft een lijst van Google Sheets terug waar de ingelogde gebruiker
 * toegang toe heeft. Wordt gebruikt door de sheet-picker UI.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  try {
    const accessToken = await getValidAccessToken(user.id)
    const files = await listSpreadsheets(accessToken)
    return NextResponse.json({ spreadsheets: files })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    console.error('[google/spreadsheets]', e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
