import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { ProjectGoogleSheet } from '@/types/database'

/**
 * GET /api/cron/google-sync
 *
 * Wordt dagelijks aangeroepen door Vercel Cron (zie vercel.json).
 * Loopt over álle project_google_sheets-bindings en triggert per binding
 * een sync via /api/projects/[id]/google-sync (met CRON_SECRET-bypass voor auth).
 *
 * Filter is impliciet "vandaag in Brussels" — wordt door de sync-endpoint zelf
 * toegepast. Cron tijdstip in vercel.json staat op 22:55 UTC = 23:55 winter /
 * 00:55 zomer Brussels-tijd.
 *
 * Beveiligd via Bearer-token = CRON_SECRET (door Vercel Cron automatisch
 * meegestuurd). Manuele/onbevoegde calls worden geblokkeerd.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET niet geconfigureerd' }, { status: 500 })
  }

  const authHeader = req.headers.get('authorization') ?? ''
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Service role client — RLS bypass om alle bindings te kunnen ophalen
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: bindingsData, error: bErr } = await sb
    .from('project_google_sheets')
    .select('id, project_id, caller_id, sheet_name')
  if (bErr) {
    return NextResponse.json({ error: `Bindings ophalen mislukt: ${bErr.message}` }, { status: 500 })
  }
  const allBindings = (bindingsData ?? []) as Pick<ProjectGoogleSheet, 'id' | 'project_id' | 'caller_id' | 'sheet_name'>[]

  if (allBindings.length === 0) {
    return NextResponse.json({ ok: true, message: 'Geen bindings om te syncen', count: 0 })
  }

  // Filter projecten op billing-status — sync enkel waar abonnement actief is
  // OF trial nog loopt. Bespaart Stripe-pijn én vermijdt 402-spam in logs.
  const projectIds = Array.from(new Set(allBindings.map(b => b.project_id)))
  const { data: projRows } = await sb
    .from('projects')
    .select('id, subscription_status, trial_ends_at')
    .in('id', projectIds)
  type ProjLite = { id: string; subscription_status: string; trial_ends_at: string | null }
  const eligibleIds = new Set<string>()
  const skippedBilling: { project_id: string; reason: string }[] = []
  for (const p of (projRows ?? []) as ProjLite[]) {
    const trialOk = p.subscription_status === 'trialing' &&
                    p.trial_ends_at && new Date(p.trial_ends_at) > new Date()
    if (p.subscription_status === 'active' || trialOk) {
      eligibleIds.add(p.id)
    } else {
      skippedBilling.push({ project_id: p.id, reason: p.subscription_status })
    }
  }
  const bindings = allBindings.filter(b => eligibleIds.has(b.project_id))

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const results: Array<{
    binding_id: string
    project_id: string
    caller_id: string
    ok: boolean
    imported?: number
    error?: string
  }> = []

  // Sequentieel doorlopen — Google Sheets API rate limits zijn 60 req/min/user,
  // en parallel hammeren riskeert errors als alle bindings van dezelfde user zijn.
  for (const b of bindings) {
    try {
      const res = await fetch(`${baseUrl}/api/projects/${b.project_id}/google-sync`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cronSecret}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ caller_id: b.caller_id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        results.push({
          binding_id: b.id, project_id: b.project_id, caller_id: b.caller_id,
          ok: false, error: data.error ?? `HTTP ${res.status}`,
        })
      } else {
        results.push({
          binding_id: b.id, project_id: b.project_id, caller_id: b.caller_id,
          ok: true, imported: data.imported ?? 0,
        })
      }
    } catch (e) {
      results.push({
        binding_id: b.id, project_id: b.project_id, caller_id: b.caller_id,
        ok: false, error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const totalImported = results.reduce((s, r) => s + (r.imported ?? 0), 0)
  const errors = results.filter(r => !r.ok).length

  console.log(
    `[cron/google-sync] ${results.length} bindings, ${totalImported} records, ${errors} errors, ` +
    `${skippedBilling.length} bindings overgeslagen wegens billing-status`
  )

  return NextResponse.json({
    ok: true,
    bindings: results.length,
    imported: totalImported,
    errors,
    skippedBilling,
    results,
  })
}
