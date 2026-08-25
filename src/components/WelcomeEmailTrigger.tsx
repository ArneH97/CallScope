'use client'

import { useEffect } from 'react'

/**
 * Stille client-component die bij eerste mount /api/onboarding/send-welcome
 * aanroept. De server-route is idempotent: enkel users zonder welcome_email_sent_at
 * krijgen een mail. Daarna gebeurt er niets meer.
 *
 * Geen UI feedback — dit loopt op de achtergrond.
 */
export default function WelcomeEmailTrigger() {
  useEffect(() => {
    fetch('/api/onboarding/send-welcome', { method: 'POST' })
      .catch(err => console.warn('[welcome-trigger] mail trigger faalde:', err))
  }, [])

  return null
}
