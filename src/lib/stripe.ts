import Stripe from 'stripe'

/**
 * Server-side Stripe SDK instantie. Lazy om server-only env vars veilig te
 * houden. STRIPE_SECRET_KEY moet ingesteld zijn op Vercel (test of live).
 *
 * apiVersion: gepind zodat Stripe-API updates ons niet stilletjes breken.
 */
const apiKey = process.env.STRIPE_SECRET_KEY

export const stripe = apiKey
  ? new Stripe(apiKey, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
      typescript: true,
    })
  : null

export function requireStripe(): Stripe {
  if (!stripe) {
    throw new Error('STRIPE_SECRET_KEY is niet geconfigureerd op de server')
  }
  return stripe
}
