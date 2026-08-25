import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { requireStripe } from '@/lib/stripe'

/**
 * POST /api/billing/portal
 *
 * Maakt een Stripe Billing Portal Session voor de huidige cc-manager.
 * Daar kan hij/zij abonnementen beheren, opzeggen, betaalmethodes wijzigen,
 * facturen downloaden — allemaal via Stripe's hosted UI (geen eigen dev werk).
 *
 * Vereist: profile.stripe_customer_id (bestaat na de eerste checkout).
 */
export async function POST(req: NextRequest) {
  try {
    const stripe = requireStripe()
    const supabase = createSbClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, role')
      .eq('id', user.id)
      .single()

    type ProfileLite = { stripe_customer_id: string | null; role: string }
    const p = profile as ProfileLite | null
    if (!p || p.role !== 'cc_manager') {
      return NextResponse.json({ error: 'Alleen cc-managers kunnen abonnementen beheren' }, { status: 403 })
    }
    if (!p.stripe_customer_id) {
      return NextResponse.json({
        error: 'Geen Stripe-klant gekoppeld. Activeer eerst een abonnement op een project.',
      }, { status: 400 })
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin

    const session = await stripe.billingPortal.sessions.create({
      customer: p.stripe_customer_id,
      return_url: `${baseUrl}/dashboard/settings/account`,
    })

    return NextResponse.json({ url: session.url })
  } catch (e) {
    console.error('[billing/portal] error:', e)
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
