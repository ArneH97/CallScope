import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { generateAndStoreCoaching } from '@/lib/coaching'

/**
 * POST /api/coaching/generate
 *
 * Body: { caller_id?: string }
 *   - Niet meegegeven: gebruik de ingelogde user (caller voor zichzelf)
 *   - Meegegeven: enkel toegelaten als requester een cc_manager is wiens
 *     call_center deze caller bevat
 *
 * Antwoord: { advice_text, context_summary, generated_at } of error
 */
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const targetCallerId: string = body?.caller_id ?? user.id

  // Authorization
  if (targetCallerId !== user.id) {
    // Moet een cc_manager zijn wiens call_center deze caller bevat
    const sb = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const { data: membership } = await sb
      .from('call_centers')
      .select('id, call_center_members!inner(profile_id)')
      .eq('manager_id', user.id)
      .eq('call_center_members.profile_id', targetCallerId)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Geen toegang tot deze caller' }, { status: 403 })
    }
  }

  try {
    const result = await generateAndStoreCoaching(targetCallerId)
    if (!result) {
      return NextResponse.json({
        error: 'Kon geen advies genereren',
        reason: 'Mogelijk geen data of OpenAI-fout. Bekijk server-logs voor details.',
      }, { status: 422 })
    }
    return NextResponse.json(result)
  } catch (e) {
    console.error('[coaching/generate] error:', e)
    return NextResponse.json({ error: 'Server-fout bij het genereren van advies' }, { status: 500 })
  }
}
