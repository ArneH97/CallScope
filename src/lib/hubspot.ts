/**
 * HubSpot CRM helper.
 *
 * Verantwoordelijkheden:
 *   - OAuth: code-exchange + token-refresh (zelfde patroon als /lib/google.ts)
 *   - Contact-search via email of telefoon
 *   - Deal-lookup voor een contact + dealstage-resolve naar een leesbaar label
 *
 * Gebruik:
 *   const accessToken = await getValidHubSpotAccessToken(salesManagerId)
 *   const contact = await searchContactByEmail(accessToken, 'lead@bedrijf.be')
 *   const deal = await getActiveDealForContact(accessToken, contact.id)
 *
 * Referentie:
 *   - Auth: https://developers.hubspot.com/docs/api/working-with-oauth
 *   - CRM API: https://developers.hubspot.com/docs/api/crm/contacts
 */

import { createClient } from '@supabase/supabase-js'

const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token'
const HUBSPOT_API_BASE  = 'https://api.hubapi.com'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

// ── OAuth ──────────────────────────────────────────────────────────────────

/**
 * Wisselt een autorisatie-code in voor een token-paar bij HubSpot.
 * HubSpot's response heeft access_token + refresh_token + expires_in (seconds).
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const res = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     process.env.HUBSPOT_CLIENT_ID!,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
      redirect_uri:  redirectUri,
      code,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HubSpot token exchange mislukt: ${res.status} ${body}`)
  }
  return res.json() as Promise<{
    access_token:  string
    refresh_token: string
    expires_in:    number
    token_type:    string
  }>
}

/**
 * Token-info ophalen om hub_id, hub_domain en user-email te kennen.
 * HubSpot's /oauth/v1/access-tokens/{token} endpoint geeft alle context terug.
 */
export async function fetchTokenInfo(accessToken: string): Promise<{
  hub_id:       number
  hub_domain:   string | null
  user:         string | null   // email van de HubSpot-user die geautoriseerd heeft
  scopes:       string[]
}> {
  const res = await fetch(`${HUBSPOT_API_BASE}/oauth/v1/access-tokens/${accessToken}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HubSpot token-info mislukt: ${res.status} ${body}`)
  }
  const data = await res.json() as {
    hub_id?:     number
    hub_domain?: string
    user?:       string
    scopes?:     string[]
  }
  return {
    hub_id:     data.hub_id ?? 0,
    hub_domain: data.hub_domain ?? null,
    user:       data.user ?? null,
    scopes:     data.scopes ?? [],
  }
}

/**
 * Geeft een geldig access_token terug voor het gegeven PROJECT.
 * Leest uit project_hubspot_integrations (project_id PK). Refresht automatisch
 * via HubSpot OAuth als de huidige token (bijna) verlopen is.
 *
 * Wordt gebruikt voor calls-sync — elk project kan zijn eigen HubSpot-portaal
 * gekoppeld hebben (verschillende klanten = verschillende HubSpots).
 *
 * Throws als het project geen HubSpot-koppeling heeft.
 */
export async function getValidHubSpotAccessTokenForProject(projectId: string): Promise<string> {
  const sb = getServiceClient()
  const { data, error } = await sb
    .from('project_hubspot_integrations')
    .select('refresh_token, access_token, expires_at')
    .eq('project_id', projectId)
    .single()

  if (error || !data) {
    throw new Error('Geen HubSpot-integratie gevonden voor dit project')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const integration = data as any

  // Geldig met 60s buffer? → hergebruiken.
  if (integration.access_token && integration.expires_at) {
    const expiresAt = new Date(integration.expires_at).getTime()
    if (expiresAt > Date.now() + 60_000) {
      return integration.access_token as string
    }
  }

  // Refresh
  const refreshRes = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.HUBSPOT_CLIENT_ID!,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
      refresh_token: integration.refresh_token as string,
    }),
  })
  if (!refreshRes.ok) {
    const body = await refreshRes.text().catch(() => '')
    throw new Error(`HubSpot token refresh mislukt: ${refreshRes.status} ${body}`)
  }
  const tokens = await refreshRes.json() as {
    access_token:  string
    refresh_token: string
    expires_in:    number
  }
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update: any = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    newExpiresAt,
  }
  await sb.from('project_hubspot_integrations').update(update).eq('project_id', projectId)

  return tokens.access_token
}

