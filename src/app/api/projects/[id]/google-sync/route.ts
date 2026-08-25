import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { getValidAccessToken, fetchSheetRows } from '@/lib/google'
import type {
  ColumnMapping, CustomFieldDef, CustomFieldsBag, ProjectGoogleSheet, Project,
} from '@/types/database'

/**
 * Slim parser voor BE/EU-stijl getallen — zelfde logica als upload-pagina.
 */
function parseEuropeanNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, '')
  if (!cleaned) return null
  const hasDot = cleaned.includes('.')
  const hasComma = cleaned.includes(',')
  let normalized: string

  if (hasDot && hasComma) {
    const lastDot = cleaned.lastIndexOf('.')
    const lastComma = cleaned.lastIndexOf(',')
    normalized = lastDot > lastComma
      ? cleaned.replace(/,/g, '')
      : cleaned.replace(/\./g, '').replace(',', '.')
  } else if (hasComma) {
    const count = (cleaned.match(/,/g) ?? []).length
    if (count > 1) {
      normalized = cleaned.replace(/,/g, '')
    } else {
      const idx = cleaned.lastIndexOf(',')
      const after = cleaned.length - idx - 1
      normalized = after === 3 ? cleaned.replace(',', '') : cleaned.replace(',', '.')
    }
  } else if (hasDot) {
    const count = (cleaned.match(/\./g) ?? []).length
    if (count > 1) {
      normalized = cleaned.replace(/\./g, '')
    } else {
      const idx = cleaned.lastIndexOf('.')
      const after = cleaned.length - idx - 1
      normalized = after === 3 ? cleaned.replace('.', '') : cleaned
    }
  } else {
    normalized = cleaned
  }

  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

