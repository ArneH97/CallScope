import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * POST /api/projects/[id]/hubspot-calls
 * Body: { list_id: string | null, list_name: string | null }
 *
 * Koppelt of ontkoppelt een HubSpot contact-list aan dit project. De cron
 * gebruikt deze koppeling om calls dagelijks te synchroniseren.
 *
 * Permissie: alleen cc_manager van het project (gevalideerd door de RLS-
 * policy `is_cc_manager_of_project` op de UPDATE).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id
  const sb = createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const listId:   string | null = body.list_id   ?? null
  const listName: string | null = body.list_name ?? null

  // Update — RLS zorgt dat alleen de cc_manager van dit project mag schrijven.
  // hubspot_calls_synced_by zetten we op de huidige user zodat de cron weet
  // welke OAuth-token gebruikt moet worden.
  const { error } = await sb
    .from('projects')
    .update({
      hubspot_calls_list_id:    listId,
      hubspot_calls_list_name:  listName,
      hubspot_calls_synced_by:  listId ? user.id : null,
    })
    .eq('id', projectId)

  if (error) {
    return NextResponse.json({ error: `Opslaan mislukt: ${error.message}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
