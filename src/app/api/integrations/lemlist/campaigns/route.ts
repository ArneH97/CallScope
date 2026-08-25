import { NextResponse } from 'next/server'

/**
 * Deprecated: gebruik /api/integrations/lemlist/sources.
 *
 * Sinds 2026-05-04 (rev 2) werken we met task-sources i.p.v. campaigns —
 * cold callers in Lemlist hebben vaak geen campaign-toegang. Deze route
 * blijft bestaan maar redirect naar /sources voor backwards-compat.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  return NextResponse.redirect(new URL('/api/integrations/lemlist/sources', url.origin), 308)
}