/**
 * Geeft een geldig access_token terug voor de gegeven user.
 * Refresht automatisch via HubSpot OAuth als de huidige token (bijna) verlopen is.
 *
 * Throws als de gebruiker geen HubSpot-integratie heeft.
 */
export async function getValidHubSpotAccessToken(userId: string): Promise<string> {
  const sb = getServiceClient()
  const { data, error } = await sb
    .from('hubspot_integrations')
    .select('refresh_token, access_token, expires_at')
    .eq('user_id', userId)
    .single()

  if (error || !data) {
    throw new Error('Geen HubSpot-integratie gevonden voor deze gebruiker')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const integration = data as any

  // Geldig met 60s buffer? → hergebruiken.
  if (integration.access_token && integration.expires_at) {
    const expiresAt = new Date(integration.expires_at).getTime()
    if (expiresAt > Date.now() + 60_000) {
      return integration.access_token as string
    }
  }

  // Refresh
  const refreshRes = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.HUBSPOT_CLIENT_ID!,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
      refresh_token: integration.refresh_token as string,
    }),
  })
  if (!refreshRes.ok) {
    const body = await refreshRes.text().catch(() => '')
    throw new Error(`HubSpot token refresh mislukt: ${refreshRes.status} ${body}`)
  }
  const tokens = await refreshRes.json() as {
    access_token:  string
    refresh_token: string
    expires_in:    number
  }
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  // HubSpot stuurt altijd een nieuw refresh_token terug — die opslaan voor
  // toekomstige refresh-cycles (sommige refresh_tokens roteren).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update: any = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    newExpiresAt,
  }
  await sb.from('hubspot_integrations').update(update).eq('user_id', userId)

  return tokens.access_token
}

// ── Contacts ───────────────────────────────────────────────────────────────

export type HubSpotContact = {
  id:         string
  email:      string | null
  firstname:  string | null
  lastname:   string | null
  phone:      string | null
}

/**
 * Zoek een contact op email. Returnt het eerste matchende contact of null.
 */
export async function searchContactByEmail(
  accessToken: string,
  email: string,
): Promise<HubSpotContact | null> {
  return searchContactByProperty(accessToken, 'email', email.trim().toLowerCase())
}

/**
 * Zoek een contact op telefoonnummer. Probeert zowel `phone` als `mobilephone`
 * properties — HubSpot scheidt die.
 *
 * Telefoonnummer wordt gestripped naar enkel cijfers (en evt. een leading +)
 * voor een ruimere match. HubSpot's exact-match werkt op de string zoals
 * opgeslagen, dus exacte format-mismatches kunnen geen match opleveren —
 * daarom proberen we ook met/zonder landcode.
 */
export async function searchContactByPhone(
  accessToken: string,
  phone: string,
): Promise<HubSpotContact | null> {
  const normalized = phone.replace(/[^\d+]/g, '')
  if (!normalized) return null

  // Variants om te proberen — meest-specifiek eerst
  const variants = Array.from(new Set([
    normalized,
    normalized.replace(/^\+/, ''),  // zonder leading plus
    normalized.replace(/^\+32/, '0'), // BE: +32 → 0
    normalized.replace(/^32/, '0'),
  ]))

  for (const variant of variants) {
    for (const prop of ['phone', 'mobilephone'] as const) {
      const hit = await searchContactByProperty(accessToken, prop, variant)
      if (hit) return hit
    }
  }
  return null
}

