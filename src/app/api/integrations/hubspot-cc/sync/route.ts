import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  getValidHubSpotAccessToken,
  getValidHubSpotAccessTokenForProject,
  getCallEngagementsInWindow,
  getListMembership,
  getContactsBatch,
  mapHubSpotDispositionToStatus,
  stripHtml,
} from '@/lib/hubspot'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/integrations/hubspot-cc/sync
 *
 * Synct calls vanuit HubSpot voor één of meer projecten. Iedere project heeft
 * zijn eigen HubSpot OAuth-koppeling in project_hubspot_integrations (nieuwe
 * flow, sinds 2026-05-13). Voor projecten die nog op de oude user-level
 * koppeling zitten valt de route terug op hubspot_integrations[user_id].
 *
 * Werkwijze per project:
 *   1. Pak project-tokens (of fallback: user-tokens van de cc_manager).
 *   2. Haal contact-ids op die in de gekoppelde HubSpot-list zitten.
 *   3. Haal call-engagements op binnen het datum-window (default 30 dagen),
 *      filter naar enkel calls op contacts in de list.
 *   4. Verrijk met contact-info (naam, email, telefoon).
 *   5. Map HubSpot owner.email → CallScope profiles.email → caller_id voor
 *      automatische caller-attributie.
 *   6. Map disposition naar status; notities geHTMLstript naar plain text.
 *   7. Upsert via (project_id, hubspot_call_engagement_id) — idempotent
 *      bij re-syncs.
 *   8. Trigger /api/analyse na succesvolle sync.
 *
 * Body (optioneel): { project_id, days_back } — default: alle gekoppelde
 * projecten + 30 dagen terug.
 */
export async function POST(req: NextRequest) {
  try {
    const sb = createSbClient()
    const { data: { user } } = await sb.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const onlyProjectId: string | undefined = body.project_id
    const daysBack: number = typeof body.days_back === 'number' ? body.days_back : 30
    const baseUrl = req.nextUrl.origin

    return await runHubSpotCallsSyncForUser(user.id, onlyProjectId, daysBack, baseUrl)
  } catch (e) {
    console.error('[hubspot-cc/sync] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Onbekende fout' },
      { status: 500 },
    )
  }
}

