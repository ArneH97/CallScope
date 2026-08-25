import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

/**
 * GET /api/projects/[id]/template
 *
 * Genereert een per-project xlsx-template die naadloos aansluit bij de
 * Google Sheets sync. Bevat:
 *   - Tab "Leads" — kolomkoppen die exact matchen wat de sync verwacht.
 *     Het Uniek-ID label en de custom fields van het project zijn ingevuld.
 *   - Tab "Instructies" — uitleg hoe de sheet te koppelen.
 *   - Tab "Voorbeelden" — geldige waardes voor Status / Dealstage en de
 *     namen van de sales reps die op dit project staan (gebruik die exacte
 *     naam in de "Sales rep"-kolom voor automatische toewijzing).
 *
 * Toegang: enkel project-leden (cc_manager via call_centers, of expliciet
 * project_member). Service-role wordt enkel gebruikt voor de read na de
 * auth-check.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = params.id
  if (!projectId) {
    return NextResponse.json({ error: 'project_id ontbreekt' }, { status: 400 })
  }

  // ── Auth: gebruiker moet bij dit project horen ──────────────────────────
  const sb = createSbClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
  }

  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Heeft de user toegang tot dit project? Drie paden:
  //   - cc_manager van het call_center dat aan project hangt
  //   - sales_manager / sales_rep / cold_caller via project_members
  const { data: pm } = await sbAdmin
    .from('project_members')
    .select('id')
    .eq('project_id', projectId)
    .eq('profile_id', user.id)
    .maybeSingle()

  let hasAccess = !!pm
  if (!hasAccess) {
    const { data: ccLink } = await sbAdmin
      .from('project_call_centers')
      .select('call_centers!inner(manager_id)')
      .eq('project_id', projectId)
      .maybeSingle()
    type CCLink = { call_centers: { manager_id: string } | { manager_id: string }[] | null }
    const link = ccLink as CCLink | null
    const cc = Array.isArray(link?.call_centers) ? link?.call_centers[0] : link?.call_centers
    hasAccess = cc?.manager_id === user.id
  }
  if (!hasAccess) {
    return NextResponse.json({ error: 'Geen toegang tot dit project' }, { status: 403 })
  }

  // ── Project + custom fields + sales reps ophalen ────────────────────────
  const { data: project } = await sbAdmin
    .from('projects')
    .select('id, name, unique_id_label, custom_field_definitions')
    .eq('id', projectId)
    .single()

  type ProjLite = {
    id: string
    name: string
    unique_id_label: string | null
    custom_field_definitions: { key: string; label: string; type: string }[] | null
  }
  const proj = project as ProjLite | null
  if (!proj) {
    return NextResponse.json({ error: 'Project niet gevonden' }, { status: 404 })
  }

  // Sales reps + sales managers van dit project — de namen komen in de
  // Voorbeelden-tab te staan zodat cold callers exact die spelling gebruiken.
  const { data: reps } = await sbAdmin
    .from('project_members')
    .select('role, profiles!inner(full_name)')
    .eq('project_id', projectId)
    .in('role', ['sales_rep', 'sales_manager'])

  type RepRow = { role: string; profiles: { full_name: string | null } | { full_name: string | null }[] | null }
  const repRows = (reps ?? []) as unknown as RepRow[]
  const salesReps: string[] = repRows
    .map(r => {
      const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles
      return p?.full_name ?? null
    })
    .filter((n): n is string => !!n)

  // ── Workbook bouwen ─────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new()

  // Vaste kolomnamen die de sync auto-mapt (case-insensitive in de sync zelf).
  // Volgorde is bewust: eerst identificatie, dan contact, dan call-data, dan
  // afspraak/dealstage, dan custom fields op het einde.
  // Dealstage staat NIET meer in de template — sinds 2026-05-04 komt dealstage
  // ofwel automatisch uit HubSpot (per afspraak match), ofwel typt de sales rep
  // de feedback in CallScope. Cold callers hoeven dus niets meer over dealstages
  // bij te houden in hun sheet.
  const standardCols = [
    'Naam', 'Bedrijf', 'Telefoon', 'Email', 'Status', 'Notities',
    'Belmoment', 'Sales rep', 'Afspraakdatum',
  ]
  const customFieldHeaders = (proj.custom_field_definitions ?? []).map(f => f.label)

  // Het project's `unique_id_label` kan botsen met een van de standaard
  // kolomnamen (bv. iemand die zijn unieke-ID kolom "mail" of "Email" noemde
  // botst dan met onze vaste "Email"-kolom → twee email-headers in de sheet).
  // We detecteren bekende aliassen + exacte (case-insensitive) matches en
  // vallen in dat geval terug op een neutraal "Uniek ID".
  const rawLabel = (proj.unique_id_label ?? '').trim()
  const labelLower = rawLabel.toLowerCase()
  const aliasMap: Record<string, string> = {
    'mail': 'Email', 'e-mail': 'Email', 'email': 'Email', 'emailadres': 'Email',
    'naam': 'Naam', 'voornaam': 'Naam', 'achternaam': 'Naam', 'name': 'Naam',
    'bedrijf': 'Bedrijf', 'company': 'Bedrijf', 'firma': 'Bedrijf',
    'telefoon': 'Telefoon', 'phone': 'Telefoon', 'tel': 'Telefoon', 'gsm': 'Telefoon',
    'status': 'Status', 'notities': 'Notities', 'notes': 'Notities',
  }
  const collidesWith =
    aliasMap[labelLower] ??
    standardCols.find(c => c.toLowerCase() === labelLower)
  const uniqueIdHeader = rawLabel && !collidesWith ? rawLabel : 'Uniek ID'

  const headers: string[] = [
    uniqueIdHeader,
    ...standardCols,
    ...customFieldHeaders,
  ]

  // ── Tab 1: Leads ────────────────────────────────────────────────────────
  // Eerste rij = headers, daarna 3 voorbeeldrijen, daarna leeg.
  const leadsAOA: (string | number | null)[][] = [
    headers,
    ['L-001', 'Sophie Janssen', 'Acme Bakkerij', '+32 472 12 34 56', 'sophie@acme.be',
     'Afspraak gemaakt', 'Geïnteresseerd in pakket Pro, vraagt offerte', '2026-05-04 10:30',
     salesReps[0] ?? '(naam sales rep)', '2026-05-08 14:00',
     ...customFieldHeaders.map(() => '')],
    ['L-002', 'Jonas Peeters', 'Peeters BV', '+32 478 98 76 54', 'jonas@peeters.be',
     'Niet bereikt', 'Voicemail ingesproken, terugbelafspraak', '2026-05-04 11:15',
     '', '',
     ...customFieldHeaders.map(() => '')],
    ['L-003', 'Marie De Smet', 'De Smet & Co', '+32 489 11 22 33', 'marie@desmet.be',
     'Geen interesse', 'Heeft al leverancier, niet open voor wissel', '2026-05-04 11:42',
     '', '',
     ...customFieldHeaders.map(() => '')],
    // 200 lege rijen als ruimte voor de cold caller
    ...Array.from({ length: 200 }, () => headers.map(() => '')),
  ]
  const leadsWS = XLSX.utils.aoa_to_sheet(leadsAOA)

  // Kolombreedtes — ruim genoeg voor leesbaarheid
  leadsWS['!cols'] = headers.map(h => {
    if (h === 'Notities') return { wch: 50 }
    if (h === 'Naam' || h === 'Bedrijf') return { wch: 24 }
    if (h === 'Email') return { wch: 28 }
    if (h === 'Telefoon') return { wch: 18 }
    if (h === 'Belmoment' || h === 'Afspraakdatum') return { wch: 18 }
    return { wch: Math.max(14, h.length + 2) }
  })

  // Bevries de header-rij zodat hij meescrolt
  leadsWS['!freeze'] = { xSplit: 0, ySplit: 1 }
  // SheetJS gebruikt '!margins' niet voor freeze — !sheetView is de juiste
  // SheetJS Community Edition heeft beperkte freeze-support, maar Google
  // Sheets respecteert de pane-info uit de XLSX die wij genereren via:
  if (!leadsWS['!sheetView']) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(leadsWS as any)['!sheetView'] = [{ pane: { ySplit: 1, topLeftCell: 'A2', state: 'frozen' } }]
  }

  XLSX.utils.book_append_sheet(wb, leadsWS, 'Leads')

  // ── Tab 2: Instructies ──────────────────────────────────────────────────
  const instructionsAOA: (string | number | null)[][] = [
    [`CallScope template — ${proj.name}`],
    [],
    ['Hoe gebruik je deze sheet?'],
    ['1.', 'Open Google Drive en upload deze .xlsx → Open met Google Spreadsheets.'],
    ['2.', 'Vul tijdens het bellen de tab "Leads" in. Eén rij per lead.'],
    ['3.', 'Geef je manager de link naar deze Google Sheet.'],
    ['4.', 'Hij koppelt hem in CallScope (Project-instellingen → Google Sheets sync).'],
    ['5.', 'Vanaf dan synchroniseert CallScope dagelijks automatisch.'],
    [],
    ['Hoe vul je het juist in?'],
    [`• Uniek ID (kolom "${uniqueIdHeader}")`, 'Verplicht. Mag een eigen format zijn (L-001, AB-2026-001, …) zolang het uniek is binnen dit project.'],
    ['• Naam', 'Volledige naam van de lead. Verplicht.'],
    ['• Status', 'Gebruik EXACT één van de waardes uit de tab "Voorbeelden" (Niet bereikt, Terugbellen, Geen interesse, Afspraak gemaakt, Verkeerd nummer, Voicemail).'],
    ['• Sales rep', 'Volledige naam van de sales rep die de afspraak overneemt. Zie tab "Voorbeelden" voor de exacte spelling van de reps op dit project.'],
    ['• Belmoment / Afspraakdatum', 'Datum + tijd in het formaat 2026-05-04 10:30 (jaar-maand-dag uur:minuut).'],
    [],
    ['Wat met de dealstage?'],
    ['', 'Cold callers vullen GEEN dealstage in deze sheet — die wordt ofwel automatisch uit HubSpot gehaald (door de sales manager te koppelen), ofwel manueel ingevuld door de sales rep in CallScope na de afspraak.'],
    [],
    ['Belangrijk:'],
    ['•', 'Verwijder NIET de header-rij bovenaan tab "Leads".'],
    ['•', 'Voeg gerust extra kolommen toe voor eigen notities — CallScope negeert die.'],
    ['•', 'Wijzigingen in oude rijen worden bij elke sync overgenomen.'],
  ]
  const instructionsWS = XLSX.utils.aoa_to_sheet(instructionsAOA)
  instructionsWS['!cols'] = [{ wch: 32 }, { wch: 90 }]
  XLSX.utils.book_append_sheet(wb, instructionsWS, 'Instructies')

  // ── Tab 3: Voorbeelden — geldige waardes ────────────────────────────────
  const validStatuses = [
    'Niet bereikt',
    'Terugbellen',
    'Geen interesse',
    'Afspraak gemaakt',
    'Verkeerd nummer',
    'Voicemail',
  ]

  const examplesAOA: (string | number | null)[][] = [
    ['Geldige waardes voor de "Status"-kolom'],
    ['Gebruik deze exact zoals ze hier staan (hoofdletters maken niet uit, spelling wel).'],
    [],
    ...validStatuses.map(s => [s]),
    [],
    [],
    ['Sales reps op dit project'],
    ['Gebruik exact deze schrijfwijze in de "Sales rep"-kolom om automatische toewijzing te krijgen.'],
    [],
    ...(salesReps.length > 0
      ? salesReps.map(n => [n])
      : [['(nog geen sales reps toegevoegd — vraag je manager om eerst leden uit te nodigen)']]),
  ]
  const examplesWS = XLSX.utils.aoa_to_sheet(examplesAOA)
  examplesWS['!cols'] = [{ wch: 60 }]
  XLSX.utils.book_append_sheet(wb, examplesWS, 'Voorbeelden')

  // ── Naar buffer en respond ──────────────────────────────────────────────
  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  // Bestandsnaam — sanitize zodat hij OS-veilig is
  const safeName = proj.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'project'
  const filename = `CallScope template - ${safeName}.xlsx`

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