async function searchContactByProperty(
  accessToken: string,
  propertyName: 'email' | 'phone' | 'mobilephone',
  value: string,
): Promise<HubSpotContact | null> {
  const body = {
    filterGroups: [{
      filters: [{ propertyName, operator: 'EQ', value }],
    }],
    properties: ['email', 'firstname', 'lastname', 'phone', 'mobilephone'],
    limit: 1,
  }
  const res = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`HubSpot contact search mislukt: ${res.status} ${txt}`)
  }
  const data = await res.json() as {
    results?: { id: string; properties: Record<string, string | null> }[]
  }
  const hit = data.results?.[0]
  if (!hit) return null
  return {
    id:        hit.id,
    email:     hit.properties.email ?? null,
    firstname: hit.properties.firstname ?? null,
    lastname:  hit.properties.lastname ?? null,
    phone:     hit.properties.phone ?? hit.properties.mobilephone ?? null,
  }
}

// ── Deals ──────────────────────────────────────────────────────────────────

export type HubSpotDeal = {
  id:                   string
  dealname:             string | null
  dealstage:            string | null   // intern stage-id (bv. "appointmentscheduled")
  pipeline:             string | null   // intern pipeline-id
  amount:               string | null
  closedate:            string | null
  hs_lastmodifieddate:  string | null
  hs_is_closed:         string | null   // "true" / "false"
}

/**
 * Haal alle deals op die geassocieerd zijn met een contact, gesorteerd op
 * laatst gewijzigd (recentste eerst). Returnt de meest relevante:
 *   - eerst: meest recent gewijzigde open deal (hs_is_closed = false)
 *   - fallback: meest recent gewijzigde deal überhaupt (incl. closed)
 *   - null: contact heeft geen deals
 */