export async function runHubSpotCallsSyncForUser(
  userId:        string,
  onlyProjectId: string | undefined,
  daysBack:      number,
  baseUrl:       string,
): Promise<NextResponse> {
  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Call-center van deze user
  const { data: ccRow } = await sbAdmin
    .from('call_centers')
    .select('id')
    .eq('manager_id', userId)
    .maybeSingle()
  const ccId = (ccRow as { id: string } | null)?.id
  if (!ccId) {
    return NextResponse.json({
      ok: true, calls_imported: 0, message: 'Geen call_center gevonden voor deze user.',
    })
  }

  // Welke projecten? Eerst alle projecten met list-koppeling van deze cc_manager.
  // We gebruiken NIET meer hubspot_calls_synced_by als primaire filter —
  // tokens worden per project geresolved (project-table → user-table fallback).
  let projectQuery = sbAdmin
    .from('projects')
    .select('id, name, hubspot_calls_list_id, hubspot_calls_list_name, hubspot_calls_synced_by')
    .not('hubspot_calls_list_id', 'is', null)

  if (onlyProjectId) {
    projectQuery = projectQuery.eq('id', onlyProjectId)
  } else {
    // Beperken tot projecten van deze cc_manager's call_center
    const { data: pccRows } = await sbAdmin
      .from('project_call_centers')
      .select('project_id')
      .eq('call_center_id', ccId)
    const projectIds = ((pccRows ?? []) as { project_id: string }[]).map(r => r.project_id)
    if (projectIds.length === 0) {
      return NextResponse.json({
        ok: true, calls_imported: 0, message: 'Geen projecten met HubSpot-list voor deze user.',
      })
    }
    projectQuery = projectQuery.in('id', projectIds)
  }

  const { data: projRows } = await projectQuery
  type ProjLite = {
    id:                       string
    name:                     string
    hubspot_calls_list_id:    string
    hubspot_calls_list_name:  string | null
    hubspot_calls_synced_by:  string | null
  }
  const projects = (projRows ?? []) as ProjLite[]

  if (projects.length === 0) {
    return NextResponse.json({
      ok: true, calls_imported: 0,
      message: 'Geen projecten met HubSpot-list gekoppeld.',
    })
  }

  // ── Email → caller_id lookup (eenmaal voor alle projecten) ───────────────
  // We pakken alle profiles met een email — niet enkel de project-leden, want
  // freelance cc_managers zitten soms onder hun persoonlijke email die niet
  // in project_members staat.
  const { data: profRows } = await sbAdmin
    .from('profiles')
    .select('id, email')
    .not('email', 'is', null)
  type Prof = { id: string; email: string }
  const emailToProfile = new Map<string, string>()
  for (const p of (profRows ?? []) as Prof[]) {
    if (p.email) emailToProfile.set(p.email.toLowerCase(), p.id)
  }

  // ── Per project: tokens → list-members → calls-in-window → upsert ────────
  const fromIso = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  const toIso   = new Date().toISOString()
  const today   = new Date().toISOString().slice(0, 10)

  const projectsTouched = new Set<string>()
  let totalCallsImported = 0
  const projectResults: Array<{
    project_id:     string
    project_name:   string
    list:           string
    calls_imported: number
    error?:         string
    /** Diagnostiek — helpt bij debugging waarom 0 calls binnenkomen */
    debug?: {
      list_members:                 number
      engagements_returned:         number
      engagements_after_list_filter: number
      callers_grouped:              number
    }
  }> = []

  for (const proj of projects) {
    try {
      // Token-resolution: eerst project-level, dan user-level fallback
      let accessToken: string
      try {
        accessToken = await getValidHubSpotAccessTokenForProject(proj.id)
      } catch {
        // Geen project-koppeling — val terug op de user die het project
        // ooit aan zijn HubSpot heeft gehangen (legacy pad).
        const fallbackUserId = proj.hubspot_calls_synced_by ?? userId
        try {
          accessToken = await getValidHubSpotAccessToken(fallbackUserId)
        } catch {
          projectResults.push({
            project_id:     proj.id,
            project_name:   proj.name,
            list:           proj.hubspot_calls_list_name ?? proj.hubspot_calls_list_id,
            calls_imported: 0,
            error:          'Geen HubSpot-koppeling voor dit project',
          })
          continue
        }
      }

      // Contact-ids van de list
      const memberIds = await getListMembership(accessToken, proj.hubspot_calls_list_id)
      const memberSet = new Set(memberIds)
      const listMemberCount = memberSet.size
      if (memberSet.size === 0) {
        projectResults.push({
          project_id:     proj.id,
          project_name:   proj.name,
          list:           proj.hubspot_calls_list_name ?? proj.hubspot_calls_list_id,
          calls_imported: 0,
          debug: {
            list_members:                 0,
            engagements_returned:         0,
            engagements_after_list_filter: 0,
            callers_grouped:              0,
          },
        })
        continue
      }

      // Alle calls in window (gepagineerd uit HubSpot)
      const allCalls = await getCallEngagementsInWindow(accessToken, fromIso, toIso)

      // Filter naar calls op contacts in de list
      const relevantCalls = allCalls.filter(c =>
        c.contact_id != null && memberSet.has(c.contact_id),
      )
      if (relevantCalls.length === 0) {
        projectResults.push({
          project_id:     proj.id,
          project_name:   proj.name,
          list:           proj.hubspot_calls_list_name ?? proj.hubspot_calls_list_id,
          calls_imported: 0,
          debug: {
            list_members:                 listMemberCount,
            engagements_returned:         allCalls.length,
            engagements_after_list_filter: 0,
            callers_grouped:              0,
          },
        })
        continue
      }

      // Contact-info (naam, email, tel) batch ophalen
      const contactIds = Array.from(new Set(relevantCalls.map(c => c.contact_id!).filter(Boolean)))
      const contactsMap = await getContactsBatch(accessToken, contactIds)

      // Groepeer calls per caller (= owner-email → profile match). Calls
      // waarvan we de caller niet kunnen matchen vallen onder de cc_manager
      // zelf (= "ongemarkeerd"). Per caller maken we één upload-rij — zo
      // blijft caller-attributie kloppen in upload_summary, team-page en
      // coaching.
      const callsByCaller = new Map<string, typeof relevantCalls>()
      for (const c of relevantCalls) {
        const matched = c.owner_email
          ? emailToProfile.get(c.owner_email.toLowerCase()) ?? null
          : null
        const bucketCallerId = matched ?? userId          // fallback: cc_manager
        if (!callsByCaller.has(bucketCallerId)) callsByCaller.set(bucketCallerId, [])
        callsByCaller.get(bucketCallerId)!.push(c)
      }

      const listLabel = proj.hubspot_calls_list_name ?? proj.hubspot_calls_list_id
      let imported = 0
      const allUpsertErrors: string[] = []

      // Per caller: één upload + zijn call_records
      for (const [callerId, callerCalls] of Array.from(callsByCaller.entries())) {
        const { data: uploadRow, error: upErr } = await sbAdmin
          .from('uploads')
          .insert({
            project_id:     proj.id,
            caller_id:      callerId,
            call_center_id: ccId,
            filename:       `HubSpot sync — ${listLabel} — ${today}`,
            tool:           'hubspot_calls',
            status:         'processing',
            uploaded_at:    new Date().toISOString(),
          })
          .select()
          .single()
        if (upErr || !uploadRow) {
          console.warn(`[hubspot-cc/sync] upload-aanmaken faalde voor ${proj.id} caller ${callerId}: ${upErr?.message}`)
          continue
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uploadId = (uploadRow as any).id as string

        const records = (callerCalls as typeof relevantCalls).map(c => {
          const contact = c.contact_id ? contactsMap.get(c.contact_id) ?? null : null
          const fullName = contact
            ? [contact.firstname, contact.lastname].filter(Boolean).join(' ') || null
            : null

          return {
            upload_id:                  uploadId,
            project_id:                 proj.id,
            external_id:                `hubspot-call-${c.engagement_id}`,
            hubspot_call_engagement_id: c.engagement_id,
            lead_name:                  fullName,
            email:                      contact?.email ?? null,
            phone:                      contact?.phone ?? null,
            status:                     mapHubSpotDispositionToStatus(c.disposition_label),
            notes:                      stripHtml(c.body),
            call_date:                  c.timestamp_iso.slice(0, 10),
            duration_seconds:           c.duration_ms ? Math.round(c.duration_ms / 1000) : null,
            custom_fields:              {},
          }
        })

        let importedForCaller = 0
        for (let i = 0; i < records.length; i += 500) {
          const batch = records.slice(i, i + 500)
          const { error: rErr } = await sbAdmin
            .from('call_records')
            .upsert(batch, { onConflict: 'project_id,hubspot_call_engagement_id' })
          if (rErr) {
            console.warn(`[hubspot-cc/sync] upsert error voor ${proj.id} caller ${callerId}:`, rErr.message)
            allUpsertErrors.push(`${rErr.code ?? ''} ${rErr.message}`.trim())
          } else {
            importedForCaller += batch.length
          }
        }

        await sbAdmin.from('uploads').update({ status: 'done' }).eq('id', uploadId)

        if (importedForCaller > 0) {
          fetch(`${baseUrl}/api/analyse`, {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
            },
            body: JSON.stringify({ uploadId }),
          }).catch(err => console.warn('[hubspot-cc/sync] analyse trigger:', err))
        }

        imported += importedForCaller
      }

      totalCallsImported += imported
      projectsTouched.add(proj.id)
      projectResults.push({
        project_id:     proj.id,
        project_name:   proj.name,
        list:           listLabel,
        calls_imported: imported,
        // Toon DB-errors zelfs als er WEL ook geslaagde inserts waren — zo
        // weet de gebruiker als bv. 1 op 3 batches gefaald is.
        ...(allUpsertErrors.length > 0
          ? { error: 'DB upsert errors: ' + allUpsertErrors.slice(0, 2).join(' | ') }
          : {}),
        debug: {
          list_members:                 listMemberCount,
          engagements_returned:         allCalls.length,
          engagements_after_list_filter: relevantCalls.length,
          callers_grouped:              callsByCaller.size,
        },
      })
    } catch (e) {
      projectResults.push({
        project_id:     proj.id,
        project_name:   proj.name,
        list:           proj.hubspot_calls_list_name ?? proj.hubspot_calls_list_id,
        calls_imported: 0,
        error:          e instanceof Error ? e.message : String(e),
      })
    }
  }

  return NextResponse.json({
    ok:                true,
    projects_touched:  projectsTouched.size,
    calls_imported:    totalCallsImported,
    results:           projectResults,
  })
}

