'use client'

import Link from 'next/link'
import type { Project } from '@/types/database'

interface Props {
  project: Pick<Project, 'id' | 'name' | 'trial_ends_at' | 'subscription_status'>
  /**
   * Compact = klein in-line label, geschikt voor projectkaarten in een lijst.
   * Full    = volle banner-card, geschikt bovenaan een project-pagina.
   */
  variant?: 'full' | 'compact'
}

/**
 * Toont de billing-status van een project: trial-aftelling, actieve abonnement,
 * of paywall (verlopen). Linkt naar de checkout/portal flow van Phase 2.
 */
export default function TrialBanner({ project, variant = 'full' }: Props) {
  const status = project.subscription_status
  const trialEnd = project.trial_ends_at ? new Date(project.trial_ends_at) : null

  // Actief abonnement → minimale info, geen actie nodig
  if (status === 'active') {
    if (variant === 'compact') {
      return (
        <span
          className="badge badge-green text-xs"
          title="Volgende factuur en opzeg-opties: open Stripe portal via Projecten-overzicht of accountinstellingen"
        >
          ✓ Actief abonnement
        </span>
      )
    }
    return null  // Geen banner nodig voor actieve projecten in full-mode
  }

  // Cancelled / past_due / paused → rood, actie vereist
  if (status === 'cancelled' || status === 'past_due' || status === 'paused') {
    const labels: Record<string, string> = {
      cancelled: 'Abonnement opgezegd',
      past_due:  'Betaling mislukt',
      paused:    'Op pauze',
    }
    if (variant === 'compact') {
      return <span className="badge badge-red text-xs">{labels[status]}</span>
    }
    return (
      <div className="card p-4 mb-5 border-red-200 bg-red-50">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="#dc2626" strokeWidth="1.5"/>
              <path d="M8 5v3.5M8 11v.5" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-red-900">{labels[status]}</div>
            <p className="text-xs text-red-700 mt-0.5">
              Project is read-only tot betaling rond is. Sync en uploads zijn geblokkeerd.
            </p>
          </div>
          <Link
            href={`/dashboard/billing?project=${project.id}`}
            className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors flex-shrink-0 font-medium"
          >
            Activeer
          </Link>
        </div>
      </div>
    )
  }

  // Trialing → tel resterende dagen af
  if (status === 'trialing' && trialEnd) {
    const now = new Date()
    const msLeft = trialEnd.getTime() - now.getTime()
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24))

    if (msLeft <= 0) {
      // Trial verlopen
      if (variant === 'compact') {
        return <span className="badge badge-red text-xs">Trial verlopen</span>
      }
      return (
        <div className="card p-4 mb-5 border-red-200 bg-red-50">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="5.5" stroke="#dc2626" strokeWidth="1.5"/>
                <path d="M8 5v3l2 1.5" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-red-900">Trial verlopen</div>
              <p className="text-xs text-red-700 mt-0.5">
                De gratis proefperiode van dit project is voorbij. Activeer een abonnement
                om de sync en alle data-functies opnieuw te gebruiken.
              </p>
            </div>
            <Link
              href={`/dashboard/billing?project=${project.id}`}
              className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors flex-shrink-0 font-medium"
            >
              Activeer abonnement
            </Link>
          </div>
        </div>
      )
    }

    // Trial loopt nog → kleur op basis van urgentie
    const urgent = daysLeft <= 3
    const warning = daysLeft <= 7

    if (variant === 'compact') {
      const dateLabel = trialEnd.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })
      return (
        <span
          className={`badge text-xs ${
            urgent ? 'badge-red' : warning ? 'badge-amber' : 'badge-blue'
          }`}
          title={`Trial verloopt op ${trialEnd.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' })}`}
        >
          Trial · {daysLeft}d {urgent ? `· tot ${dateLabel}` : ''}
        </span>
      )
    }

    return (
      <div className={`card p-4 mb-5 ${
        urgent  ? 'border-red-200 bg-red-50' :
        warning ? 'border-amber-200 bg-amber-50' :
                  'border-blue-200 bg-blue-50'
      }`}>
        <div className="flex items-start gap-3">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
            urgent  ? 'bg-red-100' :
            warning ? 'bg-amber-100' :
                      'bg-blue-100'
          }`}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke={urgent ? '#dc2626' : warning ? '#d97706' : '#2563eb'} strokeWidth="1.5"/>
              <path d="M8 5v3l2 1.5" stroke={urgent ? '#dc2626' : warning ? '#d97706' : '#2563eb'} strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-medium ${
              urgent  ? 'text-red-900' :
              warning ? 'text-amber-900' :
                        'text-blue-900'
            }`}>
              Gratis trial loopt nog {daysLeft} {daysLeft === 1 ? 'dag' : 'dagen'}
            </div>
            <p className={`text-xs mt-0.5 ${
              urgent  ? 'text-red-700' :
              warning ? 'text-amber-700' :
                        'text-blue-700'
            }`}>
              {urgent
                ? 'Activeer nu een abonnement om sync en data-import niet te onderbreken.'
                : warning
                  ? `Verloopt op ${trialEnd.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long' })}. Activeer tijdig een abonnement.`
                  : `Volle functionaliteit tot ${trialEnd.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' })}.`
              }
            </p>
          </div>
          <Link
            href={`/dashboard/billing?project=${project.id}`}
            className={`text-xs px-3 py-1.5 rounded-md transition-colors flex-shrink-0 font-medium ${
              urgent
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-white border border-brand-200 text-brand-700 hover:border-brand-400'
            }`}
          >
            Activeer abonnement
          </Link>
        </div>
      </div>
    )
  }

  return null
}