export async function getActiveDealForContact(
  accessToken: string,
  contactId: string,
): Promise<HubSpotDeal | null> {
  // Stap 1: associated deal-ids ophalen
  const assocRes = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/${contactId}/associations/deals?limit=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!assocRes.ok) {
    const txt = await assocRes.text().catch(() => '')
    throw new Error(`HubSpot associations mislukt: ${assocRes.status} ${txt}`)
  }
  const assocData = await assocRes.json() as {
    results?: { id: string }[]
  }
  const dealIds = (assocData.results ?? []).map(r => r.id)
  if (dealIds.length === 0) return null

  // Stap 2: deal-details in batch ophalen
  const batchRes = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/deals/batch/read`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      properties: [
        'dealname', 'dealstage', 'pipeline', 'amount',
        'closedate', 'hs_lastmodifieddate', 'hs_is_closed',
      ],
      inputs: dealIds.map(id => ({ id })),
    }),
  })
  if (!batchRes.ok) {
    const txt = await batchRes.text().catch(() => '')
    throw new Error(`HubSpot deals batch mislukt: ${batchRes.status} ${txt}`)
  }
  const batchData = await batchRes.json() as {
    results?: { id: string; properties: Record<string, string | null> }[]
  }
  const deals: HubSpotDeal[] = (batchData.results ?? []).map(d => ({
    id:                  d.id,
    dealname:            d.properties.dealname ?? null,
    dealstage:           d.properties.dealstage ?? null,
    pipeline:            d.properties.pipeline ?? null,
    amount:              d.properties.amount ?? null,
    closedate:           d.properties.closedate ?? null,
    hs_lastmodifieddate: d.properties.hs_lastmodifieddate ?? null,
    hs_is_closed:        d.properties.hs_is_closed ?? null,
  }))

  if (deals.length === 0) return null

  // Sorteer op hs_lastmodifieddate desc
  deals.sort((a, b) => {
    const ta = a.hs_lastmodifieddate ? new Date(a.hs_lastmodifieddate).getTime() : 0
    const tb = b.hs_lastmodifieddate ? new Date(b.hs_lastmodifieddate).getTime() : 0
    return tb - ta
  })

  // Eerst: open deal kiezen
  const openDeal = deals.find(d => d.hs_is_closed !== 'true')
  return openDeal ?? deals[0]
}

/**
 * Zet een interne stage-id (bv. "appointmentscheduled") om naar het leesbare
 * label dat in de HubSpot-UI staat (bv. "Appointment Scheduled"). Dit label
 * gaat naar `dealstage_raw` op call_records, waar de bestaande AI-classifier
 * het naar een outcome-categorie omzet.
 *
 * We cachen de pipeline-info per accessToken/process — pipelines veranderen
 * zelden, dus per cron-run één keer ophalen volstaat.
 */
const stageLabelCache = new Map<string, Map<string, string>>()

export async function getDealstageLabel(
  accessToken: string,
  pipelineId: string | null,
  stageId: string,
): Promise<string> {
  if (!pipelineId) return stageId  // geen pipeline → geef stage-id terug

  let pipelineMap = stageLabelCache.get(accessToken)
  if (!pipelineMap) {
    // Haal alle deal-pipelines op (één request, alle stages erin)
    const res = await fetch(`${HUBSPOT_API_BASE}/crm/v3/pipelines/deals`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      // Fallback: stage-id als label
      return stageId
    }
    const data = await res.json() as {
      results?: { id: string; stages: { id: string; label: string }[] }[]
    }
    pipelineMap = new Map<string, string>()
    for (const p of data.results ?? []) {
      for (const s of p.stages) {
        // Key: "<pipelineId>:<stageId>" om naam-conflicten tussen pipelines
        // te vermijden (Sales pipeline en Service pipeline kunnen dezelfde
        // stage-naam hebben).
        pipelineMap.set(`${p.id}:${s.id}`, s.label)
      }
    }
    stageLabelCache.set(accessToken, pipelineMap)
  }

  return pipelineMap.get(`${pipelineId}:${stageId}`) ?? stageId
}

/**
 * Convenience: bepaal dealstage voor een lead via de beste beschikbare
 * match-key. Volgorde van proberen (van meest → minst betrouwbaar):
 *
 *   1. `hubspot_contact_id` — exacte HubSpot Contact-ID meegegeven vanuit
 *      Lemlist (`lead.variables.hubspotLeadId`) of manueel geset. Skipt de
 *      search-API-call volledig.
 *   2. `email` — via searchContactByEmail
 *   3. `phone` — via searchContactByPhone (probeert +32/32/0-varianten)
 *
 * Returnt null als geen contact óf geen actieve deal gevonden.
 */
export async function lookupDealstageForLead(
  accessToken: string,
  lead: {
    email?:              string | null
    phone?:              string | null
    hubspot_contact_id?: string | null
  },
): Promise<{
  contact_id:      string
  deal_id:         string
  dealstage_id:    string
  dealstage_label: string
} | null> {
  let contactId: string | null = null

  // 1. Directe Contact-ID → geen search nodig
  if (lead.hubspot_contact_id && lead.hubspot_contact_id.trim()) {
    contactId = lead.hubspot_contact_id.trim()
  }

  // 2. Email fallback
  if (!contactId && lead.email && lead.email.trim()) {
    const c = await searchContactByEmail(accessToken, lead.email)
    if (c) contactId = c.id
  }

  // 3. Phone fallback
  if (!contactId && lead.phone && lead.phone.trim()) {
    const c = await searchContactByPhone(accessToken, lead.phone)
    if (c) contactId = c.id
  }

  if (!contactId) return null

  const deal = await getActiveDealForContact(accessToken, contactId)
  if (!deal || !deal.dealstage) return null

  const label = await getDealstageLabel(accessToken, deal.pipeline, deal.dealstage)

  return {
    contact_id:      contactId,
    deal_id:         deal.id,
    dealstage_id:    deal.dealstage,
    dealstage_label: label,
  }
}

// ── Lists (cc_manager calls-sync) ──────────────────────────────────────────

export type HubSpotList = {
  list_id:     string
  name:        string
  size:        number | null     // aantal contacts (null als niet beschikbaar)
  list_type:   string | null     // STATIC, DYNAMIC, ...
  processing:  string | null     // COMPLETED, ...
}

/**
 * Lijst alle CONTACT-lists in HubSpot via de legacy v1 lists-API.
 *
 * Werkt met `crm.objects.contacts.read` zonder de aparte `crm.lists.read`
 * scope (die enkel beschikbaar is voor specifieke app-types). De v1 lists-API
 * is stabiel maar gebruikt een eigen response-shape met camelCase + numerieke
 * IDs — die normaliseren we hier naar onze HubSpotList type.
 */
export async function listContactLists(accessToken: string): Promise<HubSpotList[]> {
  const out: HubSpotList[] = []
  let offset = 0

  for (let i = 0; i < 5; i++) {                              // max 5 pages × 50 = 250
    const params = new URLSearchParams({
      count:  '50',
      offset: String(offset),
    })
    const res = await fetch(
      `${HUBSPOT_API_BASE}/contacts/v1/lists?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      // 403 betekent meestal dat het HubSpot-account de "Lists"-scope niet
      // heeft — dat is een feature van HubSpot Sales Starter+ (niet Free).
      // Geef een gerichte foutmelding zodat de cc_manager weet wat te doen.
      if (res.status === 403 && /contacts-lists/i.test(txt)) {
        throw new Error(
          'Je HubSpot-account heeft geen toegang tot Lists. ' +
          'De "Lists"-feature vereist HubSpot Sales Starter of hoger. ' +
          'Upgrade je HubSpot-plan om calls per list te synchroniseren.',
        )
      }
      throw new Error(`HubSpot lists v1 mislukt: ${res.status} ${txt}`)
    }
    const data = await res.json() as {
      lists?: Array<{
        listId:    number
        name:      string
        dynamic?:  boolean
        listType?: string                                    // STATIC, DYNAMIC, ...
        metaData?: { size?: number }
      }>
      'has-more'?: boolean
      offset?:    number
    }
    for (const l of data.lists ?? []) {
      out.push({
        list_id:    String(l.listId),
        name:       l.name,
        size:       l.metaData?.size ?? null,
        list_type:  l.listType ?? (l.dynamic ? 'DYNAMIC' : 'STATIC'),
        processing: null,
      })
    }
    if (!data['has-more']) break
    offset = data.offset ?? 0
    if (offset === 0) break
  }
  return out
}

