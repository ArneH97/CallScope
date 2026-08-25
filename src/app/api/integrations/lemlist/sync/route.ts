import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  getLemlistApiKey,
  listTeamUsers,
  getManualDoneActivities,
  mapOutcomeToStatus,
  type LemlistActivity,
} from '@/lib/lemlist'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/integrations/lemlist/sync
 *
 * Nieuwe flow (2026-07): completed manual activities uit Lemlist trekken
 * en per-caller attribueren aan de juiste CallScope cold_caller.
 *
 * Werkwijze per project:
 *   1. Bouw de mapping lemlist_user_id → callscope_profile_id via email-match
 *      met CallScope profiles die member zijn van dit project (als cold_caller).
 *   2. Fetch alle manual*Done activities uit Lemlist in het tijdswindow.
 *   3. Per activity: pak `sendUserId` (of `userId` als fallback), zoek de
 *      caller_id op via de mapping. Skip als geen match (per user's keuze —
 *      Roos en andere unmapped Lemlist-users worden dus niet geïmporteerd).
 *   4. Groepeer activities per caller_id en maak per caller één upload-rij +
 *      insert call_records met de bekende dedup-key.
 *
 * Body (optioneel): { project_id, days_back } — default: alle Lemlist-projecten
 * van deze user + 30 dagen terug.
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
    return await runLemlistSyncForUser(user.id, onlyProjectId, daysBack, baseUrl)
  } catch (e) {
    console.error('[lemlist/sync] error:', e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Onbekende fout' },
      { status: 500 },
    )
  }
}

type ProjectLite = {
  id:   string
  name: string
}

type ProjectResult = {
  project_id:      string
  project_name:    string
  callers_matched: number
  callers_skipped: string[]     // Lemlist user-ids die geen CallScope-caller in dit project hadden
  activities_seen: number
  calls_imported:  number
  error?:          string
}

export async function runLemlistSyncForUser(
  userId:        string,
  onlyProjectId: string | undefined,
  daysBack:      number,
  baseUrl:       string,
): Promise<NextResponse> {
  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // ── 1. API-key ─────────────────────────────────────────────────────────
  let apiKey: string
  try {
    apiKey = await getLemlistApiKey(userId)
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : 'Geen Lemlist-koppeling',
    }, { status: 400 })
  }

  // ── 2. Call center van deze user (voor de upload-rij verderop) ─────────
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

  // ── 3. Welke projecten? Alles met een Lemlist-flag (lemlist_campaign_id
  //      NOT NULL). Waarde is legacy — sinds deze refactor negeren we hem
  //      en importeren we alle team-activities. Nul-migratie: bestaande
  //      projecten met b.v. '*' of een oude source-naam blijven werken.
  let projectQuery = sbAdmin
    .from('projects')
    .select('id, name')
    .not('lemlist_campaign_id', 'is', null)
  if (onlyProjectId) projectQuery = projectQuery.eq('id', onlyProjectId)
  const { data: projRows } = await projectQuery
  const projects = (projRows ?? []) as ProjectLite[]

  if (projects.length === 0) {
    return NextResponse.json({
      ok: true, calls_imported: 0,
      message: 'Geen projecten met Lemlist-koppeling gevonden.',
    })
  }

  // ── 4. Team-users éénmalig ophalen (rate-limit-safe). Cache voor alle
  //      projecten van deze user.
  let teamUsers: Awaited<ReturnType<typeof listTeamUsers>> = []
  try {
    teamUsers = await listTeamUsers(apiKey)
  } catch (e) {
    return NextResponse.json({
      ok: false, error: `Team-users ophalen mislukt: ${e instanceof Error ? e.message : e}`,
    }, { status: 500 })
  }
  // email (lowercase) → lemlist userId (voor snelle reverse lookup)
  const emailByLemlistUser = new Map<string, string>()   // lemlist_user_id → email
  for (const u of teamUsers) {
    if (u.email) emailByLemlistUser.set(u.userId, u.email)
  }

  // ── 5. Activities éénmalig ophalen — één window voor de hele batch,
  //      dan client-side per-project attribueren via de per-project mapping.
  const fromIso = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  const toIso   = new Date().toISOString()
  const today   = new Date().toISOString().slice(0, 10)

  let allActivities: LemlistActivity[] = []
  try {
    allActivities = await getManualDoneActivities(apiKey, fromIso, toIso)
  } catch (e) {
    return NextResponse.json({
      ok: false, error: `Activities ophalen mislukt: ${e instanceof Error ? e.message : e}`,
    }, { status: 500 })
  }

  const totals = { calls_imported: 0, projects_touched: 0 }
  const projectResults: ProjectResult[] = []

  // ── 6. Per project attribueren + upload/call_records inserten ──────────
  for (const proj of projects) {
    try {
      const result = await syncProject(
        sbAdmin, apiKey, proj, ccId, userId, allActivities, emailByLemlistUser, today, baseUrl,
      )
      totals.calls_imported += result.calls_imported
      if (result.calls_imported > 0) totals.projects_touched++
      projectResults.push(result)
    } catch (e) {
      projectResults.push({
        project_id:      proj.id,
        project_name:    proj.name,
        callers_matched: 0,
        callers_skipped: [],
        activities_seen: 0,
        calls_imported:  0,
        error:           e instanceof Error ? e.message : String(e),
      })
    }
  }

  return NextResponse.json({
    ok:                true,
    activities_fetched: allActivities.length,
    ...totals,
    results:           projectResults,
  })
}

