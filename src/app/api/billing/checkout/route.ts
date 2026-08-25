import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSbClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { requireStripe } from '@/lib/stripe'

/**
 * POST /api/billing/checkout
 * body: { project_id }
 *
 * Maakt een Stripe Checkout Session voor een subscription op één project.
 * Retourneert de URL waar de cc-manager naar geredirect moet worden om te betalen.
 *
 * Flow:
 *   1. Authenticeer caller (cc_manager + project-owner via call_center)
 *   2. Lookup of maak Stripe Customer voor deze gebruiker (profiles.stripe_customer_id)
 *   3. Maak Checkout Session met subscription_data.metadata.project_id zodat
 *      de webhook later weet welk project geactiveerd moet worden
 *   4. Return session.url voor client-side redirect
 */
export async function POST(req: NextRequest) {
  try {
    const stripe = requireStripe()
    const priceId = process.env.STRIPE_PRICE_ID
    if (!priceId) {
      return NextResponse.json({ error: 'STRIPE_PRICE_ID niet geconfigureerd' }, { status: 500 })
    }

    const body = await req.json().catch(() => ({}))
    const projectId: string | undefined = body.project_id
    if (!projectId) {
      return NextResponse.json({ error: 'project_id ontbreekt' }, { status: 400 })
    }

    // ── Auth: cc_manager moet eigenaar van project zijn ──────────────────
    const supabase = createSbClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
    }

    const { data: profileRow } = await supabase
      .from('profiles')
      .select('id, role, email, full_name, stripe_customer_id')
      .eq('id', user.id)
      .single()

    type ProfileLite = {
      id: string; role: string; email: string | null
      full_name: string | null; stripe_customer_id: string | null
    }
    const profile = profileRow as ProfileLite | null
    if (!profile || profile.role !== 'cc_manager') {
      return NextResponse.json({ error: 'Alleen cc-managers kunnen abonnementen activeren' }, { status: 403 })
    }

    // Verifieer eigenaarschap project via call_center
    const { data: ownership } = await supabase
      .from('project_call_centers')
      .select('project_id, call_center_id, call_centers!inner(manager_id)')
      .eq('project_id', projectId)
      .single()

    type Ownership = {
      project_id: string
      call_center_id: string
      call_centers: { manager_id: string } | { manager_id: string }[] | null
    }
    const own = ownership as Ownership | null
    const ccObj = Array.isArray(own?.call_centers) ? own?.call_centers[0] : own?.call_centers
    if (!own || ccObj?.manager_id !== user.id) {
      return NextResponse.json({ error: 'Geen toegang tot dit project' }, { status: 403 })
    }

    // ── Stripe Customer ophalen of aanmaken ───────────────────────────────
    // Service role nodig om profiles.stripe_customer_id te kunnen schrijven.
    const sbAdmin = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    let customerId = profile.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile.email ?? undefined,
        name:  profile.full_name ?? undefined,
        metadata: { profile_id: profile.id },
      })
      customerId = customer.id
      await sbAdmin.from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', profile.id)
    }

    // ── Checkout Session aanmaken ────────────────────────────────────────
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/dashboard/projects/${projectId}/settings?checkout=success`,
      cancel_url:  `${baseUrl}/dashboard/billing?project=${projectId}&checkout=cancelled`,
      subscription_data: {
        metadata: { project_id: projectId },
      },
      client_reference_id: projectId,
      billing_address_collection: 'required',
      allow_promotion_codes: true,
      // Stripe Tax: automatisch correcte BTW berekenen op basis van klant-adres.
      // Voor BE klanten = 21%. EU B2B met geldig BTW-nummer = reverse charge (0%).
      // Vereist dat Stripe Tax geactiveerd is in Stripe Dashboard.
      automatic_tax: { enabled: true },
      // Laat B2B-klanten hun BTW-nummer ingeven (verplicht voor reverse charge).
      tax_id_collection: { enabled: true },
      // Customer wordt geüpdatet met adres + naam uit checkout — nodig voor
      // automatic_tax bij volgende facturen + voor correcte facturatie.
      customer_update: {
        address: 'auto',
        name:    'auto',
      },
    })

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe gaf geen checkout-URL terug' }, { status: 500 })
    }

    return NextResponse.json({ url: session.url, session_id: session.id })
  } catch (e) {
    console.error('[billing/checkout] error:', e)
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