/**
 * Haal alle contact-vids op die in een specifieke list zitten via de v1
 * lists/contacts-API. Gepagineerd (vidOffset).
 *
 * Voor grote lists kan dit traag zijn — we plafonneren op 5000 contacts om
 * te voorkomen dat één sync-run de hele cron-budget opslokt. Lists groter
 * dan dat zijn voor cold-calling toch niet zinvol.
 */
export async function getListMembership(
  accessToken: string,
  listId: string,
): Promise<string[]> {
  const out: string[] = []
  let vidOffset: number | undefined

  for (let i = 0; i < 50; i++) {                             // 50 × 100 = 5000 max
    const params = new URLSearchParams({ count: '100' })
    if (vidOffset != null) params.set('vidOffset', String(vidOffset))

    const res = await fetch(
      `${HUBSPOT_API_BASE}/contacts/v1/lists/${listId}/contacts/all?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`HubSpot list-contacts v1 mislukt: ${res.status} ${txt}`)
    }
    const data = await res.json() as {
      contacts?:    { vid: number }[]
      'has-more'?:  boolean
      'vid-offset'?: number
    }
    for (const c of data.contacts ?? []) {
      out.push(String(c.vid))
    }
    if (!data['has-more']) break
    vidOffset = data['vid-offset']
    if (vidOffset == null) break
  }
  return out
}

// ── Call engagements (cc_manager calls-sync) ───────────────────────────────

export type HubSpotCallEngagement = {
  engagement_id:        string
  contact_id:           string | null
  owner_id:             string | null         // HubSpot-user die de call deed
  owner_email:          string | null         // afgeleid via owners-API
  timestamp_iso:        string                // wanneer de call gebeurde
  call_status:          string | null         // bv. "COMPLETED"
  disposition_id:       string | null         // ruwe HubSpot-disposition GUID
  disposition_label:    string | null         // leesbaar label (bv. "Connected")
  body:                 string | null         // notities
  duration_ms:          number | null
}

/**
 * Haal alle call-engagements op binnen een datum-window via de legacy v1
 * engagements-API.
 *
 * Werkt met `crm.objects.contacts.read` (i.p.v. de aparte `crm.objects.calls.read`
 * die enkel beschikbaar is voor "Calling Extension"-apps). De v1 endpoint
 * `/engagements/v1/engagements/paged` returnt ALLE engagement-types — we
 * filteren in JS op type='CALL' + timestamp binnen window.
 *
 * Pagination: van nieuw → oud. We stoppen zodra een hele pagina ouder is dan
 * fromMs (bounded walk). Fallback: max 100 pages = 25k engagements.
 *
 * Contact-id zit ingebed in `associations.contactIds` — geen extra batch nodig.
 * Owner-email wordt apart gefetcht via /crm/v3/owners (gecached).
 */
export async function getCallEngagementsInWindow(
  accessToken: string,
  fromIso:     string,
  toIso:       string,
): Promise<HubSpotCallEngagement[]> {
  const fromMs = new Date(fromIso).getTime()
  const toMs   = new Date(toIso).getTime()

  const dispositions = await getCallDispositions(accessToken)        // gecached

  const out: HubSpotCallEngagement[] = []
  let offset: number | undefined

  type EngagementRaw = {
    engagement: {
      id:         number
      type:       string
      timestamp:  number
      ownerId:    number | null
      active:     boolean
    }
    associations?: {
      contactIds?: number[]
    }
    metadata?: {
      body?:                 string
      status?:               string
      disposition?:          string                          // GUID
      durationMilliseconds?: number
    }
  }

  for (let page = 0; page < 100; page++) {                           // 100 × 250 = 25k max
    const params = new URLSearchParams({ limit: '250' })
    if (offset != null) params.set('offset', String(offset))

    const res = await fetch(
      `${HUBSPOT_API_BASE}/engagements/v1/engagements/paged?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`HubSpot engagements v1 mislukt: ${res.status} ${txt}`)
    }
    const data = await res.json() as {
      results?: EngagementRaw[]
      hasMore?: boolean
      offset?:  number
    }

    let allOlder = true
    for (const r of data.results ?? []) {
      const ts = r.engagement.timestamp
      if (ts > toMs)        continue                                  // toekomstig — skip
      if (ts < fromMs)       continue                                  // ouder — wel eindcheck
      allOlder = false
      if (r.engagement.type !== 'CALL') continue
      if (!r.engagement.active)         continue                       // gearchiveerd

      const dispoId = r.metadata?.disposition ?? null
      out.push({
        engagement_id:     String(r.engagement.id),
        contact_id:        r.associations?.contactIds?.[0] != null
                            ? String(r.associations.contactIds[0])
                            : null,
        owner_id:          r.engagement.ownerId != null ? String(r.engagement.ownerId) : null,
        owner_email:       null,                                      // verrijkt verderop
        timestamp_iso:     new Date(ts).toISOString(),
        call_status:       r.metadata?.status ?? null,
        disposition_id:    dispoId,
        disposition_label: dispoId ? (dispositions.get(dispoId) ?? null) : null,
        body:              r.metadata?.body ?? null,
        duration_ms:       r.metadata?.durationMilliseconds ?? null,
      })
    }

    // Stop-conditie: hele pagina ouder dan window én geen newer items meer
    // (de v1 API sorteert op lastUpdated desc — niet 100% chronologisch op
    // engagement.timestamp, dus we vertrouwen op `hasMore` voor stoppen tenzij
    // we ALLE items op deze pagina ouder zien).
    if (!data.hasMore)  break
    if (allOlder)       break
    offset = data.offset
    if (offset == null) break
  }

  // Verrijk met owner-email voor caller-attributie
  if (out.length > 0) {
    await enrichCallsWithOwnerEmail(accessToken, out)
  }

  return out
}