/**
 * Per-project sync-logica: bouw mapping, filter activities die bij dit
 * project horen, groepeer per caller, insert.
 */
async function syncProject(
  sbAdmin:            SupabaseClient,
  apiKey:             string,
  proj:               ProjectLite,
  ccId:               string,
  syncTriggerUserId:  string,
  allActivities:      LemlistActivity[],
  emailByLemlistUser: Map<string, string>,
  today:              string,
  baseUrl:            string,
): Promise<ProjectResult> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _apiKey = apiKey  // gereserveerd voor toekomstige per-project checks

  // A. Bouw de lijst van eligible callers = STRICT enkel `cold_caller` role
  //    in project_members. Sales_reps, sales_managers en cc_managers-die-
  //    niet-actief-bellen worden bewust NIET meegenomen.
  //
  //    Historisch namen we ook cc_managers automatisch mee (via call_center
  //    manager_id) voor freelance-scenarios. Dat gaf false positives: een
  //    RestoManager-achtig scenario waar de cc_manager (jij) enkel toekijkt
  //    en niet belt, kreeg ook alle Lemlist-activity van dat account onder
  //    zich getoond.
  //
  //    Nieuwe regel: als een cc_manager (of andere rol) wél echt belt via
  //    Lemlist, MOET hij zichzelf expliciet als `cold_caller` in
  //    project_members zetten. Opt-in, niet impliciet.
  const memberEmails = new Map<string, string>()  // email → profile_id
  const { data: ccRows } = await sbAdmin
    .from('project_members')
    .select('profile_id, profiles!inner(email)')
    .eq('project_id', proj.id)
    .eq('role', 'cold_caller')
  for (const m of (ccRows ?? []) as Array<{ profile_id: string; profiles: { email: string | null } | { email: string | null }[] }>) {
    const prof = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
    if (prof?.email) memberEmails.set(prof.email.toLowerCase(), m.profile_id)
  }
  // sync-triggering user (syncTriggerUserId) doet niet automatisch mee —
  // hij moet ook als cold_caller in project_members staan om als beller te
  // tellen. Referentie behouden voor eventuele future audit-logging.
  void syncTriggerUserId

  // B. Bouw mapping: lemlist_user_id → callscope_profile_id
  //    Voor élke lemlist user: als hun email matched met een member van
  //    dit project → mapping. Anders → skip.
  const mapping = new Map<string, string>()  // lemlist_user_id → callscope profile_id
  const skipped: string[] = []
  for (const [lemUid, email] of emailByLemlistUser) {
    const callerId = memberEmails.get(email)
    if (callerId) mapping.set(lemUid, callerId)
    else          skipped.push(lemUid)
  }

  // C. Filter activities die attribueerbaar zijn aan een gemapte caller
  const perCaller = new Map<string, LemlistActivity[]>()  // callscope caller_id → activities
  let seenForProject = 0
  for (const act of allActivities) {
    const lemUid = act.sendUserId ?? act.userId
    if (!lemUid) continue
    const callerId = mapping.get(lemUid)
    if (!callerId) continue
    seenForProject++
    const arr = perCaller.get(callerId) ?? []
    arr.push(act)
    perCaller.set(callerId, arr)
  }

  if (perCaller.size === 0) {
    return {
      project_id:      proj.id,
      project_name:    proj.name,
      callers_matched: mapping.size,
      callers_skipped: skipped,
      activities_seen: seenForProject,
      calls_imported:  0,
    }
  }

  // D. Per (caller, call_date) een aparte upload-rij + call_records inserten.
  //
  // Kritisch: `uploads.uploaded_at` bepaalt in welk maand-/week-slot de
  // KPI-teller op het dashboard de calls plaatst (`filteredUploads` filtert
  // op uploaded_at). Als we één juli-upload maken met ook juni-calls erin,
  // valt heel dat blok in het juli-filter — misleidend.
  //
  // Oplossing: sub-groepeer per call_date, en gebruik call_date als
  // uploaded_at (12:00 UTC = TZ-veilig). Zo hoort een backfill van juni-
  // activities die vandaag ge-synct worden semantisch in de juni-maand
  // van het dashboard, niet in de dag van de sync.
  let totalImported = 0
  for (const [callerId, activities] of perCaller) {
    // Sub-groepeer per call_date
    const byDay = new Map<string, LemlistActivity[]>()
    for (const act of activities) {
      const callDate = (act.createdAt || new Date().toISOString()).slice(0, 10)
      const arr = byDay.get(callDate) ?? []
      arr.push(act)
      byDay.set(callDate, arr)
    }

    for (const [callDate, dayActivities] of byDay) {
      const uploadedAtIso = `${callDate}T12:00:00.000Z`
      const { data: uploadRow, error: upErr } = await sbAdmin
        .from('uploads')
        .insert({
          project_id:     proj.id,
          caller_id:      callerId,
          call_center_id: ccId,
          filename:       `Lemlist sync — ${callDate}`,
          tool:           'lemlist',
          status:         'processing',
          uploaded_at:    uploadedAtIso,   // = call_date, niet vandaag
        })
        .select()
        .single()
      if (upErr || !uploadRow) {
        console.warn(`[lemlist/sync] upload-insert faalde voor caller ${callerId} ${callDate}:`, upErr?.message)
        continue
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uploadId = (uploadRow as any).id as string

      // Bouw records — één per Lemlist activity. GEEN dedup per (leadId, dag)
      // meer: als Dieter dezelfde lead 3× op één dag belt (ochtend no-answer,
      // middag gatekeeper, avond connected) is dat 3 echte calls die elk hun
      // eigen record verdienen. Sinds we `aircallDone` uit het type-filter
      // hebben gehaald, is dubbeltelling niet mogelijk — enkel aircallEnded
      // wordt geïmporteerd voor VoIP-calls.
      //
      // external_id = activity._id (unieke Lemlist-key) zodat de dedup-key op
      // de DB `(project_id, external_id, call_date)` automatisch elke activity
      // apart houdt. Upsert = idempotent: bij re-sync worden bestaande rijen
      // enkel geüpdatet, geen dubbele inserts.
      const records = dayActivities.map(act => {
        // Voor cold-calling naar zaken (RestoManager stijl) is de bedrijfs-
        // /restaurant-naam de primaire identifier. Pas als de zaak geen naam
        // heeft vallen we terug op de contactpersoon.
        const fullName    = [act.lead.firstName, act.lead.lastName].filter(Boolean).join(' ') || null
        const displayName = act.lead.companyName || fullName
        return {
          upload_id:        uploadId,
          project_id:       proj.id,
          external_id:      act.id,
          lead_name:        displayName,
          email:            act.lead.email,
          phone:            act.lead.phone,
          status:           mapOutcomeToStatus(act.outcome),
          notes:            null,
          call_date:        callDate,
          duration_seconds: act.duration,
          custom_fields:    {
            lemlist_campaign_name: act.campaignName,
            lemlist_activity_type: act.type,
            lemlist_call_status:   act.callStatus,
            lemlist_direction:     act.direction,
            lemlist_company_name:  act.lead.companyName,
            lemlist_lead_id:       act.leadId,
            hubspot_contact_id:    act.lead.hubspotContactId,
            concurrent_name:       act.lead.concurrentName,
            company_type:          act.lead.companyType,
            company_city:          act.lead.companyCity,
            lead_campagne:         act.lead.leadCampagne,
          },
          lemlist_lead_id:  act.leadId,
        }
      })

      let imported = 0
      for (let i = 0; i < records.length; i += 500) {
        const batch = records.slice(i, i + 500)
        const { error: rErr } = await sbAdmin
          .from('call_records')
          .upsert(batch, { onConflict: 'project_id,external_id,call_date' })
        if (rErr) {
          console.warn(`[lemlist/sync] upsert error ${proj.id} ${callerId} ${callDate}:`, rErr.message)
        } else {
          imported += batch.length
        }
      }

      await sbAdmin.from('uploads').update({ status: 'done' }).eq('id', uploadId)

      // AI-analyse per upload (per dag) — geeft de classifier per-dag context
      if (imported > 0) {
        fetch(`${baseUrl}/api/analyse`, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
          },
          body: JSON.stringify({ uploadId }),
        }).catch(err => console.warn('[lemlist/sync] analyse trigger:', err))
      }

      totalImported += imported
    }
  }
  // `today` blijft in gebruik elders in de functie
  void today

  return {
    project_id:      proj.id,
    project_name:    proj.name,
    callers_matched: mapping.size,
    callers_skipped: skipped,
    activities_seen: seenForProject,
    calls_imported:  totalImported,
  }
}
