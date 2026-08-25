import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getValidAccessToken, listSheetTabs } from '@/lib/google'

/**
 * GET /api/integrations/google/spreadsheets/[id]/tabs
 *
 * Geeft de tab-namen terug van de gegeven spreadsheet.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  try {
    const accessToken = await getValidAccessToken(user.id)
    const tabs = await listSheetTabs(accessToken, params.id)
    return NextResponse.json({ tabs })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    console.error('[google/spreadsheets/tabs]', e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