/**
 * Stript HTML uit HubSpot's hs_call_body — die kan rich-text bevatten met
 * <div>, <p>, etc. We willen plain text in CallScope's notes-veld.
 */
export function stripHtml(html: string | null): string | null {
  if (!html) return null
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null
}

/**
 * Map HubSpot's call disposition naar CallScope's status-string.
 * HubSpot heeft een vaste set built-in dispositions; klanten kunnen zelf ook
 * custom dispositions toevoegen, dus we werken op het LABEL i.p.v. id.
 *
 * Mapping-keuzes:
 *   - "Connected"             → "bereikt"
 *   - "Left voicemail"        → "voicemail"        (telt niet als bereikt)
 *   - "No answer"             → "niet bereikt"
 *   - "Busy"                  → "niet bereikt"
 *   - "Wrong number"          → "verkeerd nummer"
 *   - default                 → label letterlijk overnemen (klant kan custom
 *                               disposition hebben zoals "Afspraak gemaakt")
 *
 * Het label wordt 1-op-1 als status gebruikt zodat de upload_summary's
 * regex-filters (`%afspraak%`, `%niet bereikt%`) er natuurlijk op werken.
 */
export function mapHubSpotDispositionToStatus(label: string | null): string | null {
  if (!label) return null
  const norm = label.toLowerCase()

  if (norm === 'connected'                           ) return 'bereikt'
  if (norm.includes('voicemail')                     ) return 'voicemail'
  if (norm === 'no answer'      || norm === 'no-answer') return 'niet bereikt'
  if (norm === 'busy'                                ) return 'niet bereikt'
  if (norm.includes('wrong number')                  ) return 'verkeerd nummer'

  // Custom disposition? Label letterlijk overnemen — als de cc_manager een
  // disposition "Afspraak gemaakt" heeft, telt de upload_summary view die
  // automatisch als appointment via de %afspraak%-filter.
  return label
}

