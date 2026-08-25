import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  getValidHubSpotAccessToken,
  getValidHubSpotAccessTokenForProject,
  lookupDealstageForLead,
  getDealstageById,
} from '@/lib/hubspot'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/integrations/hubspot/sync
 *
 * Synct dealstages uit HubSpot voor afspraken op een project.
 *
 * Token-resolution:
 *   - project_id in body + project_hubspot_integrations bestaat → PROJECT-tokens
 *     (cc_manager-pad, per-klant HubSpot).
 *   - Anders → user-level tokens (legacy sales_manager-pad).
 *
 * Werkwijze per afspraak: pak email/phone → cached deal_id? direct fetch :
 * lookup contact → deal → label. Schrijf dealstage_raw + hubspot_deal_id +
 * dealstage_synced_at. Na de loop: trigger classify-dealstages per project.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createSbClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const onlyProjectId: string | undefined = body.project_id
    const baseUrl = req.nextUrl.origin

    // Pad A — Project-tokens
    if (onlyProjectId) {
      const sbAdmin = createServiceClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      )
      const { data: phiRow } = await sbAdmin
        .from('project_hubspot_integrations')
        .select('project_id')
        .eq('project_id', onlyProjectId)
        .maybeSingle()

      if (phiRow) {
        const { data: ccRow } = await sbAdmin
          .from('project_call_centers')
          .select('call_centers!inner(manager_id)')
          .eq('project_id', onlyProjectId)
          .maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const managerId = (ccRow as any)?.call_centers?.manager_id
        if (managerId !== user.id) {
          return NextResponse.json({ error: 'Geen toegang' }, { status: 403 })
        }
        return await runDealstageSyncForProject(onlyProjectId, true, baseUrl)
      }
    }

    // Pad B — User-tokens (legacy)
    return await runSyncForUser(user.id, onlyProjectId, true, baseUrl)
  } catch (e) {
    console.error('[hubspot/sync] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Onbekende fout' },
      { status: 500 },
    )
  }
}

/**
 * Sync voor één sales_manager (user-level tokens). Loopt over alle projecten
 * waar deze user als sales_manager staat.
 */
export async function runSyncForUser(
  userId: string,
  onlyProjectId?: string,
  force = false,
  baseUrl?: string,
): Promise<NextResponse> {
  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  let accessToken: string
  try {
    accessToken = await getValidHubSpotAccessToken(userId)
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : 'Geen HubSpot-koppeling',
    }, { status: 400 })
  }

  let projectQuery = sbAdmin
    .from('project_members')
    .select('project_id')
    .eq('profile_id', userId)
    .eq('role', 'sales_manager')

  if (onlyProjectId) {
    projectQuery = projectQuery.eq('project_id', onlyProjectId)
  }

  const { data: pmRows, error: pmErr } = await projectQuery
  if (pmErr) {
    return NextResponse.json({ error: pmErr.message }, { status: 500 })
  }
  const projectIds = (pmRows ?? []).map(r => (r as { project_id: string }).project_id)
  if (projectIds.length === 0) {
    return NextResponse.json({
      ok:      true,
      synced:  0,
      message: 'Geen projecten gevonden waar je sales_manager van bent.',
    })
  }

  return await syncAppointmentsForProjects(sbAdmin, accessToken, projectIds, force, baseUrl)
}

/**
 * Sync voor één PROJECT met project-level tokens. Wordt aangeroepen wanneer
 * een project een eigen project_hubspot_integrations heeft (per-klant HubSpot).
 */
export async function runDealstageSyncForProject(
  projectId: string,
  force = false,
  baseUrl?: string,
): Promise<NextResponse> {
  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  let accessToken: string
  try {
    accessToken = await getValidHubSpotAccessTokenForProject(projectId)
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : 'Geen HubSpot-koppeling voor dit project',
    }, { status: 400 })
  }

  return await syncAppointmentsForProjects(sbAdmin, accessToken, [projectId], force, baseUrl)
}

/**
 * Gemeenschappelijke kern: voor een set project_ids, sync alle afspraken
 * via de gegeven accessToken. Geëxtraheerd om duplicatie tussen user- en
 * project-pad te vermijden.
 */
