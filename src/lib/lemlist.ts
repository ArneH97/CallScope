/**
 * Lemlist API helper — herzien 2026-07-16 voor Lemlist API v2 (2026-mid).
 *
 * Auth: Basic Auth met API-key als password, username leeg:
 *   Authorization: Basic ${base64(":" + apiKey)}
 *
 * Wat wijzigde in Lemlist's API:
 *   - `/tasks` filters gaan nu via JSON-array in query-param `filters=`,
 *     niet meer via losse `type=call&status=completed` params. Tasks
 *     retourneert enkel PENDING tasks (done wordt uitgesloten).
 *   - Voltooide history staat nu in `/activities?version=v2` met
 *     type-filter zoals `manualDone`. Vereist `version=v2` param anders 400.
 *   - Team-members via `/team/senders` (userIds + hun campaigns).
 *   - Per-user detail via `/users/{userId}` voor name/email.
 *
 * Voor CallScope's use-case (completed cold-calls importeren met per-caller
 * attribution) is de flow:
 *   1. listTeamSenders + getUser per userId → email-map
 *   2. Match email met CallScope profiles → lemlist_user → callscope_caller
 *   3. getManualDoneActivities in tijdswindow → per activity: sendUserId
 *      (fallback: userId) → mapping → CallScope caller
 */

import { createClient } from '@supabase/supabase-js'

const LEMLIST_API_BASE = 'https://api.lemlist.com/api'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

function authHeader(apiKey: string): string {
  const encoded = Buffer.from(`:${apiKey}`).toString('base64')
  return `Basic ${encoded}`
}

/** Geldig API-key uit DB ophalen. Throws als user geen integratie heeft. */
export async function getLemlistApiKey(userId: string): Promise<string> {
  const sb = getServiceClient()
  const { data, error } = await sb
    .from('lemlist_integrations')
    .select('api_key')
    .eq('user_id', userId)
    .single()
  if (error || !data) {
    throw new Error('Geen Lemlist-integratie gevonden voor deze gebruiker')
  }
  return (data as { api_key: string }).api_key
}

// ── Team info (auth-validatie) ────────────────────────────────────────────

export type LemlistTeamInfo = {
  team_id:    string | null
  team_name:  string | null
  user_email: string | null
}

export async function testApiKey(apiKey: string): Promise<LemlistTeamInfo | null> {
  try {
    const res = await fetch(`${LEMLIST_API_BASE}/team`, {
      headers: { Authorization: authHeader(apiKey) },
    })
    if (res.status === 401 || res.status === 403) return null
    if (!res.ok) return null
    const data = await res.json() as { _id?: string; name?: string; email?: string }
    return {
      team_id:    data._id   ?? null,
      team_name:  data.name  ?? null,
      user_email: data.email ?? null,
    }
  } catch {
    return null
  }
}

// ── Team senders + user lookup ────────────────────────────────────────────

export type LemlistSender = {
  userId:    string
  campaigns: Array<{ _id: string; name: string; status: string }>
}

/** Lijst alle team-userIds die aan campaigns hangen. */
export async function listTeamSenders(apiKey: string): Promise<LemlistSender[]> {
  const res = await fetch(`${LEMLIST_API_BASE}/team/senders`, {
    headers: { Authorization: authHeader(apiKey) },
  })
  if (!res.ok) {
    throw new Error(`Lemlist team/senders faalde: ${res.status}`)
  }
  const data = await res.json() as Array<{
    userId?:    string
    campaigns?: Array<{ _id?: string; name?: string; status?: string }>
  }>
  return data
    .filter(s => s.userId)
    .map(s => ({
      userId:    s.userId!,
      campaigns: (s.campaigns ?? []).map(c => ({
        _id:    c._id    ?? '',
        name:   c.name   ?? '',
        status: c.status ?? '',
      })),
    }))
}

export type LemlistUser = {
  userId: string
  email:  string | null
  name:   string | null
}

