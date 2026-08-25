/**
 * Onboarding e-mailsequence voor nieuwe CallScope-gebruikers.
 *
 * Drie momenten:
 *   - Dag 0  (registratie):       welkomstmail met de juiste eerste-stappen per rol
 *   - Dag 3  (na registratie):    "hoe gaat het?"-tip met meest gestelde vragen
 *   - Dag 11 (trial-reminder):    "trial loopt over 3 dagen af" — alleen voor cc_managers
 *                                 met een trial-project waarvan trial_ends_at nadert
 *
 * Elke functie accepteert een `locale` parameter zodat de mail in de taal
 * van de ontvanger wordt verstuurd. Default = 'nl' wanneer niet meegegeven
 * (backwards-compat met legacy callsites).
 *
 * Verzending via Resend. Geen mail wordt verstuurd als RESEND_API_KEY ontbreekt
 * (logwarnt en returnt — handig voor lokaal dev zonder mail).
 */

import type { Role } from '@/types/database'
import { getTranslations } from 'next-intl/server'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.callscope.be'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Bouw een locale-aware app-URL. NL (default) krijgt geen prefix; andere
 * talen krijgen `/en/...` etc. (zelfde regel als next-intl `localePrefix:
 * 'as-needed'`).
 */
function localeUrl(path: string, locale: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  const prefix = locale === 'nl' ? '' : `/${locale}`
  return `${APP_URL}${prefix}${cleanPath}`
}

/** Resend send. Returns boolean: true = OK, false = skipped/failed (gelogd). */
async function sendEmail(p: {
  to:      string
  subject: string
  html:    string
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[onboarding] RESEND_API_KEY ontbreekt — mail niet verstuurd')
    return false
  }
  const from = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev'
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from,
        to:      [p.to],
        subject: p.subject,
        html:    p.html,
      }),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      console.error(`[onboarding] Resend faalde ${res.status}: ${txt}`)
      return false
    }
    return true
  } catch (e) {
    console.error('[onboarding] Resend error:', e)
    return false
  }
}

// ── Email templates ────────────────────────────────────────────────────────

