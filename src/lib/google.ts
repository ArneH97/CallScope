/**
 * Google Sheets / Drive helper.
 *
 * Verantwoordelijkheden:
 *   - Token refresh-flow (gebruikt service_role om DB te updaten)
 *   - Authenticated fetch wrappers voor Google APIs
 *
 * Gebruik:
 *   const accessToken = await getValidAccessToken(userId)
 *   const sheets = await listSpreadsheets(accessToken)
 */

import { createClient } from '@supabase/supabase-js'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Service-role Supabase client. Bypasst RLS — alleen server-side gebruiken.
 * Heeft toegang tot google_integrations.refresh_token voor de refresh-flow.
 */
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

/**
 * Geeft een geldig access_token terug voor de gegeven user.
 * Refresht via Google OAuth als de huidige token verlopen is (of bijna).
 *
 * Throws als de gebruiker geen Google-integratie heeft.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  const sb = getServiceClient()
  const { data, error } = await sb
    .from('google_integrations')
    .select('refresh_token, access_token, expires_at')
    .eq('user_id', userId)
    .single()

  if (error || !data) {
    throw new Error('Geen Google-integratie gevonden voor deze gebruiker')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const integration = data as any

  // Check of huidige access_token nog geldig is (60s buffer)
  if (integration.access_token && integration.expires_at) {
    const expiresAt = new Date(integration.expires_at).getTime()
    if (expiresAt > Date.now() + 60_000) {
      return integration.access_token as string
    }
  }

  // Refresh nodig
  const refreshRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: integration.refresh_token as string,
      grant_type:    'refresh_token',
    }),
  })

  if (!refreshRes.ok) {
    const body = await refreshRes.text().catch(() => '')
    throw new Error(`Google token refresh mislukt: ${refreshRes.status} ${body}`)
  }

  const tokens = await refreshRes.json() as {
    access_token: string
    expires_in:   number
    scope?:       string
    token_type?:  string
  }

  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

  // Update DB. Refresh_token blijft hetzelfde (Google geeft 'm niet altijd terug)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update: any = {
    access_token: tokens.access_token,
    expires_at:   newExpiresAt,
  }
  await sb.from('google_integrations').update(update).eq('user_id', userId)

  return tokens.access_token
}

/**
 * Wissel een autorisatie-code uit voor een token-paar bij Google.
 * Gebruikt na de OAuth-redirect.
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Google token exchange mislukt: ${res.status} ${body}`)
  }
  return res.json() as Promise<{
    access_token:  string
    refresh_token: string
    expires_in:    number
    scope:         string
    token_type:    string
    id_token?:     string
  }>
}

/**
 * Haal het Google-mailadres op via userinfo endpoint.
 */
export async function fetchGoogleUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  const data = await res.json() as { email?: string }
  return data.email ?? null
}

/**
 * Lijst alle spreadsheets waar de gebruiker toegang toe heeft.
 * Geeft maximaal `limit` resultaten terug, gesorteerd op laatst gewijzigd.
 */
export async function listSpreadsheets(accessToken: string, limit = 50) {
  const params = new URLSearchParams({
    q:        "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    pageSize: String(limit),
    fields:   'files(id,name,modifiedTime,webViewLink)',
    orderBy:  'modifiedTime desc',
  })
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Drive list mislukt: ${res.status} ${body}`)
  }
  const data = await res.json() as {
    files: { id: string; name: string; modifiedTime: string; webViewLink: string }[]
  }
  return data.files
}

/**
 * Haal de tab-namen op van een specifieke spreadsheet.
 */
export async function listSheetTabs(accessToken: string, spreadsheetId: string) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(title,sheetId))`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Sheet info mislukt: ${res.status} ${body}`)
  }
  const data = await res.json() as {
    sheets: { properties: { title: string; sheetId: number } }[]
  }
  return data.sheets.map(s => ({ id: s.properties.sheetId, title: s.properties.title }))
}

/**
 * Haal alle waardes uit een specifieke tab op (alle rijen, alle kolommen).
 * Eerste rij wordt als headers gebruikt — returnt array of objects.
 */
export async function fetchSheetRows(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
): Promise<Record<string, string>[]> {
  // We halen alle rijen op via "values" endpoint
  const range = encodeURIComponent(sheetName)
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Sheet values mislukt: ${res.status} ${body}`)
  }
  const data = await res.json() as { values?: string[][] }
  const rows = data.values ?? []
  if (rows.length < 2) return [] // 0 of 1 rij = geen data

  const headers = rows[0]
  return rows.slice(1).map(row => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = row[i] ?? '' })
    return obj
  })
}
