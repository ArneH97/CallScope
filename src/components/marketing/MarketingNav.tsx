'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/routing'
import LanguageSwitcher from '@/components/LanguageSwitcher'

/**
 * Top-navigatie voor alle publieke marketing-pagina's.
 * Mobile: hamburger met slide-down menu.
 * Active link wordt gemarkeerd met brand-kleur.
 *
 * Locale-aware via @/i18n/routing — een EN-bezoeker op /en/voor-callcentra
 * blijft op de EN-versie wanneer hij naar /pricing klikt.
 */

const NAV_LINKS = [
  { href: '/voor-agencies',    labelKey: 'forAgencies'    as const },
  { href: '/voor-callcentra',  labelKey: 'forCallCenters' as const },
  { href: '/voor-sales-teams', labelKey: 'forSalesTeams'  as const },
  { href: '/hoe-het-werkt',    labelKey: 'howItWorks'     as const },
  { href: '/pricing',          labelKey: 'pricing'        as const },
]

export default function MarketingNav() {
  const t = useTranslations('marketing.nav')
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <header className="border-b border-gray-100 bg-white sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="white" strokeWidth="1.5"/>
              <path d="M8 3v2M8 11v2M3 8h2M11 8h2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="8" cy="8" r="1.4" fill="white"/>
            </svg>
          </div>
          <span className="text-lg font-semibold tracking-tight text-gray-900">CallScope</span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map(link => {
            const active = pathname === link.href
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm px-3 py-1.5 rounded-md transition-colors ${
                  active
                    ? 'text-brand-700 font-medium'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {t(link.labelKey)}
              </Link>
            )
          })}
        </nav>

        {/* Desktop CTA + language switcher */}
        <div className="hidden md:flex items-center gap-3">
          <LanguageSwitcher />
          <Link
            href="/auth/login"
            className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-md transition-colors"
          >
            {t('signIn')}
          </Link>
          <Link
            href="/auth/register"
            className="text-sm bg-brand-600 text-white px-4 py-2 rounded-md font-medium hover:bg-brand-700 transition-colors"
          >
            {t('startFree')}
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          onClick={() => setOpen(!open)}
          className="md:hidden text-gray-700 p-2 -mr-2"
          aria-label={t('menu')}
        >
          <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
            {open ? (
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            ) : (
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            )}
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden border-t border-gray-100 px-6 py-4 space-y-1 bg-white">
          {NAV_LINKS.map(link => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`block px-3 py-2 rounded-md text-sm transition-colors ${
                pathname === link.href
                  ? 'bg-brand-50 text-brand-700 font-medium'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {t(link.labelKey)}
            </Link>
          ))}
          <div className="pt-2 border-t border-gray-100 flex items-center gap-2">
            <LanguageSwitcher />
            <Link
              href="/auth/login"
              onClick={() => setOpen(false)}
              className="flex-1 text-center px-4 py-2 rounded-md text-sm border border-gray-200 text-gray-700"
            >
              {t('signIn')}
            </Link>
            <Link
              href="/auth/register"
              onClick={() => setOpen(false)}
              className="flex-1 text-center px-4 py-2 rounded-md text-sm bg-brand-600 text-white font-medium"
            >
              {t('startFree')}
            </Link>
          </div>
        </div>
      )}
    </header>
  )
}