/** Wrapper-styling die elke mail consistent houdt. Voettekst is locale-aware. */
function wrapBody(headline: string, content: string, footerText: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;">
        <div style="width:32px;height:32px;background:#1a35e6;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;">CS</div>
        <span style="font-size:18px;font-weight:600;">CallScope</span>
      </div>
      <h1 style="font-size:22px;font-weight:600;color:#111827;margin:0 0 16px;line-height:1.3;">${headline}</h1>
      ${content}
      <p style="font-size:12px;color:#9ca3af;margin-top:32px;border-top:1px solid #f3f4f6;padding-top:16px;">
        ${escapeHtml(footerText)}
      </p>
    </div>
  `
}

// ── DAG 0 ─ Welkom ─────────────────────────────────────────────────────────

export async function sendWelcomeEmail(p: {
  to:        string
  fullName:  string | null
  role:      Role
  locale?:   string
}): Promise<boolean> {
  const locale = p.locale ?? 'nl'
  const t      = await getTranslations({ locale, namespace: 'emails.welcome' })
  const tWrap  = await getTranslations({ locale, namespace: 'emails.wrapper' })

  const firstName = (p.fullName?.split(' ')[0] ?? '').trim() || t('firstNameFallback')

  // Per-role config uit messages
  const intro    = t(`${p.role}.intro`)
  const steps    = t.raw(`${p.role}.steps`) as string[]
  const ctaPath  = t(`${p.role}.ctaPath`)
  const ctaLabel = t(`${p.role}.ctaLabel`)

  const headline = t('headline', { firstName: escapeHtml(firstName) })

  // Steps mogen <strong> bevatten — die zijn intentioneel HTML, niet escapen.
  const stepsHtml = steps.map((s, i) => `
    <li style="margin-bottom:12px;line-height:1.5;">
      <span style="display:inline-block;background:#eef2ff;color:#1a35e6;font-weight:600;width:22px;height:22px;border-radius:11px;text-align:center;line-height:22px;font-size:12px;margin-right:6px;">${i + 1}</span>
      ${s}
    </li>
  `).join('')

  const ctaUrl = localeUrl(ctaPath, locale)

  const content = `
    <p style="font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(intro)}</p>
    <ul style="list-style:none;padding:0;margin:24px 0;">
      ${stepsHtml}
    </ul>
    <p style="margin:32px 0;">
      <a href="${escapeHtml(ctaUrl)}"
         style="display:inline-block;background:#1a35e6;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">
        ${escapeHtml(ctaLabel)}
      </a>
    </p>
    <p style="font-size:14px;color:#6b7280;line-height:1.6;">
      ${escapeHtml(t('bottomTip'))}
    </p>
  `

  return sendEmail({
    to:      p.to,
    subject: t('subject', { firstName }),
    html:    wrapBody(headline, content, tWrap('footer')),
  })
}

// ── DAG 3 ─ Tip ───────────────────────────────────────────────────────────

export async function sendTipEmail(p: {
  to:       string
  fullName: string | null
  role:     Role
  locale?:  string
}): Promise<boolean> {
  const locale = p.locale ?? 'nl'
  const t      = await getTranslations({ locale, namespace: 'emails.tip' })
  const tWrap  = await getTranslations({ locale, namespace: 'emails.wrapper' })

  const firstName = (p.fullName?.split(' ')[0] ?? '').trim() || t('firstNameFallback')

  const headline = t('headline', { firstName: escapeHtml(firstName) })
  const ctaUrl   = localeUrl(t('ctaPath'), locale)

  const content = `
    <p style="font-size:15px;line-height:1.6;color:#374151;">
      ${escapeHtml(t('intro'))}
    </p>
    <div style="background:#f9fafb;border-radius:10px;padding:16px;margin:16px 0;">
      <div style="font-weight:600;color:#111827;margin-bottom:6px;">${escapeHtml(t('card1Title'))}</div>
      <p style="font-size:14px;color:#6b7280;line-height:1.5;margin:0;">
        ${escapeHtml(t('card1Body'))}
      </p>
    </div>
    <div style="background:#f9fafb;border-radius:10px;padding:16px;margin:16px 0;">
      <div style="font-weight:600;color:#111827;margin-bottom:6px;">${escapeHtml(t('card2Title'))}</div>
      <p style="font-size:14px;color:#6b7280;line-height:1.5;margin:0;">
        ${escapeHtml(t('card2Body'))}
      </p>
    </div>
    <div style="background:#f9fafb;border-radius:10px;padding:16px;margin:16px 0;">
      <div style="font-weight:600;color:#111827;margin-bottom:6px;">${escapeHtml(t('card3Title'))}</div>
      <p style="font-size:14px;color:#6b7280;line-height:1.5;margin:0;">
        ${escapeHtml(t('card3Body'))}
      </p>
    </div>
    <p style="margin:24px 0;">
      <a href="${escapeHtml(ctaUrl)}"
         style="display:inline-block;background:#1a35e6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">
        ${escapeHtml(t('ctaLabel'))}
      </a>
    </p>
    <p style="font-size:14px;color:#6b7280;line-height:1.6;">
      ${escapeHtml(t('bottomTip'))}
    </p>
  `

  return sendEmail({
    to:      p.to,
    subject: t('subject', { firstName }),
    html:    wrapBody(headline, content, tWrap('footer')),
  })
}

// ── DAG 11 ─ Trial reminder ────────────────────────────────────────────────

export async function sendTrialReminderEmail(p: {
  to:           string
  fullName:     string | null
  projectName:  string
  trialEndsAt:  string  // ISO string
  locale?:      string
}): Promise<boolean> {
  const locale = p.locale ?? 'nl'
  const t      = await getTranslations({ locale, namespace: 'emails.trialReminder' })
  const tWrap  = await getTranslations({ locale, namespace: 'emails.wrapper' })

  const firstName = (p.fullName?.split(' ')[0] ?? '').trim() || t('firstNameFallback')

  // Datum localiseren — 'nl' → "5 mei", 'en' → "May 5"
  const intlLocale = locale === 'nl' ? 'nl-BE' : 'en-GB'
  const trialDate = new Date(p.trialEndsAt).toLocaleDateString(intlLocale, {
    day: 'numeric', month: 'long',
  })

  const headline = t('headline')
  const ctaUrl   = localeUrl(t('ctaPath'), locale)

  // body1 + body2 hebben <strong>-tags die NIET geescaped mogen worden — we
  // injecteren dus de raw vertaling met user-data al ge-escaped.
  const body1 = t('body1', {
    firstName:   escapeHtml(firstName),
    projectName: escapeHtml(p.projectName),
    date:        escapeHtml(trialDate),
  })
  const body2 = t('body2')

  const content = `
    <p style="font-size:15px;line-height:1.6;color:#374151;">
      ${body1}
    </p>
    <p style="font-size:15px;line-height:1.6;color:#374151;">
      ${escapeHtml(body2)}
    </p>
    <p style="margin:24px 0;">
      <a href="${escapeHtml(ctaUrl)}"
         style="display:inline-block;background:#1a35e6;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:500;">
        ${escapeHtml(t('ctaLabel'))}
      </a>
    </p>
    <p style="font-size:13px;color:#9ca3af;line-height:1.6;">
      ${escapeHtml(t('bottomTip'))}
    </p>
  `

  return sendEmail({
    to:      p.to,
    subject: t('subject', { projectName: p.projectName, date: trialDate }),
    html:    wrapBody(headline, content, tWrap('footer')),
  })
}
