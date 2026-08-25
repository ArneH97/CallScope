/**
 * Google Calendar API wrapper.
 *
 * Wordt gebruikt door de appointment-planner om:
 *   1) De primary calendar van sales reps te lezen en busy slots + provincie-
 *      tagged all-day events te ontdekken.
 *   2) Een nieuwe afspraak-event te schrijven wanneer de cold caller een slot
 *      boekt.
 *
 * Bouwt voort op `lib/google.ts` voor de token-refresh logica. We gebruiken
 * de "primary" calendar van de user — als reps later met meerdere calendars
 * willen werken kan dat een per-user instelling worden.
 */

import { getValidAccessToken } from './google'

const CAL_BASE = 'https://www.googleapis.com/calendar/v3'

export type CalendarEvent = {
  id:           string
  summary:      string | null
  description:  string | null
  location:     string | null
  /** Start datum-tijd ISO, of YYYY-MM-DD voor all-day events. */
  start:        string
  /** End datum-tijd ISO, of YYYY-MM-DD voor all-day events. */
  end:          string
  /** True = all-day event (geen tijdscomponent). */
  isAllDay:     boolean
  /** Status: 'confirmed' | 'tentative' | 'cancelled'. */
  status:       string
  /** True als de event door deze user als out-of-office gemarkeerd is. */
  isBusy:       boolean
  htmlLink:     string | null
}

/**
 * Lijst alle events tussen timeMin en timeMax voor de primary calendar van
 * de gegeven user. Returnt zowel timed events (busy slots) als all-day events
 * (provincie-tags) — caller bepaalt zelf hoe te interpreteren.
 *
 * Token refresh + retry wordt afgehandeld door getValidAccessToken; bij een
 * 401 (token mid-flight verlopen) doen we 1 retry.
 */
export async function listCalendarEvents(
  userId:    string,
  timeMin:   Date,
  timeMax:   Date,
): Promise<CalendarEvent[]> {
  return await listCalendarEventsImpl(userId, timeMin, timeMax, /*retry=*/true)
}

async function listCalendarEventsImpl(
  userId:  string,
  timeMin: Date,
  timeMax: Date,
  retry:   boolean,
): Promise<CalendarEvent[]> {
  const accessToken = await getValidAccessToken(userId)

  const params = new URLSearchParams({
    timeMin:      timeMin.toISOString(),
    timeMax:      timeMax.toISOString(),
    singleEvents: 'true',           // expand recurring events
    orderBy:      'startTime',
    maxResults:   '250',
  })
  const url = `${CAL_BASE}/calendars/primary/events?${params}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (res.status === 401 && retry) {
    // Token kan net verlopen zijn — getValidAccessToken zal bij volgende call
    // refreshen. Eenmalig opnieuw proberen.
    return await listCalendarEventsImpl(userId, timeMin, timeMax, /*retry=*/false)
  }

  if (res.status === 403) {
    const body = await res.text().catch(() => '')
    throw new CalendarScopeError(
      `Calendar API gaf 403 — sales rep ${userId} heeft waarschijnlijk de calendar.events scope nog niet toegekend. Body: ${body.slice(0, 200)}`
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Calendar list mislukt: ${res.status} ${body.slice(0, 200)}`)
  }

  const data = await res.json() as GoogleCalendarListResponse
  return (data.items ?? []).map(parseEvent)
}

/**
 * Maak een nieuwe afspraak-event aan in de primary calendar van de sales rep.
 * Returnt het Google event-id zodat we 'm later kunnen updaten of annuleren.
 *
 * Conventies:
 *   - Tijdzone wordt expliciet 'Europe/Brussels' gezet zodat een 10:00 NL/BE
 *     correct in de rep's agenda staat ongeacht z'n device-tz.
 *   - description krijgt zowel de cold-caller notitie als CallScope-context
 *     (lead-naam + adres) zodat de rep weet waar hij heen moet.
 *   - location wordt het lead-adres → werkt in Google Maps integratie.
 */
export async function createCalendarEvent(
  userId: string,
  input: {
    summary:     string
    description: string
    location:    string
    start:       Date
    end:         Date
    /** Email van de cold caller voor de "organizer" suggestion — optioneel. */
    coldCallerEmail?: string
  },
): Promise<{ id: string; htmlLink: string | null }> {
  const accessToken = await getValidAccessToken(userId)

  const body: Record<string, unknown> = {
    summary:     input.summary,
    description: input.description,
    location:    input.location,
    start: {
      dateTime: input.start.toISOString(),
      timeZone: 'Europe/Brussels',
    },
    end: {
      dateTime: input.end.toISOString(),
      timeZone: 'Europe/Brussels',
    },
    // Geen attendees — we creëren in de eigen calendar van de rep, geen
    // automatische invite naar de lead. Cold caller belt zelf om bevestiging.
  }

  const res = await fetch(`${CAL_BASE}/calendars/primary/events`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  if (res.status === 403) {
    const errBody = await res.text().catch(() => '')
    throw new CalendarScopeError(
      `Calendar API gaf 403 bij event create — scope mist. Body: ${errBody.slice(0, 200)}`
    )
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Calendar event create mislukt: ${res.status} ${errBody.slice(0, 300)}`)
  }
  const data = await res.json() as { id: string; htmlLink?: string }
  return { id: data.id, htmlLink: data.htmlLink ?? null }
}

/**
 * Specifieke error class zodat de API-route hem kan herkennen en een
 * "reauthorize Google" banner kan tonen i.p.v. een generieke 500.
 */
export class CalendarScopeError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'CalendarScopeError'
  }
}

// ── Parsing ────────────────────────────────────────────────────────────────

type GoogleCalendarListResponse = {
  items?: GoogleCalendarEvent[]
}

type GoogleCalendarEvent = {
  id:          string
  summary?:    string
  description?: string
  location?:   string
  status?:     string
  htmlLink?:   string
  start?:      { date?: string; dateTime?: string }
  end?:        { date?: string; dateTime?: string }
  /** "opaque" = busy (default), "transparent" = niet meetellen */
  transparency?: string
  eventType?:  string
}

function parseEvent(e: GoogleCalendarEvent): CalendarEvent {
  const isAllDay = !!e.start?.date && !e.start?.dateTime
  return {
    id:          e.id,
    summary:     e.summary ?? null,
    description: e.description ?? null,
    location:    e.location ?? null,
    start:       e.start?.dateTime ?? e.start?.date ?? '',
    end:         e.end?.dateTime   ?? e.end?.date   ?? '',
    isAllDay,
    status:      e.status ?? 'confirmed',
    // "transparent" events tellen niet als bezet (bv. info-events,
    // birthdays). Default in Google is "opaque" (bezet).
    isBusy:      e.transparency !== 'transparent' && e.status !== 'cancelled',
    htmlLink:    e.htmlLink ?? null,
  }
}