/**
 * Variant die per project-id sync uitvoert zonder een userId te vereisen.
 * Wordt gebruikt door de cron — die loopt over project_hubspot_integrations
 * en triggert hier rechtstreeks op project_id (de tokens worden per project
 * geresolved, dus userId is irrelevant).
 *
 * cc_manager (= owner van het project's call_center) wordt opgehaald om
 * uploads/caller-fallback te zetten — niet voor token-resolution.
 */
export async function runHubSpotCallsSyncForProject(
  projectId: string,
  daysBack:  number,
  baseUrl:   string,
): Promise<{ ok: boolean; calls_imported: number; error?: string }> {
  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Cc_manager van project ophalen (= owner van het call_center waaraan
  // project gekoppeld is). Nodig voor caller-fallback in upload-attributie.
  const { data: ccRow } = await sbAdmin
    .from('project_call_centers')
    .select('call_center_id, call_centers!inner(manager_id)')
    .eq('project_id', projectId)
    .maybeSingle()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ccData = ccRow as any
  const managerId: string | null = ccData?.call_centers?.manager_id ?? null
  if (!managerId) {
    return { ok: false, calls_imported: 0, error: 'Geen call_center / manager voor project' }
  }

  const res = await runHubSpotCallsSyncForUser(managerId, projectId, daysBack, baseUrl)
  const data = await res.json() as {
    ok?: boolean; calls_imported?: number; error?: string
  }
  return {
    ok:             !!data.ok,
    calls_imported: data.calls_imported ?? 0,
    error:          data.error,
  }
}