// ── Caching: dispositions + owners ─────────────────────────────────────────

const callDispositionsCache = new Map<string, Map<string, string>>()

/**
 * HubSpot's standaard call-dispositions met hun universele GUIDs. Deze IDs
 * zijn dezelfde voor alle HubSpot-accounts en worden hardcoded gebruikt als
 * fallback wanneer de /calling/v1/dispositions endpoint geen toegang heeft
 * (vereist soms de calls.read scope die we niet hebben).
 *
 * Custom dispositions die de klant zelf heeft aangemaakt worden alleen als
 * label opgepikt als de /calling endpoint wel werkt — anders blijft de GUID
 * staan en kan de klant later een mapping toevoegen via Settings → Calling.
 */
const STANDARD_DISPOSITIONS: Record<string, string> = {
  '9d9162e7-6cf3-4944-bf63-4dff82258764': 'Connected',
  'b2cf5968-551e-4856-9783-52b3da59a7d0': 'Left voicemail',
  'a4c4c377-d246-4b32-a13b-75a56a4cd0ff': 'Left live message',
  '73a0d17f-1163-4015-bdd5-ec830791da20': 'No answer',
  'f240bbac-87c9-4f6e-bf70-924b57d47db7': 'Busy',
  '17b47fee-58de-441e-a44c-c6300d46f273': 'Wrong number',
}

/**
 * Geeft een lookup terug van disposition-id → label.
 *
 * Strategie: start altijd met de hardcoded standaard set, probeer daarbovenop
 * /calling/v1/dispositions voor account-specifieke custom labels. Als die
 * endpoint 4xx returnt (geen scope), houden we gewoon de standaard set —
 * voldoende voor 95% van de gevallen.
 *
 * Per accessToken gecached zodat we het maar één keer per cron-run doen.
 */