/** Detail van één user (voor email + name). */
export async function getUser(apiKey: string, userId: string): Promise<LemlistUser> {
  const res = await fetch(`${LEMLIST_API_BASE}/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: authHeader(apiKey) },
  })
  if (!res.ok) {
    throw new Error(`Lemlist users/${userId} faalde: ${res.status}`)
  }
  const data = await res.json() as {
    _id?: string; email?: string; name?: string; firstName?: string; lastName?: string
  }
  const name = data.name
    ?? [data.firstName, data.lastName].filter(Boolean).join(' ')
    ?? null
  return {
    userId: data._id ?? userId,
    email:  data.email?.toLowerCase() ?? null,
    name:   name || null,
  }
}

/**
 * Bulk lookup van alle team-users met hun email/name. Rate-limit-safe:
 * sequentiëel om binnen 20 req/2s te blijven (Lemlist limiet).
 */
export async function listTeamUsers(apiKey: string): Promise<LemlistUser[]> {
  const senders = await listTeamSenders(apiKey)
  const out: LemlistUser[] = []
  for (const s of senders) {
    try {
      out.push(await getUser(apiKey, s.userId))
    } catch (e) {
      console.warn(`[lemlist] user lookup failed for ${s.userId}:`, e)
      out.push({ userId: s.userId, email: null, name: null })
    }
  }
  return out
}

// ── Completed activities (was: completed tasks) ───────────────────────────

/**
 * Lemlist activity types die we als "completed call" beschouwen. Elke
 * activity in deze lijst wordt als ÉÉN aparte call_record in CallScope
 * ingelezen — geen dedup per (lead, dag), want een cold caller kan dezelfde
 * lead meerdere keren op één dag bellen (ochtend no-answer → middag connect).
 *
 * Sinds mid-2026 heeft Lemlist een ingebouwde VoIP dialer (via Twilio/Aircall).
 * Belangrijk: bij één VoIP-call genereert Lemlist DRIE activities:
 *   - `aircallCreated` — start (skippen: geen outcome)
 *   - `aircallEnded`   — call afgesloten, MET duration + callStatus + recording
 *   - `aircallDone`    — task afgevinkt na call (skippen: dubbeltelling)
 *
 * We nemen enkel `aircallEnded` mee zodat elke echte call precies één keer
 * geteld wordt. Voor callers zonder VoIP-dialer vallen we terug op de
 * manual-varianten.
 */
export const COMPLETED_CALL_ACTIVITY_TYPES = [
  'aircallEnded',
  'manualDone',
  'manualInterested',
  'manualNotInterested',
] as const

export type LemlistActivity = {
  id:            string
  type:          string                // 'aircallEnded', 'manualDone', ...
  createdAt:     string                // ISO — wanneer de call afgerond werd
  userId:        string | null         // task-owner
  sendUserId:    string | null         // wie effectief de actie deed (= de beller)
  userName:      string | null
  sendUserName:  string | null
  leadId:        string | null
  campaignId:    string | null
  campaignName:  string | null
  outcome:       string | null         // combinatie van type + callStatus
  duration:      number | null         // seconden (enkel bij aircall*)
  callStatus:    string | null         // 'connected' | 'no-answer' | ... (enkel bij aircall*)
  direction:     string | null         // 'outbound' | 'inbound' (enkel bij aircall*)
  lead: {
    email:            string | null
    phone:            string | null
    firstName:        string | null
    lastName:         string | null
    companyName:      string | null
    hubspotContactId: string | null   // uit lead.hubspotLeadId of variables.hubspotLeadId
    // Context die de AI-bezwaar-classifier gebruikt om specifiekere labels
    // te genereren dan "Geen interesse". Komt uit lead.variables (custom
    // fields die de klant per lead invult in Lemlist).
    concurrentName:   string | null   // "Zenchef", "Easybooker", "Wix", null
    companyType:      string | null   // "Restaurant", "Brasserie", "Bistro"
    companyCity:      string | null   // "Antwerpen", "Hasselt"
    leadCampagne:     string | null   // "W" / "WO" / "TB" / "TF"
  }
}

/**
 * Fetch één specifiek activity-type met pagination tot einde.
 *
 * WAAROM PER TYPE FETCHEN? De vorige aanpak deed één big fetch zonder
 * type-filter en brak af zodra een pagina < LIMIT items had. Maar
 * `/activities` mixt emails, LinkedIn, calls, snoozes, etc. door elkaar —
 * je bereikt snel het "einde" op een pagina met 78 items terwijl er
 * verderop nog honderden `aircallEnded` events zitten. Server-side filter
 * op één type garandeert dat de pagination-loop precies dat type opgevist
 * krijgt zonder valse "einde"-detecties.
 */
async function fetchActivitiesByType(
  apiKey:  string,
  type:    string,
  fromIso: string,
  toIso:   string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const LIMIT = 100
  let offset  = 0

  // Safety-cap: max 50 pages = 5000 activities per type per sync-run.
  // Bij een klant die 100 calls/dag doet dekt dit ~50 dagen zonder truncatie.
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      version: 'v2',
      type,
      minDate: fromIso,
      maxDate: toIso,
      limit:   String(LIMIT),
      offset:  String(offset),
    })
    const res = await fetch(`${LEMLIST_API_BASE}/activities?${params}`, {
      headers: { Authorization: authHeader(apiKey) },
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Lemlist activities (type=${type}) faalde: ${res.status} ${txt.slice(0, 200)}`)
    }
    const data = await res.json() as Array<Record<string, unknown>>
    if (!Array.isArray(data) || data.length === 0) break
    out.push(...data)
    if (data.length < LIMIT) break
    offset += LIMIT
  }

  return out
}