function parseRowDate(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw < 100000) {
    const ms = (raw - 25569) * 86400 * 1000
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  const s = String(raw).trim()
  if (!s) return null
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (iso) {
    const [, y, m, d] = iso
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const be = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)
  if (be) {
    const [, d, m, y] = be
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const fb = new Date(s)
  return Number.isNaN(fb.getTime()) ? null : fb.toISOString().slice(0, 10)
}

function coerceCustomValue(raw: unknown, type: 'text' | 'number' | 'date' | 'category') {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null
  if (type === 'number') return parseEuropeanNumber(s)
  if (type === 'date') return parseRowDate(s)
  return s
}

function todayInBrussels(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Brussels',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id
  const body = await req.json().catch(() => ({}))
  // Multi-sheet: sinds cold callers meerdere sheets kunnen hebben,
  // identificeren we de sync-target liefst via binding_id (= 1 specifieke
  // sheet). Fallback op caller_id blijft voor cron + backwards-compat —
  // die pakt dan de EERSTE binding van die caller.
  const bindingId: string | undefined = body.binding_id
  const callerId:  string | undefined = body.caller_id
  // Datum-window: default = vandaag (backwards-compat).
  // - session_date (string YYYY-MM-DD) → één dag
  // - from_date + to_date (beide YYYY-MM-DD, incl. beide) → range
  const sessionDate: string = body.session_date ?? todayInBrussels()
  const fromDate:    string = body.from_date ?? sessionDate
  const toDate:      string = body.to_date   ?? sessionDate

  if (!bindingId && !callerId) {
    return NextResponse.json({ error: 'binding_id of caller_id ontbreekt' }, { status: 400 })
  }

  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') ?? ''
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`

  if (!isCron) {
    const supabase = createSbClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }
  }

  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  // Lookup: bindingId wint (exacte sheet), anders eerste binding van caller.
  // Multi-sheet: een caller kan meerdere bindings hebben, dus voor het
  // caller_id-pad expliciet .limit(1) — anders faalt .maybeSingle() met
  // "multiple rows returned". De cron loopt zelf over álle bindings.
  let bindingQuery = sb
    .from('project_google_sheets')
    .select('*')
    .eq('project_id', projectId)
  if (bindingId) {
    bindingQuery = bindingQuery.eq('id', bindingId)
  } else if (callerId) {
    bindingQuery = bindingQuery.eq('caller_id', callerId).order('created_at', { ascending: true }).limit(1)
  }
  const { data: bindingData, error: bErr } = await bindingQuery.maybeSingle()

  if (bErr || !bindingData) {
    return NextResponse.json({ error: 'Geen sheet-koppeling gevonden' }, { status: 404 })
  }
  const binding = bindingData as ProjectGoogleSheet
  // Canonieke callerId komt uit de binding zelf. Zo werkt de rest van
  // de flow (call_center lookup, upload-insert) identiek voor zowel
  // binding_id- als caller_id-based invocations.
  const resolvedCallerId = binding.caller_id

  const { data: projectData } = await sb
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()
  const project = projectData as Project | null
  if (!project) {
    return NextResponse.json({ error: 'Project niet gevonden' }, { status: 404 })
  }

  // ── Billing gate ────────────────────────────────────────────────────
  // Sync wordt enkel uitgevoerd als het project een actief abonnement heeft
  // OF nog in trial loopt (trialing + trial_ends_at in de toekomst).
  // Cancelled / past_due / paused / verlopen-trial → 402.
  const status = project.subscription_status
  const trialOk = status === 'trialing' &&
                  project.trial_ends_at &&
                  new Date(project.trial_ends_at) > new Date()
  if (status !== 'active' && !trialOk) {
    return NextResponse.json({
      error: status === 'trialing'
        ? 'De gratis trial van dit project is verlopen. Activeer een abonnement om sync te hervatten.'
        : `Project-abonnement is ${status}. Activeer een abonnement om sync te hervatten.`,
      code: 'subscription_required',
    }, { status: 402 })
  }

  const mapping = (project.last_column_mapping ?? {}) as Partial<ColumnMapping>
  if (!mapping.lead_name || !mapping.status || !mapping.call_date) {
    return NextResponse.json(
      { error: 'Project heeft nog geen mapping ingesteld. Doe eerst minstens één manuele upload op dit project zodat de kolom-mapping bekend is.' },
      { status: 400 },
    )
  }
  const customDefs: CustomFieldDef[] = project.custom_field_definitions ?? []

  const { data: ccm } = await sb
    .from('call_center_members')
    .select('call_center_id')
    .eq('profile_id', resolvedCallerId)
    .maybeSingle()
  const callCenterId = (ccm as { call_center_id: string } | null)?.call_center_id
  if (!callCenterId) {
    return NextResponse.json({ error: 'Caller is geen lid van een call_center' }, { status: 400 })
  }

  let accessToken: string
  try {
    if (!binding.created_by) throw new Error('Binding heeft geen created_by')
    accessToken = await getValidAccessToken(binding.created_by)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    await sb.from('project_google_sheets')
      .update({ last_sync_status: 'error', last_sync_error: `Auth: ${msg}` })
      .eq('id', binding.id)
    return NextResponse.json({ error: `Google auth mislukt: ${msg}` }, { status: 500 })
  }

  let rows: Record<string, string>[]
  try {
    rows = await fetchSheetRows(accessToken, binding.spreadsheet_id, binding.sheet_name)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    await sb.from('project_google_sheets')
      .update({ last_sync_status: 'error', last_sync_error: `Fetch: ${msg}` })
      .eq('id', binding.id)
    return NextResponse.json({ error: `Sheet ophalen mislukt: ${msg}` }, { status: 500 })
  }

  if (rows.length === 0) {
    await sb.from('project_google_sheets')
      .update({
        last_sync_status: 'no_changes',
        last_sync_error: null,
        last_synced_at: new Date().toISOString(),
      })
      .eq('id', binding.id)
    return NextResponse.json({ ok: true, imported: 0, message: 'Sheet is leeg' })
  }

  // GEEN vroege upload-insert meer — we maken pas uploads NA het parsen
  // van de records, één per (caller, call_date). Zo hoort een backfill
  // van vorige week semantisch in de juiste week op het dashboard i.p.v.
  // alles onder de sync-datum. Zelfde patroon als de Lemlist-sync.

  type AppointmentMetaUpdate = {
    external_id: string
    dealstage_raw: string | null
    sales_rep_name: string | null
  }
  const metaUpdates: AppointmentMetaUpdate[] = []
  let parsedTotal = 0
  let mismatchTotal = 0

  // We importeren ENKEL leads van vandaag (records). Oudere afspraken die nog
  // niet in call_records staan worden NIET geïmporteerd — anders trekken we
  // bij de eerste sync alle historische afspraken alsnog binnen, met dubbele
  // call-tellingen tot gevolg.
  //
  // Pass 2 (RPC bulk_update_dealstage hieronder) updatet wel dealstage_raw
  // en raw_sales_rep_name op call_records die WEL al bestaan. Zo blijft de
  // dealstage van bestaande afspraken dagelijks gesynchroniseerd zonder dat
  // we nieuwe records aanmaken.

  const records = rows
    .map(row => {
      const parsedDate = mapping.call_date ? parseRowDate(row[mapping.call_date]) : null

      const rowStatus = mapping.status ? String(row[mapping.status] ?? '') : ''
      const isAppointmentRow = /afspraak|appointment/i.test(rowStatus)

      const rawExt = mapping.external_id ? row[mapping.external_id] : null
      const externalId = rawExt != null && String(rawExt).trim() !== ''
        ? String(rawExt).trim()
        : null

      // Sales_rep blijft uit de sheet komen (sales_rep matching is een
      // CallScope-feature voor lead-toewijzing). Dealstage wordt sinds
      // 2026-05-04 NIET meer uit sheets gelezen — komt via HubSpot of
      // manueel via de sales rep op /dashboard/appointments.
      let salesRepRaw: string | null = null
      if (isAppointmentRow && mapping.sales_rep) {
        const v = row[mapping.sales_rep]
        if (v != null && String(v).trim() !== '') {
          salesRepRaw = String(v).trim()
        }
      }
      if (isAppointmentRow && externalId) {
        metaUpdates.push({
          external_id:    externalId,
          dealstage_raw:  null,            // niet meer uit sheet — bron is HubSpot
          sales_rep_name: salesRepRaw,
        })
      }

      if (!parsedDate) return null
      parsedTotal++

      // Bouw de record-payload (één keer, voor zowel today als historical).
      const cf: CustomFieldsBag = {}
      for (const def of customDefs) {
        const col = (mapping as Record<string, string | undefined>)[def.key] ??
                    Object.keys(row).find(k => k.toLowerCase() === def.label.toLowerCase()) ??
                    Object.keys(row).find(k => k.toLowerCase() === def.key.toLowerCase())
        if (col) {
          cf[def.key] = coerceCustomValue(row[col], def.type)
        }
      }

      // Email + telefoon uit standaard kolommen (sinds 2026-05-04 niet meer
      // in custom_fields). Email lowercase voor consistente lookup.
      const emailRaw = mapping.email ? row[mapping.email] : null
      const phoneRaw = mapping.phone ? row[mapping.phone] : null
      const email = emailRaw && String(emailRaw).trim() !== ''
        ? String(emailRaw).trim().toLowerCase()
        : null
      const phone = phoneRaw && String(phoneRaw).trim() !== ''
        ? String(phoneRaw).trim()
        : null

      // upload_id wordt pas later toegewezen — één upload per call_date.
      const record = {
        project_id:       projectId,
        external_id:      externalId,
        lead_name:        mapping.lead_name        ? row[mapping.lead_name]        ?? null : null,
        email,
        phone,
        status:           mapping.status           ? row[mapping.status]           ?? null : null,
        notes:            mapping.notes            ? row[mapping.notes]            ?? null : null,
        call_date:        parsedDate,
        duration_seconds: mapping.duration_seconds ? Number(row[mapping.duration_seconds]) || null : null,
        custom_fields:    cf,
        // dealstage_raw niet meer uit sheets — komt enkel via HubSpot of manuele input
        raw_sales_rep_name:   salesRepRaw,
      }

      // Filter: alleen rijen binnen het gevraagde datum-window importeren.
      // Default = enkel vandaag (backwards compat). Bij een `from_date`/
      // `to_date` van bv. vorige week ma-vr worden die 5 dagen ook binnen-
      // getrokken.
      if (parsedDate >= fromDate && parsedDate <= toDate) {
        return record
      }

      // Buiten window → niet importeren. Pass 2 zorgt voor dealstage-update
      // op bestaande call_records (via metaUpdates die we hierboven al verzamelden).
      mismatchTotal++
      return null
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  type RepResolver = Map<string, string | 'ambiguous'>
  async function buildSalesRepResolver(): Promise<RepResolver> {
    const resolver: RepResolver = new Map()
    if (!mapping.sales_rep) return resolver
    const { data: members } = await sb
      .from('project_members')
      .select('profile_id, role, profiles:profiles!inner(id, full_name)')
      .eq('project_id', projectId)
      .in('role', ['sales_rep', 'sales_manager'])
    if (!members) return resolver

    type Row = { profile_id: string; full_name: string }
    const reps: Row[] = []
    for (const m of members as unknown as Array<{ profile_id: string; profiles: { full_name: string } | { full_name: string }[] }>) {
      const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
      if (p?.full_name) reps.push({ profile_id: m.profile_id, full_name: p.full_name })
    }

    function add(key: string, profileId: string) {
      const k = key.toLowerCase().trim()
      if (!k) return
      const existing = resolver.get(k)
      if (existing === undefined) {
        resolver.set(k, profileId)
      } else if (existing !== profileId) {
        resolver.set(k, 'ambiguous')
      }
    }

    for (const r of reps) {
      add(r.full_name, r.profile_id)
      const first = r.full_name.split(/\s+/)[0]
      if (first) add(first, r.profile_id)
    }
    return resolver
  }

  async function applyAppointmentMetaUpdates(): Promise<{
    updated: number
    pairs: number
    repAssigned: number
    repFromName: number
    repFromDefault: number
    repUnassignable: number
  }> {
    if (metaUpdates.length === 0) {
      return { updated: 0, pairs: 0, repAssigned: 0, repFromName: 0, repFromDefault: 0, repUnassignable: 0 }
    }
    const dedupe = new Map<string, AppointmentMetaUpdate>()
    for (const u of metaUpdates) {
      dedupe.set(u.external_id, u)
    }
    const pairs = Array.from(dedupe.values())

    // bulk_update_dealstage werd hier vroeger aangeroepen om dealstage_raw te
    // syncen vanuit Google Sheets. Sinds 2026-05-04 komt dealstage uitsluitend
    // via HubSpot of manuele rep-feedback, dus we slaan deze RPC over om te
    // vermijden dat we per ongeluk HubSpot-dealstages overschrijven met null.
    const updated = 0

    let repAssigned = 0, repFromName = 0, repFromDefault = 0, repUnassignable = 0
    const resolver = await buildSalesRepResolver()
    const defaultRepId = project?.default_sales_rep_id ?? null

    const repPairs: { external_id: string; sales_rep_id: string }[] = []
    for (const u of pairs) {
      let resolved: string | null = null
      if (u.sales_rep_name) {
        const key = u.sales_rep_name.toLowerCase().trim()
        const match = resolver.get(key)
        if (match && match !== 'ambiguous') {
          resolved = match
          repFromName++
        }
      }
      if (!resolved && defaultRepId) {
        resolved = defaultRepId
        repFromDefault++
      }
      if (resolved) {
        repPairs.push({ external_id: u.external_id, sales_rep_id: resolved })
      } else {
        repUnassignable++
      }
    }

    if (repPairs.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rd, error: rErr } = await (sb as any).rpc('bulk_assign_sales_rep', {
        p_project_id: projectId,
        p_pairs:      repPairs,
      })
      if (rErr) {
        console.error('[google-sync] bulk_assign_sales_rep:', rErr)
      } else {
        repAssigned = typeof rd === 'number' ? rd : 0
      }
    }

    return {
      updated, pairs: pairs.length,
      repAssigned, repFromName, repFromDefault, repUnassignable,
    }
  }

  if (records.length === 0) {
    // Niks te importeren binnen het window — draai enkel Pass 2 voor
    // eventuele dealstage/rep-updates op bestaande rijen.
    const metaResult = await applyAppointmentMetaUpdates()

    if (metaResult.updated > 0) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
      if (baseUrl) {
        fetch(`${baseUrl}/api/projects/${projectId}/classify-dealstages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}` },
        }).catch(err => console.error('[google-sync] classify trigger:', err))
      }
    }

    await sb.from('project_google_sheets')
      .update({
        last_sync_status: metaResult.updated > 0 ? 'ok' : 'no_changes',
        last_sync_error:  null,
        last_synced_at:   new Date().toISOString(),
      })
      .eq('id', binding.id)
    const rangeLabel = fromDate === toDate ? fromDate : `${fromDate} → ${toDate}`
    return NextResponse.json({
      ok:       true,
      imported: 0,
      message:  parsedTotal === 0
        ? 'Geen rijen met geldige call_date gevonden'
        : `Geen leads met contactdatum in ${rangeLabel} (${mismatchTotal} rijen buiten window genegeerd)`,
      window:           { from: fromDate, to: toDate },
      mismatched:       mismatchTotal,
      dealstageUpdated: metaResult.updated,
      dealstagePairs:   metaResult.pairs,
      repAssigned:      metaResult.repAssigned,
      repFromName:      metaResult.repFromName,
      repFromDefault:   metaResult.repFromDefault,
      repUnassignable:  metaResult.repUnassignable,
    })
  }

  // Groepeer records per call_date → per dag komt er één upload met
  // `uploaded_at = die dag om 12:00 UTC`. Zo valt een backfill van vorige
  // week semantisch in de vorige-week-filter op het dashboard, i.p.v. in
  // de dag van de sync.
  const recordsByDay = new Map<string, typeof records>()
  for (const r of records) {
    const arr = recordsByDay.get(r.call_date) ?? []
    arr.push(r)
    recordsByDay.set(r.call_date, arr)
  }

  let imported = 0
  const createdUploadIds: string[] = []
  for (const [callDate, dayRecords] of recordsByDay) {
    // Dedup binnen dag op (external_id, call_date). Postgres weigert
    // ON CONFLICT-batches waar dezelfde (project_id, external_id, call_date)
    // 2x voorkomt. Records zonder external_id blijven ongemoeid (NULL ≠ NULL).
    const dedupedRecords: typeof dayRecords = []
    const withIdSeen = new Map<string, number>()
    for (const r of dayRecords) {
      if (r.external_id == null) { dedupedRecords.push(r); continue }
      const key = r.external_id
      const idx = withIdSeen.get(key)
      if (idx === undefined) { withIdSeen.set(key, dedupedRecords.length); dedupedRecords.push(r) }
      else                   { dedupedRecords[idx] = r }
    }

    // Upload per (caller, dag)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploadInsert: any = {
      project_id:     projectId,
      caller_id:      resolvedCallerId,
      call_center_id: callCenterId,
      filename:       `${binding.sheet_name} — ${callDate}`,
      tool:           'google_sheets',
      status:         'processing',
      uploaded_at:    `${callDate}T12:00:00.000Z`,
    }
    const { data: dayUpload, error: dayUpErr } = await sb.from('uploads')
      .insert(uploadInsert).select().single()
    if (dayUpErr || !dayUpload) {
      console.warn(`[google-sync] upload-insert faalde voor ${callDate}:`, dayUpErr?.message)
      continue
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dayUploadId = (dayUpload as any).id as string

    // Records krijgen nu upload_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withUpload = dedupedRecords.map(r => ({ ...r, upload_id: dayUploadId })) as any[]

    let dayImported = 0
    for (let i = 0; i < withUpload.length; i += 500) {
      const batch = withUpload.slice(i, i + 500)
      const { error: recErr } = await sb.from('call_records')
        .upsert(batch, { onConflict: 'project_id,external_id,call_date' })
      if (recErr) {
        await sb.from('uploads').update({ status: 'error' }).eq('id', dayUploadId)
        console.warn(`[google-sync] upsert error ${callDate}:`, recErr.message)
      } else {
        dayImported += batch.length
      }
    }
    imported += dayImported
    await sb.from('uploads').update({ status: 'done' }).eq('id', dayUploadId)
    createdUploadIds.push(dayUploadId)
  }

  const metaResult = await applyAppointmentMetaUpdates()

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  if (baseUrl) {
    // AI-analyse per aangemaakte upload (per dag).
    for (const upId of createdUploadIds) {
      fetch(`${baseUrl}/api/analyse`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
        },
        body: JSON.stringify({ uploadId: upId }),
      }).catch(err => console.error('[google-sync] analyse trigger:', err))
    }

    // Dealstage-classificatie enkel triggeren als de meta-updates (uit HubSpot
    // of manuele sheet-updates) iets hebben aangepast. Sheets zetten geen
    // dealstage_raw meer sinds 2026-05-04.
    if (metaResult.updated > 0) {
      fetch(`${baseUrl}/api/projects/${projectId}/classify-dealstages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}` },
      }).catch(err => console.error('[google-sync] classify trigger:', err))
    }
  }

  await sb.from('project_google_sheets')
    .update({
      last_sync_status: 'ok',
      last_sync_error:  null,
      last_synced_at:   new Date().toISOString(),
    })
    .eq('id', binding.id)

  return NextResponse.json({
    ok: true,
    imported,
    totalRows:       rows.length,
    window:          { from: fromDate, to: toDate },
    uploadsCreated:  createdUploadIds.length,
    mismatched:      mismatchTotal,
    dealstageUpdated: metaResult.updated,
    dealstagePairs:   metaResult.pairs,
    repAssigned:      metaResult.repAssigned,
    repFromName:      metaResult.repFromName,
    repFromDefault:   metaResult.repFromDefault,
    repUnassignable:  metaResult.repUnassignable,
  })
}
