import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { requireStripe } from '@/lib/stripe'
import type Stripe from 'stripe'

/**
 * POST /api/billing/webhook
 *
 * Stripe webhook endpoint. Vereist:
 *   - STRIPE_SECRET_KEY  (voor signature-verificatie via SDK)
 *   - STRIPE_WEBHOOK_SECRET (whsec_... uit Stripe Dashboard)
 *
 * Behandelde events:
 *   - checkout.session.completed       → eerste betaling → project actief
 *   - customer.subscription.updated    → status changed (renewals, past_due, ...)
 *   - customer.subscription.deleted    → opgezegd → project geblokkeerd
 *
 * Andere events worden genegeerd (return 200 zodat Stripe niet retried).
 */

// Belangrijk voor Next.js: raw body nodig voor Stripe signature-verificatie.
// Schakelen body-parsing uit door route op runtime nodejs te zetten en req.text() te gebruiken.
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const stripe = requireStripe()
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    return NextResponse.json({ error: 'STRIPE_WEBHOOK_SECRET niet geconfigureerd' }, { status: 500 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 })
  }

  // Raw body lezen — vereist voor signature-verificatie
  const rawBody = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Onbekende fout'
    console.error('[billing/webhook] signature-verificatie mislukt:', msg)
    return NextResponse.json({ error: `Signature invalid: ${msg}` }, { status: 400 })
  }

  // Service role om RLS te bypassen voor de project-update
  const sb = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const projectId =
          session.metadata?.project_id ??
          (typeof session.client_reference_id === 'string' ? session.client_reference_id : null)
        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id

        if (!projectId || !subscriptionId) {
          console.warn('[billing/webhook] checkout.session.completed zonder project_id of subscription:', session.id)
          break
        }

        // Haal subscription op om price_id en status te krijgen
        const sub = await stripe.subscriptions.retrieve(subscriptionId)
        const priceId = sub.items.data[0]?.price?.id ?? null

        await sb.from('projects')
          .update({
            subscription_status:    'active',
            stripe_subscription_id: subscriptionId,
            stripe_price_id:        priceId,
          })
          .eq('id', projectId)

        console.log(`[billing/webhook] project ${projectId} → active (subscription ${subscriptionId})`)
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        const projectId = sub.metadata?.project_id
        if (!projectId) {
          console.warn('[billing/webhook] subscription.updated zonder project_id metadata:', sub.id)
          break
        }

        // Map Stripe status naar onze enum
        const stripeStatus = sub.status
        const ourStatus = mapStripeStatus(stripeStatus)

        await sb.from('projects')
          .update({
            subscription_status:    ourStatus,
            stripe_subscription_id: sub.id,
            stripe_price_id:        sub.items.data[0]?.price?.id ?? null,
          })
          .eq('id', projectId)

        console.log(`[billing/webhook] project ${projectId} → ${ourStatus} (Stripe: ${stripeStatus})`)
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        const projectId = sub.metadata?.project_id
        if (!projectId) {
          console.warn('[billing/webhook] subscription.deleted zonder project_id metadata:', sub.id)
          break
        }

        await sb.from('projects')
          .update({ subscription_status: 'cancelled' })
          .eq('id', projectId)

        console.log(`[billing/webhook] project ${projectId} → cancelled`)
        break
      }

      default:
        // Ander event-type — gewoon ack-en zodat Stripe niet retried
        console.log(`[billing/webhook] genegeerd event-type: ${event.type}`)
    }

    return NextResponse.json({ received: true })
  } catch (e) {
    console.error(`[billing/webhook] handler error voor ${event.type}:`, e)
    return NextResponse.json({ error: 'Handler error' }, { status: 500 })
  }
}

function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): string {
  switch (stripeStatus) {
    case 'active':              return 'active'
    case 'trialing':            return 'trialing'
    case 'past_due':            return 'past_due'
    case 'paused':              return 'paused'
    case 'canceled':
    case 'incomplete_expired':
    case 'unpaid':              return 'cancelled'
    case 'incomplete':          return 'past_due'  // wachten op eerste betaling
    default:                    return 'past_due'
  }
}