async function syncAppointmentsForProjects(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sbAdmin: any,
  accessToken: string,
  projectIds: string[],
  force: boolean,
  baseUrl?: string,
): Promise<NextResponse> {
  const cutoff = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString()

  type CallRow = {
    id:                  string
    project_id:          string
    email:               string | null
    phone:               string | null
    custom_fields:       Record<string, string | number | null> | null
    hubspot_deal_id:     string | null
    dealstage_raw:       string | null
    dealstage_synced_at: string | null
  }

  let q = sbAdmin
    .from('call_records')
    .select('id, project_id, email, phone, custom_fields, hubspot_deal_id, dealstage_raw, dealstage_synced_at')
    .in('project_id', projectIds)
    .or('status.ilike.%afspraak%,status.ilike.%appointment%')

  if (!force) {
    q = q.or(`dealstage_synced_at.is.null,dealstage_synced_at.lt.${cutoff}`)
  }

  const { data: appts, error: apptErr } = await q.returns<CallRow[]>()

  if (apptErr) {
    return NextResponse.json({ error: apptErr.message }, { status: 500 })
  }

  const appointments = appts ?? []
  if (appointments.length === 0) {
    return NextResponse.json({ ok: true, synced: 0, message: 'Niets te syncen.' })
  }

  let synced     = 0
  let notFound   = 0
  let errored    = 0
  const projectsTouched = new Set<string>()

  for (const a of appointments) {
    try {
      const cf = a.custom_fields ?? {}
      const email = a.email ?? pickField(cf, ['email', 'mail', 'e-mail', 'emailadres'])
      const phone = a.phone ?? pickField(cf, ['phone', 'telefoon', 'tel', 'gsm', 'mobile', 'mobiel'])
      // HubSpot Contact-ID uit Lemlist meegeleverd (lead.variables.hubspotLeadId).
      // Als aanwezig → skip de email/phone search en ga direct naar de deal-lookup.
      const hubspotContactId = pickField(cf, ['hubspot_contact_id', 'hubspotContactId', 'hubspot_lead_id', 'hubspotLeadId'])

      let result: { dealstage_id: string; dealstage_label: string; deal_id: string } | null = null

      if (a.hubspot_deal_id) {
        const cached = await getDealstageById(accessToken, a.hubspot_deal_id)
        if (cached) {
          result = {
            deal_id:         a.hubspot_deal_id,
            dealstage_id:    cached.dealstage_id,
            dealstage_label: cached.dealstage_label,
          }
        }
      }

      if (!result) {
        const lookup = await lookupDealstageForLead(accessToken, {
          email,
          phone,
          hubspot_contact_id: hubspotContactId,
        })
        if (lookup) {
          result = {
            deal_id:         lookup.deal_id,
            dealstage_id:    lookup.dealstage_id,
            dealstage_label: lookup.dealstage_label,
          }
        }
      }

      if (!result) {
        await sbAdmin.from('call_records')
          .update({ dealstage_synced_at: new Date().toISOString() })
          .eq('id', a.id)
        notFound++
        continue
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const upd: any = {
        dealstage_raw:           result.dealstage_label,
        hubspot_deal_id:         result.deal_id,
        dealstage_synced_at:     new Date().toISOString(),
        dealstage_classified_at: null,
        dealstage_category:      null,
      }
      const { error: updErr } = await sbAdmin.from('call_records')
        .update(upd)
        .eq('id', a.id)

      if (updErr) {
        console.warn(`[hubspot/sync] update failed voor ${a.id}:`, updErr.message)
        errored++
        continue
      }
      synced++
      projectsTouched.add(a.project_id)
    } catch (e) {
      console.warn(`[hubspot/sync] error voor ${a.id}:`, e)
      errored++
    }
  }

  // Classify-dealstages per project
  const effectiveBaseUrl = baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const cronSecret = process.env.CRON_SECRET ?? ''
  let classifySuccess = 0
  let classifyFailed  = 0
  const classifyErrors: string[] = []

  for (const pid of Array.from(projectsTouched)) {
    try {
      const res = await fetch(`${effectiveBaseUrl}/api/projects/${pid}/classify-dealstages`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${cronSecret}`,
        },
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        classifyFailed++
        classifyErrors.push(`project ${pid}: ${res.status} ${txt}`)
        console.warn(`[hubspot/sync] classify ${pid} faalde: ${res.status} ${txt}`)
      } else {
        classifySuccess++
      }
    } catch (e) {
      classifyFailed++
      const msg = e instanceof Error ? e.message : String(e)
      classifyErrors.push(`project ${pid}: ${msg}`)
      console.warn(`[hubspot/sync] classify ${pid} fetch error:`, e)
    }
  }

  return NextResponse.json({
    ok:               true,
    synced,
    not_found:        notFound,
    errored,
    projects_touched: projectsTouched.size,
    classify_success: classifySuccess,
    classify_failed:  classifyFailed,
    ...(classifyErrors.length > 0 ? { classify_errors: classifyErrors } : {}),
  })
}

/**
 * Zoek een veld in custom_fields op basis van case-insensitive aliassen.
 */
function pickField(
  fields: Record<string, string | number | null>,
  aliases: string[],
): string | null {
  const lowerAliases = aliases.map(a => a.toLowerCase())
  for (const [key, value] of Object.entries(fields)) {
    if (lowerAliases.includes(key.toLowerCase()) && value != null && String(value).trim()) {
      return String(value).trim()
    }
  }
  return null
}
