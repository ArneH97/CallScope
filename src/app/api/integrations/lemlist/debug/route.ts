import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { getLemlistApiKey, testApiKey } from '@/lib/lemlist'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * GET /api/integrations/lemlist/debug
 *
 * Read-only diagnose van de Lemlist workspace-structuur, met de NIEUWE API
 * (Lemlist heeft in 2026 de /tasks-filters herzien en /activities gepromoot
 * naar de canonieke history-endpoint).
 *
 * Returnt:
 *   - team:              basis-info (naam + team-id)
 *   - senders:           team-members met hun campaigns (userId + campaigns[])
 *   - users:             per userId de gedetailleerde user-info (name, email)
 *   - callscopeMatches:  auto-match Lemlist users op CallScope profiles via email
 *   - sampleTasks:       eerste 5 pending tasks met correcte filter-syntax
 *   - sampleActivities:  eerste 5 completed activities met assignee (userId)
 *
 * Bedoeld als one-off inspection — deel de output om te bepalen of
 * email-based auto-mapping werkt of dat we een expliciete UI-mapping
 * nodig hebben.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let apiKey: string
  try {
    apiKey = await getLemlistApiKey(user.id)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Geen Lemlist-integratie' },
      { status: 400 },
    )
  }

  const auth = 'Basic ' + Buffer.from(':' + apiKey).toString('base64')
  const base = 'https://api.lemlist.com/api'

  async function lemGet(path: string): Promise<unknown> {
    try {
      const res = await fetch(`${base}${path}`, { headers: { Authorization: auth } })
      const text = await res.text()
      if (!res.ok) return { _error: `${res.status} ${text.slice(0, 200)}` }
      try { return JSON.parse(text) } catch { return { _error: 'invalid JSON', body: text.slice(0, 200) } }
    } catch (e) {
      return { _error: e instanceof Error ? e.message : 'fetch failed' }
    }
  }

  // 1. Team info (bestaande helper, werkt)
  const team = await testApiKey(apiKey)
  if (!team) {
    return NextResponse.json({ error: 'API-key werkt niet meer (401/403)' }, { status: 400 })
  }

  // 2. Team senders — lijst van userIds + hun campaigns
  const sendersRaw = await lemGet('/team/senders')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const senders = Array.isArray(sendersRaw) ? sendersRaw as any[] : []
  const senderIds = senders.map(s => s.userId).filter(Boolean) as string[]

  // 3. Per userId → detail lookup voor name/email. Max 6 om rate-limit te sparen.
  const users: Record<string, unknown> = {}
  for (const uid of senderIds.slice(0, 6)) {
    users[uid] = await lemGet(`/users/${encodeURIComponent(uid)}`)
  }

  // 4. Auto-match Lemlist users → CallScope profiles op email (case-insensitive)
  const lemlistEmails: { userId: string; email: string | null; name: string | null }[] = []
  for (const [uid, u] of Object.entries(users)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ux = u as any
    const email = (ux?.email ?? ux?.emailAddress ?? null) as string | null
    const name  = (ux?.name ?? ux?.fullName ?? [ux?.firstName, ux?.lastName].filter(Boolean).join(' ') ?? null) as string | null
    lemlistEmails.push({ userId: uid, email: email?.toLowerCase() ?? null, name })
  }
  const sbAdmin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const uniqueEmails = Array.from(new Set(lemlistEmails.map(l => l.email).filter(Boolean))) as string[]
  const callscopeMatches: Array<{ lemlist_user_id: string; lemlist_name: string | null; email: string; callscope_profile_id: string | null; callscope_name: string | null }> = []
  if (uniqueEmails.length > 0) {
    const { data: profs } = await sbAdmin
      .from('profiles')
      .select('id, full_name, email')
      .in('email', uniqueEmails)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profByEmail = new Map<string, any>()
    for (const p of ((profs ?? []) as { id: string; full_name: string | null; email: string | null }[])) {
      if (p.email) profByEmail.set(p.email.toLowerCase(), p)
    }
    for (const l of lemlistEmails) {
      if (!l.email) continue
      const match = profByEmail.get(l.email)
      callscopeMatches.push({
        lemlist_user_id:      l.userId,
        lemlist_name:         l.name,
        email:                l.email,
        callscope_profile_id: match?.id ?? null,
        callscope_name:       match?.full_name ?? null,
      })
    }
  }

  // 5. Sample tasks — NIEUWE filter-syntax (JSON-array in ?filters=)
  //    Wrapped response: { results: [...], page: "0" }
  const tasksFilter = JSON.stringify([{ filterId: 'type', in: ['phone', 'manual'] }])
  const sampleTasks = await lemGet(`/tasks?filters=${encodeURIComponent(tasksFilter)}`)

  // 6. Sample activities — ONGEFILTERD (geen type=) voor de LAATSTE 3 DAGEN
  //    zodat we exact zien welke activity-types Lemlist genereert voor de
  //    calls die in de "Calls"-tab (VoIP dialer) verschijnen. Manual done
  //    is niet het enige type — Lemlist heeft ook callConnected, callNoAnswer
  //    etc. Zonder deze inventarisatie missen we het merendeel van de calls.
  const now = new Date()
  const from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const to   = now.toISOString()
  const activitiesRaw = await lemGet(
    `/activities?version=v2&minDate=${encodeURIComponent(from)}&maxDate=${encodeURIComponent(to)}&limit=100`,
  )
  // Tel per type + geef eerste sample van elk type
  const typeCounts: Record<string, number> = {}
  const perTypeSample: Record<string, unknown> = {}
  const perTypeUserIds: Record<string, string[]> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (Array.isArray(activitiesRaw)) for (const a of activitiesRaw as any[]) {
    const t = String(a.type ?? '?')
    typeCounts[t] = (typeCounts[t] ?? 0) + 1
    if (!(t in perTypeSample)) perTypeSample[t] = a
    const uid = String(a.sendUserId ?? a.userId ?? '?')
    if (!perTypeUserIds[t]) perTypeUserIds[t] = []
    if (!perTypeUserIds[t].includes(uid) && perTypeUserIds[t].length < 5) perTypeUserIds[t].push(uid)
  }

  return NextResponse.json({
    team,
    senders,
    users,
    callscopeMatches,
    activitiesInventory: {
      windowFromIso: from,
      windowToIso:   to,
      totalReturned: Array.isArray(activitiesRaw) ? activitiesRaw.length : 0,
      typeCounts,
      perTypeUserIds,
    },
    perTypeSample,
    sampleTasks,
    hint:
      'Kijk naar `activitiesInventory.typeCounts` — dat toont exact welke ' +
      'activity-types Lemlist voor de laatste 3 dagen retourneert. Deel de ' +
      'lijst met Arne zodat we weten welke types (naast manualDone) ook ' +
      'meegenomen moeten worden voor de CallScope sync. VoIP call-events ' +
      'zoals "callConnected", "callNoAnswer" etc. horen hier tussen te zitten ' +
      'wanneer er die dag ge-belt is via de Lemlist dialer.',
  })
}
