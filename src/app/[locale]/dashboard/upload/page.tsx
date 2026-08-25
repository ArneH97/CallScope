'use client'

import { useState, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { ColumnMapping, CustomFieldDef, CustomFieldType, CustomFieldsBag, CustomFieldValue } from '@/types/database'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'

/** Maakt een stabiele interne key uit een vrij label. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'field'
}

/**
 * Slim parser voor numerieke waardes met BE/EU-stijl notatie.
 * Bepaalt zelf welke separator decimaal is en welke duizendtal:
 *   - Beide aanwezig (. en ,) → de laatst voorkomende is de decimaal
 *   - Alleen één type met meerdere instances → allemaal duizendtal
 *   - Alleen één type met één instance:
 *     - 3 digits erna → duizendtal (bv. "1.000" → 1000)
 *     - anders        → decimaal   (bv. "20.20" → 20.20, "20,5" → 20.5)
 * Symbolen (€, $, spaties) worden gestript.
 */
function parseEuropeanNumber(raw: string): number | null {
  // Strip alles behalve digits, dots, commas en min-teken
  const cleaned = raw.replace(/[^\d.,-]/g, '')
  if (!cleaned) return null

  const hasDot   = cleaned.includes('.')
  const hasComma = cleaned.includes(',')
  let normalized: string

  if (hasDot && hasComma) {
    const lastDot   = cleaned.lastIndexOf('.')
    const lastComma = cleaned.lastIndexOf(',')
    if (lastDot > lastComma) {
      // dot is decimaal, comma is duizendtal
      normalized = cleaned.replace(/,/g, '')
    } else {
      // comma is decimaal, dot is duizendtal
      normalized = cleaned.replace(/\./g, '').replace(',', '.')
    }
  } else if (hasComma) {
    const commaCount = (cleaned.match(/,/g) ?? []).length
    if (commaCount > 1) {
      // Meerdere comma's = allemaal duizendtal
      normalized = cleaned.replace(/,/g, '')
    } else {
      // Enkele comma — kijk naar # digits erna
      const idx = cleaned.lastIndexOf(',')
      const digitsAfter = cleaned.length - idx - 1
      normalized = digitsAfter === 3
        ? cleaned.replace(',', '')   // duizendtal: "1,000" → 1000
        : cleaned.replace(',', '.')  // decimaal: "20,20" → 20.20
    }
  } else if (hasDot) {
    const dotCount = (cleaned.match(/\./g) ?? []).length
    if (dotCount > 1) {
      // Meerdere dots = allemaal duizendtal
      normalized = cleaned.replace(/\./g, '')
    } else {
      // Enkele dot — kijk naar # digits erna
      const idx = cleaned.lastIndexOf('.')
      const digitsAfter = cleaned.length - idx - 1
      normalized = digitsAfter === 3
        ? cleaned.replace('.', '')   // duizendtal: "1.000" → 1000
        : cleaned                     // decimaal: "20.20" blijft 20.20
    }
  } else {
    normalized = cleaned
  }

  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

/**
 * Coercion van een raw-cell waarde naar het juiste type voor opslag.
 * - text/category: string trim, leeg → null
 * - number:        BE/EU-aware parsing via parseEuropeanNumber
 * - date:          parseRowDate (ISO YYYY-MM-DD), null bij invalid
 */
function coerceCustomValue(raw: unknown, type: CustomFieldType): CustomFieldValue {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '') return null

  if (type === 'number') {
    return parseEuropeanNumber(s)
  }
  if (type === 'date') {
    return parseRowDate(s)
  }
  return s
}

const CUSTOM_FIELD_TYPES: { value: CustomFieldType; label: string; help: string }[] = [
  { value: 'text',     label: 'Tekst',      help: 'Vrije tekst (notities, namen, ...)' },
  { value: 'number',   label: 'Nummer',     help: 'Bv. dealwaarde, score, aantal — wordt gesommeerd in dashboards' },
  { value: 'date',     label: 'Datum',      help: 'Datum-veld (bv. afspraakdatum, deadline)' },
  { value: 'category', label: 'Categorie',  help: 'Bv. bron, branche, event-type — distributie in dashboards' },
]

const MAX_CUSTOM_FIELDS = 3

type Step = 'upload' | 'mapping' | 'confirm'

const TOOLS = [
  { value: 'aircall',  label: 'Aircall' },
  { value: 'hubspot',  label: 'HubSpot' },
  { value: 'lemlist',  label: 'Lemlist' },
  { value: 'ringover', label: 'Ringover' },
  { value: 'andere',   label: 'Andere' },
]

const REQUIRED_FIELDS: { key: keyof ColumnMapping; label: string; required: boolean; help?: string }[] = [
  { key: 'lead_name',        label: 'Naam lead',           required: true },
  { key: 'external_id',      label: 'Uniek ID',            required: false, help: 'Bv. telefoonnummer of een ID-kolom. Zorgt dat dezelfde lead bij een volgende upload herkend wordt.' },
  { key: 'email',            label: 'E-mailadres',         required: false, help: 'Aanrader — gebruikt voor HubSpot-lookup en deduplicatie. Zonder email kan de HubSpot-integratie geen deals matchen.' },
  { key: 'phone',            label: 'Telefoonnummer',      required: false, help: 'Optioneel — fallback als email leeg is bij HubSpot-lookup, en handig voor contact in de UI.' },
  { key: 'status',           label: 'Status / uitkomst',   required: true },
  { key: 'call_date',        label: 'Datum gesprek',       required: true },
  { key: 'notes',            label: 'Notities (AI)',       required: false },
  { key: 'duration_seconds', label: 'Duur (seconden)',     required: false },
  // Dealstage is GEEN mappable kolom meer (sinds 2026-05-04). Dealstages
  // komen ofwel via HubSpot (per afspraak match), ofwel manueel via de sales
  // rep op /dashboard/appointments. Cold callers houden geen dealstages bij.
  { key: 'sales_rep',        label: 'Sales rep',           required: false, help: 'Optioneel — naam van de sales rep die de afspraak doet (bv. voornaam). CallScope mapt automatisch op de gebruiker uit het projectteam zodat hij/zij de afspraak in zijn dashboard ziet.' },
]

/**
 * Parseert een datum-string of -nummer uit een upload-bestand naar een ISO-datum (YYYY-MM-DD).
 */
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

  const fallback = new Date(s)
  if (!Number.isNaN(fallback.getTime())) {
    return fallback.toISOString().slice(0, 10)
  }
  return null
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function UploadPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('upload')
  // Tool blijft als veld op uploads voor backwards-compat — defaulted naar
  // 'andere' aangezien de tool-keuze stap uit de UI is verwijderd.
  const [tool] = useState('andere')
  const [file, setFile] = useState<File | null>(null)
  const [rawData, setRawData] = useState<Record<string, string>[]>([])
  const [columns, setColumns] = useState<string[]>([])
  const [mapping, setMapping] = useState<ColumnMapping>({
    lead_name: '',
    email: '',
    phone: '',
    status: '',
    notes: '',
    call_date: '',
    duration_seconds: '',
    external_id: '',
    dealstage: '',
    sales_rep: '',
  })
  const [projects, setProjects] = useState<{
    id: string
    name: string
    unique_id_label: string | null
    custom_field_definitions: CustomFieldDef[]
    last_column_mapping: Partial<ColumnMapping>
  }[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [callCenterId, setCallCenterId] = useState('')
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionDate, setSessionDate] = useState<string>(todayIso())
  // Wie is de cold caller voor deze upload? Voor cold_callers = altijd zichzelf.
  // Voor cc_managers: zelf of een caller uit hun call_center selecteren.
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [userRole, setUserRole] = useState<'cc_manager' | 'cold_caller' | null>(null)
  const [availableCallers, setAvailableCallers] = useState<{ id: string; name: string; isMe: boolean }[]>([])
  const [selectedCallerId, setSelectedCallerId] = useState<string>('')
  // Standaard is het Uniek-ID-veld gelockt als het project al een label heeft.
  // Gebruiker kan expliciet ontgrendelen via een "wijzig"-link.
  const [unlockUniqueId, setUnlockUniqueId] = useState(false)
  // Custom fields voor deze upload. Per veld: label + type + bron-kolom uit
  // het CSV-bestand. Max MAX_CUSTOM_FIELDS items.
  type CustomFieldRow = { label: string; type: CustomFieldType; column: string }
  const [customFields, setCustomFields] = useState<CustomFieldRow[]>([])
  const [unlockCustomFields, setUnlockCustomFields] = useState(false)

  async function loadProjectsAndCallCenter() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    setCurrentUserId(user.id)

    // Rol van de huidige user ophalen — bepaalt of de caller-picker getoond wordt.
    const { data: ownProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()
    if (ownProfile?.role === 'cc_manager' || ownProfile?.role === 'cold_caller') {
      setUserRole(ownProfile.role)
    }

    // Voor cold_callers: caller is altijd zichzelf, geen picker nodig.
    if (ownProfile?.role === 'cold_caller') {
      setSelectedCallerId(user.id)
    }

    const { data: member } = await supabase
      .from('call_center_members')
      .select('call_center_id')
      .eq('profile_id', user.id)
      .maybeSingle()

    let resolvedCallCenterId: string | null = member?.call_center_id ?? null

    // Fallback voor cc_managers (incl. freelancers): als ze geen member-rij
    // hebben maar wel manager zijn van een call_center, voeg ze daar dan toe.
    // Voor freelancers zonder call_center: maak er meteen een aan.
    if (!resolvedCallCenterId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role, is_freelance, full_name')
        .eq('id', user.id)
        .single()

      if (profile?.role === 'cc_manager') {
        const { data: existingCc } = await supabase
          .from('call_centers')
          .select('id')
          .eq('manager_id', user.id)
          .maybeSingle()

        let ccId = existingCc?.id

        // Alleen freelancers krijgen een auto-created call_center.
        // Reguliere cc_managers moeten zelf een call_center aanmaken via
        // /dashboard/projects (waar ze ook callers kunnen uitnodigen).
        if (!ccId && profile.is_freelance) {
          const { data: newCc } = await supabase
            .from('call_centers')
            .insert({ manager_id: user.id, name: profile.full_name })
            .select('id')
            .single()
          ccId = newCc?.id
        }

        if (ccId) {
          await supabase
            .from('call_center_members')
            .upsert(
              { call_center_id: ccId, profile_id: user.id },
              { onConflict: 'call_center_id,profile_id' },
            )
          resolvedCallCenterId = ccId
        }
      }
    }

    if (resolvedCallCenterId) setCallCenterId(resolvedCallCenterId)

    const { data: projectData } = await supabase
      .from('projects')
      .select('id, name, unique_id_label, custom_field_definitions, last_column_mapping')
      .order('created_at', { ascending: false })

    if (projectData) {
      const typed = projectData.map(p => ({
        id: (p as { id: string }).id,
        name: (p as { name: string }).name,
        unique_id_label: (p as { unique_id_label: string | null }).unique_id_label,
        custom_field_definitions:
          (p as { custom_field_definitions?: CustomFieldDef[] }).custom_field_definitions ?? [],
        last_column_mapping:
          (p as { last_column_mapping?: Partial<ColumnMapping> }).last_column_mapping ?? {},
      }))
      setProjects(typed)
      if (typed.length > 0) setSelectedProject(typed[0].id)
    }
  }

  /**
   * Laadt de lijst beschikbare callers voor het gekozen project.
   * Pakt expliciete cold_caller-leden uit project_members.
   */
  async function loadCallersForProject(projectId: string) {
    if (!projectId || !currentUserId) return
    const supabase = createClient()

    type MemberRow = {
      profile_id: string
      profiles: { full_name: string | null } | null
    }

    const { data: members } = await supabase
      .from('project_members')
      .select('profile_id, profiles(full_name)')
      .eq('project_id', projectId)
      .eq('role', 'cold_caller')
      .returns<MemberRow[]>()

    const seen = new Set<string>()
    const callers: { id: string; name: string; isMe: boolean }[] = []
    for (const m of (members ?? [])) {
      if (seen.has(m.profile_id)) continue
      seen.add(m.profile_id)
      callers.push({
        id: m.profile_id,
        name: m.profiles?.full_name ?? 'Onbekend',
        isMe: m.profile_id === currentUserId,
      })
    }

    // cc_managers krijgen zichzelf altijd in de lijst, ook als ze nog niet
    // expliciet als project_member staan — zodat ze "voor zichzelf" kunnen
    // uploaden zonder eerst via /dashboard/projects een rij te moeten zetten.
    if (userRole === 'cc_manager' && !seen.has(currentUserId)) {
      const { data: ownProfile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', currentUserId)
        .single()
      callers.push({
        id: currentUserId,
        name: ownProfile?.full_name ?? 'Mijzelf',
        isMe: true,
      })
    }

    callers.sort((a, b) => (a.isMe ? -1 : b.isMe ? 1 : a.name.localeCompare(b.name)))
    setAvailableCallers(callers)

    // Default-selectie:
    // - cold_caller die in de lijst staat: zichzelf
    // - cc_manager met andere callers: eerste echte caller (niet zichzelf)
    // - cc_manager zonder callers: leeg laten — UI biedt 'ik ben zelf de caller' optie
    if (userRole === 'cold_caller' && callers.some(c => c.isMe)) {
      setSelectedCallerId(currentUserId)
    } else if (callers.some(c => !c.isMe)) {
      const firstNonMe = callers.find(c => !c.isMe)
      if (firstNonMe) setSelectedCallerId(firstNonMe.id)
    } else {
      setSelectedCallerId('')
    }
  }

  // Reload callers wanneer het project wijzigt.
  useEffect(() => {
    if (selectedProject) loadCallersForProject(selectedProject)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject, currentUserId, userRole])

  // Projecten + call_center laden zodra de pagina mount.
  useEffect(() => {
    loadProjectsAndCallCenter()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function autoDetectMapping(cols: string[]) {
    const lower = cols.map(c => c.toLowerCase())
    const findCol = (keywords: string[]) =>
      cols[lower.findIndex(c => keywords.some(k => c.includes(k)))] ?? ''

    const proj = projects.find(p => p.id === selectedProject)
    const last = proj?.last_column_mapping ?? {}

    // Per veld: probeer eerst de laatst gebruikte kolom (case-insensitive match).
    // Als die niet bestaat in dit nieuwe bestand → val terug op heuristic.
    const preferLastOrFind = (key: keyof ColumnMapping, keywords: string[]) => {
      const lastCol = last[key]
      if (lastCol) {
        const match = cols.find(c => c.toLowerCase() === lastCol.toLowerCase())
        if (match) return match
      }
      return findCol(keywords)
    }

    // Als het project al een uniek-ID-kolom vastgelegd heeft → strikt op die
    // kolomnaam zoeken (exact match, case-insensitive). Anders heuristics.
    const lockedLabel = proj?.unique_id_label
    const externalIdCol = lockedLabel
      ? cols.find(c => c.toLowerCase() === lockedLabel.toLowerCase()) ?? ''
      : findCol(['telefoon', 'telefoonnummer', 'phone', 'tel', 'mobile', 'gsm', 'businessid', 'placeid', 'place_id', 'business_id', 'lead_id', 'lead id', 'unique_id'])

    setMapping({
      lead_name:        preferLastOrFind('lead_name',        ['name', 'naam', 'contact', 'lead', 'bedrijf', 'company']),
      email:            preferLastOrFind('email',            ['email', 'e-mail', 'mail', 'emailadres']),
      phone:            preferLastOrFind('phone',            ['telefoon', 'phone', 'tel', 'gsm', 'mobile', 'mobiel']),
      status:           preferLastOrFind('status',           ['status', 'outcome', 'uitkomst', 'result', 'dispositie', 'reactie']),
      notes:            preferLastOrFind('notes',            ['note', 'notit', 'comment', 'remark', 'opmerking']),
      call_date:        preferLastOrFind('call_date',        ['date', 'datum', 'tijd', 'time', 'when', 'contactdatum']),
      duration_seconds: preferLastOrFind('duration_seconds', ['duration', 'duur', 'length', 'sec']),
      external_id:      externalIdCol,
      // dealstage wordt sinds 2026-05-04 niet meer uit uploads gelezen
      dealstage:        '',
      sales_rep:        preferLastOrFind('sales_rep',        ['sales rep', 'sales_rep', 'salesrep', 'rep', 'verantwoordelijke', 'eigenaar', 'owner', 'assigned', 'toegewezen']),
    })

    // Custom fields: zo aanwezig op het project, pre-fill ze met dezelfde
    // configuratie + zoek de matchende kolom in het CSV.
    const existing = proj?.custom_field_definitions ?? []
    if (existing.length > 0) {
      const lower2 = cols.map(c => c.toLowerCase())
      setCustomFields(
        existing.slice(0, MAX_CUSTOM_FIELDS).map(def => {
          const exact = cols.find(c => c.toLowerCase() === def.label.toLowerCase()) ??
                        cols.find(c => c.toLowerCase() === def.key.toLowerCase()) ??
                        cols[lower2.findIndex(c => c.includes(def.key.toLowerCase()))] ??
                        ''
          return { label: def.label, type: def.type, column: exact }
        })
      )
    } else {
      setCustomFields([])
    }
  }

  function parseFile(f: File) {
    setError(null)
    const ext = f.name.split('.').pop()?.toLowerCase()

    if (ext === 'csv') {
      Papa.parse(f, {
        header: true,
        skipEmptyLines: true,
        complete: (result) => {
          const data = result.data as Record<string, string>[]
          setRawData(data)
          const cols = Object.keys(data[0] ?? {})
          setColumns(cols)
          autoDetectMapping(cols)
          setStep('mapping')
        },
        error: () => setError('Kon het CSV bestand niet lezen.'),
      })
    } else if (ext === 'xlsx' || ext === 'xls') {
      const reader = new FileReader()
      reader.onload = (e) => {
        const workbook = XLSX.read(e.target?.result, { type: 'binary' })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        const data = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' })
        setRawData(data)
        const cols = Object.keys(data[0] ?? {})
        setColumns(cols)
        autoDetectMapping(cols)
        setStep('mapping')
      }
      reader.readAsBinaryString(f)
    } else {
      setError('Alleen CSV of Excel bestanden zijn toegestaan.')
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) { setFile(f); parseFile(f) }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) { setFile(f); parseFile(f) }
  }

  async function triggerAnalyseWithRetry(uploadId: string, maxAttempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch('/api/analyse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        })
        if (res.ok) return true
        if (res.status >= 400 && res.status < 500) {
          const text = await res.text().catch(() => '')
          console.error(`[analyse] non-retryable ${res.status}:`, text)
          return false
        }
        console.warn(`[analyse] attempt ${attempt} failed met status ${res.status}`)
      } catch (err) {
        console.warn(`[analyse] attempt ${attempt} fout:`, err)
      }
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)))
      }
    }
    return false
  }

  async function handleSubmit() {
    if (!file) {
      setError('Geen bestand geselecteerd. Ga terug naar stap 2.')
      return
    }
    if (!selectedProject) {
      setError('Selecteer eerst een project.')
      return
    }
    if (!callCenterId) {
      setError('Geen call center gekoppeld aan jouw account. Vraag je manager om je toe te voegen aan een call center, of registreer als freelancer als je solo werkt.')
      return
    }
    if (!selectedCallerId) {
      setError('Kies voor welke cold caller deze upload is.')
      return
    }
    if (!mapping.call_date) {
      setError('Koppel eerst de "Datum gesprek" kolom om te kunnen filteren op sessiedatum.')
      return
    }
    if (!sessionDate) {
      setError('Kies een sessiedatum.')
      return
    }
    setLoading(true)
    setError(null)

    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Niet ingelogd')

      const { data: upload, error: uploadError } = await supabase
        .from('uploads')
        .insert({
          project_id: selectedProject,
          caller_id: selectedCallerId,
          call_center_id: callCenterId,
          filename: file.name,
          tool,
          status: 'processing',
        })
        .select()
        .single()

      if (uploadError || !upload) throw uploadError ?? new Error('Upload aanmaken mislukt')

      // Custom fields voorbereiden: alleen rijen met geldig label + kolom
      // worden meegenomen. Stable keys via slugify(label).
      const validCustomFields = customFields
        .filter(cf => cf.label.trim() !== '' && cf.column !== '')
        .slice(0, MAX_CUSTOM_FIELDS)
        .map(cf => ({
          key: slugify(cf.label),
          label: cf.label.trim(),
          type: cf.type,
          column: cf.column,
        }))

      // Filter rijen: alleen calls van de gekozen sessiedatum tellen.
      // Voorkomt dubbeltelling als de export meerdere call-dagen bevat.
      const records = rawData
        .map(row => {
          const parsedDate = parseRowDate(row[mapping.call_date])
          if (parsedDate !== sessionDate) return null
          // external_id: trim + leeg-string → null. Zonder geldige waarde
          // gedraagt deze rij zich als 'oud gedrag' (geen dedup).
          const rawExternal = mapping.external_id ? row[mapping.external_id] : null
          const externalId = rawExternal != null && String(rawExternal).trim() !== ''
            ? String(rawExternal).trim()
            : null

          // custom_fields opbouwen voor deze rij
          const cf: CustomFieldsBag = {}
          for (const f of validCustomFields) {
            cf[f.key] = coerceCustomValue(row[f.column], f.type)
          }

          // Sales_rep: alleen lezen voor rijen waarvan de status "afspraak" bevat.
          // Voor leads zonder afspraak heeft deze waarde geen betekenis.
          // Dealstage uit de upload is sinds 2026-05-04 niet meer ondersteund —
          // dealstages komen via HubSpot of manueel via /dashboard/appointments.
          const rowStatus = mapping.status ? String(row[mapping.status] ?? '') : ''
          const isAppointmentRow = /afspraak|appointment/i.test(rowStatus)
          let salesRepRaw: string | null = null
          if (isAppointmentRow && mapping.sales_rep) {
            const v = row[mapping.sales_rep]
            if (v != null && String(v).trim() !== '') {
              salesRepRaw = String(v).trim()
            }
          }

          // Email en phone uit standaard kolommen extraheren (whitespace strippen,
          // lege strings naar null mappen). Email lowercase voor consistente lookup.
          const emailRaw = mapping.email ? row[mapping.email] : null
          const phoneRaw = mapping.phone ? row[mapping.phone] : null
          const email = emailRaw && String(emailRaw).trim() !== ''
            ? String(emailRaw).trim().toLowerCase()
            : null
          const phone = phoneRaw && String(phoneRaw).trim() !== ''
            ? String(phoneRaw).trim()
            : null

          return {
            upload_id: upload.id,
            project_id: selectedProject,
            external_id: externalId,
            lead_name:        mapping.lead_name        ? row[mapping.lead_name]        ?? null : null,
            email,
            phone,
            status:           mapping.status           ? row[mapping.status]           ?? null : null,
            notes:            mapping.notes            ? row[mapping.notes]            ?? null : null,
            call_date:        parsedDate,
            duration_seconds: mapping.duration_seconds ? Number(row[mapping.duration_seconds]) || null : null,
            custom_fields:    cf,
            // dealstage_raw + dealstage_synced_at worden NIET meer uit de upload
            // geschreven — HubSpot of manuele rep-feedback zijn de enige bronnen.
            raw_sales_rep_name:   salesRepRaw,
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (records.length === 0) {
        await supabase.from('uploads').update({ status: 'error' }).eq('id', upload.id)
        throw new Error(`Geen rijen gevonden met datum ${sessionDate}. Controleer de datum-kolom of kies een andere sessiedatum.`)
      }

      // Upsert i.p.v. plain insert: combinatie (project_id, external_id, call_date)
      // is uniek (zie SQL-migratie 2026-04-29). Zelfde lead op zelfde dag opnieuw
      // uploaden → UPDATE i.p.v. duplicaat. Lege external_id (NULL) → altijd
      // INSERT (NULL ≠ NULL in unique constraints), dus geen breuk met oud
      // gedrag voor projecten zonder uniek-ID-mapping.
      for (let i = 0; i < records.length; i += 500) {
        const { error: recordsError } = await supabase
          .from('call_records')
          .upsert(records.slice(i, i + 500), {
            onConflict: 'project_id,external_id,call_date',
          })
        if (recordsError) throw recordsError
      }

      await supabase
        .from('uploads')
        .update({ status: 'done' })
        .eq('id', upload.id)

      // ── Sales rep auto-toewijzing ──────────────────────────────────────
      // Voor manuele uploads: precies dezelfde flow als de Google-sync,
      // inclusief default-rep fallback wanneer naam ontbreekt of niet matcht.
      // De RPC bulk_assign_sales_rep is SECURITY DEFINER → werkt ook vanuit
      // de browser zonder RLS-strijd.
      {
        type Member = { profile_id: string; profiles: { full_name: string } | { full_name: string }[] }
        const { data: members } = await supabase
          .from('project_members')
          .select('profile_id, role, profiles:profiles!inner(id, full_name)')
          .eq('project_id', selectedProject)
          .in('role', ['sales_rep', 'sales_manager'])

        const resolver = new Map<string, string | 'ambiguous'>()
        for (const m of (members ?? []) as unknown as Member[]) {
          const p = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
          if (!p?.full_name) continue
          const candidates = [p.full_name, p.full_name.split(/\s+/)[0]].filter(Boolean)
          for (const c of candidates) {
            const k = c.toLowerCase().trim()
            const existing = resolver.get(k)
            if (existing === undefined) resolver.set(k, m.profile_id)
            else if (existing !== m.profile_id) resolver.set(k, 'ambiguous')
          }
        }

        // Default rep ophalen — wordt gebruikt als sheet leeg of naam onbekend.
        const { data: projRow } = await supabase
          .from('projects')
          .select('default_sales_rep_id')
          .eq('id', selectedProject)
          .single()
        const defaultRepId = (projRow as { default_sales_rep_id: string | null } | null)?.default_sales_rep_id ?? null

        // Verzamel alleen afspraak-records (status bevat "afspraak") met external_id.
        const repPairs: { external_id: string; sales_rep_id: string }[] = []
        const seen = new Set<string>()
        for (const r of records) {
          const isAppt = /afspraak|appointment/i.test(String(r.status ?? ''))
          if (!isAppt || !r.external_id) continue
          if (seen.has(r.external_id)) continue

          let resolved: string | null = null
          if (r.raw_sales_rep_name) {
            const key = r.raw_sales_rep_name.toLowerCase().trim()
            const match = resolver.get(key)
            if (match && match !== 'ambiguous') resolved = match
          }
          if (!resolved && defaultRepId) resolved = defaultRepId

          if (resolved) {
            repPairs.push({ external_id: r.external_id, sales_rep_id: resolved })
            seen.add(r.external_id)
          }
        }

        if (repPairs.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: rErr } = await (supabase as any).rpc('bulk_assign_sales_rep', {
            p_project_id: selectedProject,
            p_pairs:      repPairs,
          })
          if (rErr) {
            console.error('[upload] bulk_assign_sales_rep:', rErr)
          }
        }
      }

      // Project-instellingen opslaan/updaten:
      //   - unique_id_label (label voor de uniek-ID-kolom)
      //   - custom_field_definitions (de definities van de extra velden)
      const currentProject = projects.find(p => p.id === selectedProject)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectUpdate: any = {}

      const labelChanged = mapping.external_id &&
        currentProject &&
        unlockUniqueId &&
        currentProject.unique_id_label !== mapping.external_id
      const labelEmpty = mapping.external_id && currentProject && !currentProject.unique_id_label
      if (labelEmpty || labelChanged) {
        projectUpdate.unique_id_label = mapping.external_id
      }

      // Standaard kolom-mapping onthouden voor de volgende upload op dit project
      projectUpdate.last_column_mapping = {
        lead_name:        mapping.lead_name,
        email:            mapping.email,
        phone:            mapping.phone,
        status:           mapping.status,
        notes:            mapping.notes,
        call_date:        mapping.call_date,
        duration_seconds: mapping.duration_seconds,
        external_id:      mapping.external_id,
        dealstage:        mapping.dealstage,
        sales_rep:        mapping.sales_rep,
      }

      // Custom field definities opslaan:
      //   - Eerste upload zonder bestaande defs: opslaan wat er gemapt is
      //   - Latere upload met unlock: overschrijven met de nieuwe configuratie
      const noExistingDefs = !currentProject?.custom_field_definitions || currentProject.custom_field_definitions.length === 0
      const cfDefsForSave: CustomFieldDef[] = validCustomFields.map(f => ({
        key: f.key, label: f.label, type: f.type,
      }))
      if (cfDefsForSave.length > 0 && (noExistingDefs || unlockCustomFields)) {
        projectUpdate.custom_field_definitions = cfDefsForSave
      }

      if (Object.keys(projectUpdate).length > 0) {
        await supabase
          .from('projects')
          .update(projectUpdate)
          .eq('id', selectedProject)
        setProjects(prev => prev.map(p =>
          p.id === selectedProject
            ? {
                ...p,
                unique_id_label: projectUpdate.unique_id_label ?? p.unique_id_label,
                custom_field_definitions:
                  projectUpdate.custom_field_definitions ?? p.custom_field_definitions,
                last_column_mapping:
                  projectUpdate.last_column_mapping ?? p.last_column_mapping,
              }
            : p
        ))
      }

      triggerAnalyseWithRetry(upload.id).then(async ok => {
        if (!ok) {
          console.error(`[analyse] kon niet worden gestart voor upload ${upload.id}`)
          await supabase
            .from('uploads')
            .update({ status: 'error' })
            .eq('id', upload.id)
            .then(() => {}, () => {})
        }
      })

      router.push(`/dashboard/projects`)
    } catch (err: unknown) {
      console.error('[upload] error tijdens import:', err)
      // Supabase errors zijn vaak {message, details, hint, code} — niet altijd Error instances.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any
      const message =
        (err instanceof Error && err.message) ||
        e?.message ||
        e?.details ||
        e?.hint ||
        (typeof err === 'string' ? err : null) ||
        `Er ging iets mis. Probeer opnieuw. (${JSON.stringify(err).slice(0, 200)})`
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const preview = rawData.slice(0, 3)
  const previewCols = [mapping.lead_name, mapping.status, mapping.notes].filter(Boolean)

  const dateMatch = useMemo(() => {
    if (!mapping.call_date || !sessionDate) {
      return { match: 0, mismatch: 0, invalid: 0 }
    }
    let match = 0, mismatch = 0, invalid = 0
    for (const row of rawData) {
      const parsed = parseRowDate(row[mapping.call_date])
      if (parsed === null) invalid++
      else if (parsed === sessionDate) match++
      else mismatch++
    }
    return { match, mismatch, invalid }
  }, [rawData, mapping.call_date, sessionDate])

  const steps: { key: Step; label: string }[] = [
    { key: 'upload',  label: 'Bestand' },
    { key: 'mapping', label: 'Kolommen' },
    { key: 'confirm', label: 'Bevestigen' },
  ]
  const stepIndex = steps.findIndex(s => s.key === step)

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900">Nieuwe upload</h1>
        <p className="text-sm text-gray-500 mt-1">Importeer je belresultaten in minder dan 1 minuut.</p>
      </div>

      <div className="flex items-center gap-1 sm:gap-2 mb-8 flex-wrap">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1 sm:gap-2">
            <div className={`flex items-center gap-1 sm:gap-1.5 text-xs sm:text-sm ${
              i < stepIndex  ? 'text-green-600' :
              i === stepIndex ? 'text-brand-600 font-medium' :
              'text-gray-300'
            }`}>
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs border flex-shrink-0 ${
                i < stepIndex  ? 'bg-green-50 border-green-200 text-green-600' :
                i === stepIndex ? 'bg-brand-50 border-brand-200 text-brand-600' :
                'border-gray-200 text-gray-300'
              }`}>
                {i < stepIndex ? 'X' : i + 1}
              </div>
              {s.label}
            </div>
            {i < steps.length - 1 && (
              <div className={`w-3 sm:w-8 h-px ${i < stepIndex ? 'bg-green-200' : 'bg-gray-100'}`} />
            )}
          </div>
        ))}
      </div>

      {step === 'upload' && (
        <div className="card p-6">
          <h2 className="font-medium text-gray-900 mb-4">Upload je bestand</h2>

          {projects.length > 0 && (
            <div className="mb-5">
              <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
              <select
                value={selectedProject}
                onChange={e => setSelectedProject(e.target.value)}
                className="input"
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Cold caller-picker — alleen voor cc_managers. Cold_callers uploaden altijd voor zichzelf. */}
          {userRole === 'cc_manager' && selectedProject && (
            <div className="mb-5">
              <label className="block text-sm font-medium text-gray-700 mb-1">Voor welke cold caller?</label>
              {availableCallers.length > 0 ? (
                <>
                  <select
                    value={selectedCallerId}
                    onChange={e => setSelectedCallerId(e.target.value)}
                    className="input"
                  >
                    <option value="">— kies een caller —</option>
                    {availableCallers.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.isMe ? `${c.name} (mijzelf)` : c.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    De stats en feedback worden gekoppeld aan deze caller.
                  </p>
                </>
              ) : (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
                  <p className="text-sm text-amber-800 font-medium">
                    Geen cold callers gekoppeld aan dit project.
                  </p>
                  <p className="text-xs text-amber-700">
                    Wat wil je doen?
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setSelectedCallerId(currentUserId)}
                      className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                        selectedCallerId === currentUserId
                          ? 'bg-brand-600 border-brand-600 text-white'
                          : 'bg-white border-gray-300 text-gray-700 hover:border-gray-400'
                      }`}
                    >
                      Ik ben zelf de cold caller
                    </button>
                    <a
                      href="/dashboard/projects"
                      className="text-xs px-3 py-1.5 rounded-md border border-gray-300 bg-white text-gray-700 hover:border-gray-400 transition-colors"
                    >
                      Eerst cold caller toevoegen →
                    </a>
                  </div>
                  {selectedCallerId === currentUserId && (
                    <p className="text-xs text-green-700 pt-1">
                      ✓ Deze upload wordt aan jouw account gekoppeld als cold caller.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {projects.length === 0 && (
            <div className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              Je bent nog niet toegevoegd aan een project. Vraag je call center manager om je toe te voegen.
            </div>
          )}

          <div
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-xl p-6 sm:p-10 text-center cursor-pointer transition-colors ${
              dragging ? 'border-brand-400 bg-brand-50' : 'border-gray-200 hover:border-gray-300'
            }`}
            onClick={() => document.getElementById('file-input')?.click()}
          >
            <div className="text-3xl mb-2 text-gray-300">^</div>
            <div className="text-sm font-medium text-gray-700 mb-1">Sleep je bestand hier</div>
            <div className="text-xs text-gray-400">of klik om te bladeren - CSV of Excel, max 10 MB</div>
            <input
              id="file-input"
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={handleFileInput}
            />
          </div>

          {error && (
            <p className="mt-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}

        </div>
      )}

      {step === 'mapping' && (
        <div className="card p-6">
          <h2 className="font-medium text-gray-900 mb-1">Koppel de kolommen</h2>
          <p className="text-sm text-gray-500 mb-5">
            {file?.name} - {rawData.length} rijen gevonden
          </p>

          {/* Project-lock banner: toont welke uniek-ID-kolom dit project gebruikt */}
          {(() => {
            const lockedLabel = projects.find(p => p.id === selectedProject)?.unique_id_label
            if (lockedLabel) {
              const found = columns.some(c => c.toLowerCase() === lockedLabel.toLowerCase())
              return (
                <div className={`mb-5 p-3 rounded-lg border text-sm ${found ? 'bg-blue-50 border-blue-100 text-blue-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                  <div className="flex items-start gap-2">
                    <span>{found ? '🔒' : '⚠️'}</span>
                    <div>
                      {found ? (
                        <>
                          Dit project gebruikt <strong>{lockedLabel}</strong> als unieke ID. Het veld &quot;Uniek ID&quot; hieronder is automatisch ingevuld — wijzig dit alleen als je écht weet wat je doet (kan dedup breken).
                        </>
                      ) : (
                        <>
                          Dit project gebruikt <strong>{lockedLabel}</strong> als unieke ID, maar die kolom staat <strong>niet</strong> in dit bestand. Selecteer hieronder een kolom met dezelfde waardes, of upload een bestand met een &quot;{lockedLabel}&quot; kolom.
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            }
            return null
          })()}

          <div className="space-y-3 mb-6">
            {REQUIRED_FIELDS.map(field => {
              const lockedLabel = projects.find(p => p.id === selectedProject)?.unique_id_label
              const isExternalLocked = field.key === 'external_id' && !!lockedLabel && !unlockUniqueId
              return (
                <div key={field.key}>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                    <div className="w-full sm:w-44 text-sm text-gray-700 flex-shrink-0 font-medium sm:font-normal">
                      {field.label}
                      {field.required && <span className="text-red-400 ml-0.5">*</span>}
                    </div>
                    <div className="text-gray-300 text-sm hidden sm:block">-&gt;</div>
                    <select
                      value={mapping[field.key]}
                      onChange={e => setMapping(prev => ({ ...prev, [field.key]: e.target.value }))}
                      disabled={isExternalLocked}
                      className={`input flex-1 ${isExternalLocked ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}
                    >
                      <option value="">- niet koppelen -</option>
                      {columns.map(col => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  </div>
                  {field.help && (
                    <p className="text-xs text-gray-400 mt-1 sm:ml-[12.5rem]">{field.help}</p>
                  )}
                  {field.key === 'external_id' && lockedLabel && !unlockUniqueId && (
                    <p className="text-xs text-gray-400 mt-1 sm:ml-[12.5rem]">
                      🔒 Vergrendeld op &quot;{lockedLabel}&quot;.{' '}
                      <button
                        type="button"
                        onClick={() => setUnlockUniqueId(true)}
                        className="text-amber-600 hover:text-amber-700 underline"
                      >
                        wijzig (kan dedup breken)
                      </button>
                    </p>
                  )}
                  {field.key === 'external_id' && lockedLabel && unlockUniqueId && (
                    <p className="text-xs text-amber-600 mt-1 ml-[12.5rem]">
                      ⚠️ Je wijzigt de uniek-ID-kolom — bestaande leads worden niet meer herkend en krijgen nieuwe entries. De projectinstelling wordt bijgewerkt naar de nieuwe kolom.
                    </p>
                  )}
                  {field.key === 'external_id' && !lockedLabel && !mapping.external_id && (
                    <p className="text-xs text-amber-600 mt-1 ml-[12.5rem]">
                      Zonder uniek ID kan de tool niet zien dat dezelfde lead later opnieuw gebeld is — alle rijen worden behandeld als nieuwe leads.
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── Custom velden — max 3 extra ────────────────────── */}
          {(() => {
            const proj = projects.find(p => p.id === selectedProject)
            const hasLockedDefs = (proj?.custom_field_definitions ?? []).length > 0
            const isLocked = hasLockedDefs && !unlockCustomFields
            return (
              <div className="border-t border-gray-100 pt-5 mb-6">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-sm font-medium text-gray-700">Extra velden <span className="text-gray-400 font-normal">(optioneel)</span></div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Voeg tot {MAX_CUSTOM_FIELDS} projectspecifieke velden toe — bv. dealwaarde, bron, branche.
                    </p>
                  </div>
                  {!isLocked && customFields.length < MAX_CUSTOM_FIELDS && (
                    <button
                      type="button"
                      onClick={() => setCustomFields(prev => [...prev, { label: '', type: 'text', column: '' }])}
                      className="text-xs text-brand-600 hover:text-brand-700 font-medium"
                    >
                      + Veld toevoegen
                    </button>
                  )}
                </div>

                {hasLockedDefs && !unlockCustomFields && (
                  <p className="text-xs text-gray-400 mb-3">
                    🔒 Dit project heeft {customFields.length} vastgelegd{customFields.length !== 1 ? 'e' : ''} extra veld{customFields.length !== 1 ? 'en' : ''}.{' '}
                    <button
                      type="button"
                      onClick={() => setUnlockCustomFields(true)}
                      className="text-amber-600 hover:text-amber-700 underline"
                    >
                      wijzig
                    </button>
                  </p>
                )}

                {customFields.length === 0 && !hasLockedDefs && (
                  <p className="text-xs text-gray-400 italic">Geen extra velden — klik &quot;Veld toevoegen&quot; om te starten.</p>
                )}

                <div className="space-y-2">
                  {customFields.map((cf, i) => (
                    <div key={i} className="flex items-start gap-2">
                      {/* Label */}
                      <input
                        type="text"
                        value={cf.label}
                        onChange={e => setCustomFields(prev =>
                          prev.map((p, pi) => pi === i ? { ...p, label: e.target.value } : p)
                        )}
                        disabled={isLocked}
                        placeholder="Label (bv. Dealwaarde)"
                        className={`input flex-1 text-sm ${isLocked ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}
                      />
                      {/* Type */}
                      <select
                        value={cf.type}
                        onChange={e => setCustomFields(prev =>
                          prev.map((p, pi) => pi === i ? { ...p, type: e.target.value as CustomFieldType } : p)
                        )}
                        disabled={isLocked}
                        className={`input w-32 text-sm ${isLocked ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}
                      >
                        {CUSTOM_FIELD_TYPES.map(t => (
                          <option key={t.value} value={t.value} title={t.help}>{t.label}</option>
                        ))}
                      </select>
                      {/* Kolom */}
                      <select
                        value={cf.column}
                        onChange={e => setCustomFields(prev =>
                          prev.map((p, pi) => pi === i ? { ...p, column: e.target.value } : p)
                        )}
                        className="input flex-1 text-sm"
                      >
                        <option value="">- kies kolom -</option>
                        {columns.map(col => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                      {!isLocked && (
                        <button
                          type="button"
                          onClick={() => setCustomFields(prev => prev.filter((_, pi) => pi !== i))}
                          className="text-gray-300 hover:text-red-500 text-lg px-2"
                          title="Verwijder dit veld"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {preview.length > 0 && previewCols.length > 0 && (
            <div className="mb-6">
              <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Preview (eerste 3 rijen)</div>
              <div className="overflow-x-auto rounded-lg border border-gray-100">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50">
                      {previewCols.map(col => (
                        <th key={col} className="text-left px-3 py-2 font-medium text-gray-500 border-b border-gray-100">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i} className="border-b border-gray-50 last:border-0">
                        {previewCols.map(col => (
                          <td key={col} className="px-3 py-2 text-gray-600 max-w-[180px] truncate">
                            {row[col] ?? '-'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {error && (
            <p className="mb-4 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}

          <div className="flex gap-2">
            <button onClick={() => setStep('upload')} className="btn-secondary">Terug</button>
            <button
              onClick={() => {
                if (!mapping.lead_name || !mapping.status) {
                  setError('Koppel minstens "Naam lead" en "Status" om verder te gaan.')
                  return
                }
                if (!mapping.call_date) {
                  setError('Koppel ook "Datum gesprek" - nodig om alleen calls van de juiste dag te importeren.')
                  return
                }
                setError(null)
                setStep('confirm')
              }}
              className="btn-primary"
            >
              Volgende
            </button>
          </div>
        </div>
      )}

      {step === 'confirm' && (
        <div className="card p-6">
          <h2 className="font-medium text-gray-900 mb-5">Bevestig de import</h2>

          <div className="mb-5 p-4 bg-brand-50 border border-brand-100 rounded-lg">
            <label className="block text-sm font-medium text-brand-900 mb-1">
              Sessiedatum
            </label>
            <p className="text-xs text-brand-700 mb-3">
              Alleen rijen waarvan de datum-kolom op deze dag valt worden geimporteerd. Voorkomt dubbeltelling als je een lijst met meerdere call-dagen exporteert.
            </p>
            <input
              type="date"
              value={sessionDate}
              onChange={e => setSessionDate(e.target.value)}
              className="input bg-white"
              max={todayIso()}
            />

            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500"/>
                <span className="text-gray-700"><strong>{dateMatch.match}</strong> rijen worden geimporteerd</span>
              </div>
              {dateMatch.mismatch > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-gray-400"/>
                  <span className="text-gray-500">{dateMatch.mismatch} andere datum (skip)</span>
                </div>
              )}
              {dateMatch.invalid > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-500"/>
                  <span className="text-amber-700">{dateMatch.invalid} ongeldige datum (skip)</span>
                </div>
              )}
            </div>
            {dateMatch.match === 0 && (
              <p className="mt-2 text-xs text-amber-700">
                Geen rijen op deze datum gevonden. Kies een andere datum of controleer de date-kolom.
              </p>
            )}
          </div>

          <div className="space-y-3 mb-6">
            <div className="flex justify-between text-sm py-2 border-b border-gray-50">
              <span className="text-gray-500">Bestand</span>
              <span className="font-medium text-gray-900">{file?.name}</span>
            </div>
            <div className="flex justify-between text-sm py-2 border-b border-gray-50">
              <span className="text-gray-500">Platform</span>
              <span className="font-medium text-gray-900">{TOOLS.find(t => t.value === tool)?.label}</span>
            </div>
            <div className="flex justify-between text-sm py-2 border-b border-gray-50">
              <span className="text-gray-500">Project</span>
              <span className="font-medium text-gray-900">{projects.find(p => p.id === selectedProject)?.name ?? '-'}</span>
            </div>
            <div className="flex justify-between text-sm py-2 border-b border-gray-50">
              <span className="text-gray-500">Rijen in bestand</span>
              <span className="font-medium text-gray-900">{rawData.length}</span>
            </div>
            <div className="flex justify-between text-sm py-2">
              <span className="text-gray-500">AI analyse</span>
              <span className="text-green-600 font-medium">Wordt automatisch gestart</span>
            </div>
          </div>

          {error && (
            <p className="mb-4 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}

          <div className="flex gap-2">
            <button onClick={() => setStep('mapping')} className="btn-secondary" disabled={loading}>
              Terug
            </button>
            <button onClick={handleSubmit} disabled={loading || dateMatch.match === 0} className="btn-primary">
              {loading
                ? 'Importeren...'
                : `${dateMatch.match} ${dateMatch.match === 1 ? 'rij' : 'rijen'} importeren`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