async function getCallDispositions(accessToken: string): Promise<Map<string, string>> {
  const cached = callDispositionsCache.get(accessToken)
  if (cached) return cached

  // Baseline: hardcoded standaard set — werkt altijd
  const map = new Map<string, string>(Object.entries(STANDARD_DISPOSITIONS))

  // Pad 1: legacy /calling/v1/dispositions endpoint. Werkt op de meeste
  // accounts maar niet altijd op dev test-accounts of beperkte app-types.
  try {
    const res = await fetch(
      `${HUBSPOT_API_BASE}/calling/v1/dispositions`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (res.ok) {
      const data = await res.json() as Array<{ id: string; label: string }>
      for (const d of data) map.set(d.id, d.label)
    }
  } catch {
    // Niet-kritisch — we proberen pad 2
  }

  // Pad 2: v3 property-schema. De property hs_call_disposition heeft een
  // enum met alle dispositions van het account (standaard + custom). Dit is
  // de canonical bron en werkt zodra de app `crm.objects.calls.read` of
  // `crm.schemas.calls.read` scope heeft.
  try {
    const res = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/properties/calls/hs_call_disposition`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (res.ok) {
      const data = await res.json() as {
        options?: Array<{ value: string; label: string }>
      }
      for (const opt of data.options ?? []) {
        // value = GUID, label = "Afspraak gemaakt." etc.
        map.set(opt.value, opt.label)
      }
    }
  } catch {
    // Beide failed → we werken met de hardcoded baseline.
    // Standaard dispositions blijven dan werken; custom labels worden null.
  }

  callDispositionsCache.set(accessToken, map)
  return map
}

const ownerEmailCache = new Map<string, Map<string, string>>()

/**
 * Verrijk een lijst calls met owner_email via batch /crm/v3/owners.
 * We laden alle owners één keer per accessToken (gecached) — meestal zijn
 * dat enkele tientallen users, geen issue voor één call.
 */
async function enrichCallsWithOwnerEmail(
  accessToken: string,
  calls: HubSpotCallEngagement[],
): Promise<void> {
  let map = ownerEmailCache.get(accessToken)
  if (!map) {
    map = new Map<string, string>()
    try {
      let after: string | undefined
      for (let i = 0; i < 10; i++) {
        const params = new URLSearchParams({ limit: '100' })
        if (after) params.set('after', after)
        const res = await fetch(
          `${HUBSPOT_API_BASE}/crm/v3/owners?${params}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        if (!res.ok) break
        const data = await res.json() as {
          results?: { id: string; email?: string }[]
          paging?:  { next?: { after?: string } }
        }
        for (const o of data.results ?? []) {
          if (o.email) map.set(o.id, o.email.toLowerCase())
        }
        after = data.paging?.next?.after
        if (!after) break
      }
    } catch {
      // Fallback: leeg map, owner_email blijft null
    }
    ownerEmailCache.set(accessToken, map)
  }

  for (const c of calls) {
    if (c.owner_id) c.owner_email = map.get(c.owner_id) ?? null
  }
}

/**
 * Batch-fetch contact-info (email, naam, telefoon) voor een lijst contact-ids.
 * Returnt een Map keyed by contact_id.
 */
export async function getContactsBatch(
  accessToken: string,
  contactIds: string[],
): Promise<Map<string, HubSpotContact>> {
  const out = new Map<string, HubSpotContact>()
  if (contactIds.length === 0) return out

  for (let i = 0; i < contactIds.length; i += 100) {
    const batch = contactIds.slice(i, i + 100)
    const res = await fetch(
      `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/batch/read`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          properties: ['email', 'firstname', 'lastname', 'phone', 'mobilephone'],
          inputs:     batch.map(id => ({ id })),
        }),
      },
    )
    if (!res.ok) continue
    const data = await res.json() as {
      results?: Array<{ id: string; properties: Record<string, string | null> }>
    }
    for (const r of data.results ?? []) {
      out.set(r.id, {
        id:        r.id,
        email:     r.properties.email ?? null,
        firstname: r.properties.firstname ?? null,
        lastname:  r.properties.lastname ?? null,
        phone:     r.properties.phone ?? r.properties.mobilephone ?? null,
      })
    }
  }
  return out
}

/**
 * Direct dealstage ophalen voor een specifiek deal-id (caching path).
 * Gebruikt zodra we een hubspot_deal_id hebben opgeslagen op call_records.
 */
export async function getDealstageById(
  accessToken: string,
  dealId: string,
): Promise<{ dealstage_id: string; dealstage_label: string } | null> {
  const res = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/deals/${dealId}?properties=dealstage,pipeline`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (res.status === 404) return null
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`HubSpot deal fetch mislukt: ${res.status} ${txt}`)
  }
  const data = await res.json() as {
    properties?: { dealstage?: string; pipeline?: string }
  }
  const stageId = data.properties?.dealstage
  if (!stageId) return null

  const label = await getDealstageLabel(accessToken, data.properties?.pipeline ?? null, stageId)
  return { dealstage_id: stageId, dealstage_label: label }
}