/**
 * Haal completed call activities op tussen fromIso en toIso.
 *
 * Doet ÉÉN fetch per type in `COMPLETED_CALL_ACTIVITY_TYPES` (server-side
 * filter) — dat is de enige betrouwbare manier om alle events te krijgen
 * zonder dat de pagination vroegtijdig afbreekt op een pagina met veel
 * niet-relevante events.
 *
 * Rate-limit-safe: 4 types × max 50 pages = 200 API calls in het slechtste
 * geval, ver onder Lemlist's 20 req / 2 sec limiet.
 *
 * Belangrijk: `sendUserId` is de user die de call effectief afhandelde
 * (mark-as-done geklikt). `userId` is de task-creator (soms de campaign
 * owner). Voor "wie heeft deze call gedaan" gebruik je sendUserId eerst,
 * met userId als fallback voor niet-sequence tasks.
 */
export async function getManualDoneActivities(
  apiKey:  string,
  fromIso: string,
  toIso:   string,
): Promise<LemlistActivity[]> {
  const out: LemlistActivity[] = []

  for (const type of COMPLETED_CALL_ACTIVITY_TYPES) {
    let rawActivities: Array<Record<string, unknown>>
    try {
      rawActivities = await fetchActivitiesByType(apiKey, type, fromIso, toIso)
    } catch (e) {
      console.warn(`[lemlist] fetch type=${type} faalde:`, e)
      continue
    }
    for (const a of rawActivities) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = (a.lead as any) ?? {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vars = (lead.variables as any) ?? {}
      const duration   = typeof a.duration   === 'number' ? a.duration   : null
      const callStatus = typeof a.callStatus === 'string' ? a.callStatus : null
      const direction  = typeof a.direction  === 'string' ? a.direction  : null
      // Outcome-key voor mapOutcomeToStatus: combineer type + callStatus
      // (bv. "aircallended:connected") zodat we per-status precies mappen.
      const outcomeKey = callStatus
        ? `${type.toLowerCase()}:${callStatus.toLowerCase()}`
        : type.toLowerCase()

      out.push({
        id:           String(a._id ?? ''),
        type,
        createdAt:    String(a.createdAt ?? ''),
        userId:       (a.userId as string | undefined) ?? null,
        sendUserId:   (a.sendUserId as string | undefined) ?? null,
        userName:     (a.userName as string | undefined) ?? null,
        sendUserName: (a.sendUserName as string | undefined) ?? null,
        leadId:       (a.leadId as string | undefined) ?? null,
        campaignId:   (a.campaignId as string | undefined) ?? null,
        campaignName: (a.campaignName ?? a.name as string | undefined) ?? null,
        outcome:      outcomeKey,
        duration,
        callStatus,
        direction,
        lead: {
          email:       (a.leadEmail ?? vars.email ?? lead.email ?? null) as string | null,
          phone:       (a.leadPhone ?? vars.phone ?? lead.phone ?? null) as string | null,
          firstName:   (a.leadFirstName ?? vars.firstName ?? null) as string | null,
          lastName:    (a.leadLastName ?? vars.lastName ?? null) as string | null,
          companyName: (a.leadCompanyName ?? vars.companyName ?? null) as string | null,
          // hubspotLeadId in Lemlist == HubSpot Contact-ID (numeric). Kan
          // op verschillende posities zitten afhankelijk van hoe de lead
          // in Lemlist is aangemaakt — controleer alle plausibele bronnen.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hubspotContactId: normalizeHubspotId((lead as any).hubspotLeadId ?? vars.hubspotLeadId ?? vars.hubspotContactId ?? null),
          // Extra context voor bezwaar-classifier — bewust de meest gebruikte
          // variables uit RestoManager's setup (companyConcurrentNaam is
          // typisch "Zenchef" / "Easybooker" / …). Fallback naar generieke
          // benamingen indien de klant andere veld-namen gebruikt.
          concurrentName: nonEmpty(vars.companyConcurrentNaam ?? vars.concurrent ?? vars.competitor ?? null),
          companyType:    nonEmpty(vars.companyType ?? vars.type ?? null),
          companyCity:    nonEmpty(vars.companyCity ?? vars.city ?? null),
          leadCampagne:   nonEmpty(vars.companyLeadCampagne ?? vars.leadCampagne ?? null),
        },
      })
    }
  }

  return out
}

/** null teruggeven bij lege strings zodat we consistent null-checks kunnen doen. */
function nonEmpty(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * Lemlist geeft hubspotLeadId soms als number, soms als string. Voor de
 * HubSpot API willen we altijd een string, en NULL bij lege waardes.
 */
function normalizeHubspotId(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  if (s === '' || s === '0') return null
  return s
}

// ── Outcome → CallScope-status mapping ─────────────────────────────────────

/**
 * Zet een Lemlist activity-outcome om naar een CallScope status-string.
 *
 * Outcome-key formaat:
 *   - "aircallended:connected"     → aircall + callStatus
 *   - "aircallended:no-answer"     → idem
 *   - "aircalldone:no-answer"      → task afgevinkt zonder daadwerkelijke call
 *   - "manualdone"                 → alleen type (geen callStatus)
 *
 * De classifier (analyse-route) herkent deze Nederlandse labels als
 * bereikt/niet-bereikt/enz. Onbekende outcomes → null (leeg, cc_manager
 * kan later handmatig aanvullen).
 */
const OUTCOME_MAP: Record<string, string> = {
  // ── Aircall (VoIP dialer) — call heeft ECHT plaatsgevonden ──────────
  //
  // BELANGRIJK: Lemlist markeert een afspraak als callStatus="connected-positive"
  // (of "connected_positive" / "connectedPositive" — we accepteren alle
  // varianten). Reguliere `connected` = "iemand nam op" maar geen afspraak.
  // Deze mapping komt vervolgens in de upload_summary view die "Afspraak
  // gemaakt" via regex /afspraak|appointment/i telt.
  'aircallended:connected':          'Bereikt',
  'aircallended:connected-positive': 'Afspraak gemaakt',
  'aircallended:connected_positive': 'Afspraak gemaakt',
  'aircallended:connectedpositive':  'Afspraak gemaakt',
  'aircallended:positive':           'Afspraak gemaakt',
  'aircallended:connected-negative': 'Geen interesse',
  'aircallended:connected_negative': 'Geen interesse',
  'aircallended:connectednegative':  'Geen interesse',
  'aircallended:negative':           'Geen interesse',
  'aircallended:no-answer':          'Niet bereikt',
  'aircallended:noanswer':           'Niet bereikt',
  'aircallended:no_answer':          'Niet bereikt',
  'aircallended:busy':               'Bezet',
  'aircallended:voicemail':          'Voicemail',
  'aircallended:gatekeeper':         'Gatekeeper',
  'aircallended:wrong-number':       'Verkeerd nummer',
  'aircallended:wrong_number':       'Verkeerd nummer',
  'aircallended:wrongnumber':        'Verkeerd nummer',
  'aircallended:failed':             'Niet bereikt',
  'aircallended:canceled':           'Niet bereikt',
  'aircallended:cancelled':          'Niet bereikt',
  'aircallended':                    'Opgebeld',  // fallback zonder callStatus

  // ── Manual varianten (geen VoIP) ─────────────────────────────────────
  'manualdone':                'Opgebeld',
  'manualinterested':          'Afspraak gemaakt',
  'manualnotinterested':       'Geen interesse',

  // ── Legacy Lemlist enum (backwards compat voor oude data) ────────────
  'connected':      'Bereikt',
  'positive':       'Afspraak gemaakt',
  'meeting_set':    'Afspraak gemaakt',
  'interested':     'Afspraak gemaakt',
  'appointment':    'Afspraak gemaakt',
  'no_answer':      'Niet bereikt',
  'busy':           'Bezet',
  'unreachable':    'Niet bereikt',
  'voicemail':      'Voicemail',
  'left_message':   'Voicemail',
  'negative':       'Geen interesse',
  'not_interested': 'Geen interesse',
  'do_not_call':    'Geen interesse',
  'wrong_number':   'Verkeerd nummer',
  'invalid_phone':  'Verkeerd nummer',
}

export function mapOutcomeToStatus(outcome: string | null): string | null {
  if (!outcome) return null
  const key = outcome.toLowerCase()
  // Exacte match eerst; als "type:status" niet in map staat, fallback naar
  // enkel "type" zodat aircallended:onbekende_status alsnog "Opgebeld" wordt.
  if (OUTCOME_MAP[key]) return OUTCOME_MAP[key]
  const typeOnly = key.split(':')[0]
  return OUTCOME_MAP[typeOnly] ?? null
}
