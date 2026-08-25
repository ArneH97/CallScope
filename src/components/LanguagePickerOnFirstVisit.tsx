'use client'

import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { useRouter, usePathname } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'
import { locales, type Locale } from '@/i18n/config'

/**
 * First-visit language picker. Toont eenmaal een modal aan ANONIEME bezoekers
 * van de marketing-site om hun voorkeurstaal te kiezen.
 *
 * Wanneer NIET tonen:
 *   - User is ingelogd (profile.locale + onboarding-modal regelen dit)
 *   - User heeft al gekozen (cookie `lang_chosen` is gezet)
 *   - User zit op /dashboard of /auth (eigen flow + redirect)
 *
 * Bij keuze: cookie wordt 1 jaar gezet en de pagina wordt naar de gekozen
 * locale geswitcht (router.replace met `locale`-optie). De LanguageSwitcher
 * in de nav blijft daarna gewoon werken voor latere wijzigingen.
 *
 * Browser Accept-Language wordt gebruikt om een suggestie te markeren maar
 * leidt nooit tot automatische redirect — keuze is altijd expliciet.
 */

const COOKIE_NAME = 'lang_chosen'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 jaar

export default function LanguagePickerOnFirstVisit() {
  const [show, setShow] = useState(false)
  const [suggested, setSuggested] = useState<Locale>('nl')
  const router = useRouter()
  const pathname = usePathname()
  const currentLocale = useLocale() as Locale

  useEffect(() => {
    // Nooit tonen op dashboard- of auth-paths — die hebben eigen flow.
    // Dit is een marketing-only feature.
    if (pathname.startsWith('/dashboard') || pathname.startsWith('/auth')) return

    // Cookie al gezet? → user heeft eerder gekozen, niet nogmaals tonen.
    if (typeof document !== 'undefined' && document.cookie.includes(`${COOKIE_NAME}=`)) return

    // Check auth-status: ingelogde users handelen we via profile.locale af,
    // niet via deze modal. Markeer dan ook meteen de cookie zodat ze 'm
    // niet alsnog krijgen wanneer ze later uitloggen.
    const sb = createClient()
    sb.auth.getUser().then(({ data }) => {
      if (data.user) {
        document.cookie = `${COOKIE_NAME}=auto; max-age=${COOKIE_MAX_AGE}; path=/; samesite=lax`
        return
      }

      // Suggereer een taal op basis van browser Accept-Language.
      // Niet bindend — gebruiker maakt zelf de keuze.
      const browserLang = (navigator.language || 'nl').toLowerCase()
      const detected: Locale = browserLang.startsWith('nl')
        ? 'nl'
        : browserLang.startsWith('en')
          ? 'en'
          : 'nl' // default fallback
      setSuggested(detected)
      setShow(true)
    })
  }, [pathname])

  function pick(locale: Locale) {
    if (typeof document !== 'undefined') {
      document.cookie = `${COOKIE_NAME}=${locale}; max-age=${COOKIE_MAX_AGE}; path=/; samesite=lax`
    }
    setShow(false)

    // Wissel taal als gekozen ≠ huidige; anders gewoon modal sluiten.
    if (locale !== currentLocale) {
      router.replace(pathname, { locale })
    }
  }

  if (!show) return null
  if (!locales.includes('nl') || !locales.includes('en')) return null

  return (
    <div
      className="fixed inset-0 z-[60] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-5">
          <div className="w-9 h-9 bg-brand-600 rounded-lg flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="white" strokeWidth="1.5"/>
              <path d="M8 3v2M8 11v2M3 8h2M11 8h2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="8" cy="8" r="1.4" fill="white"/>
            </svg>
          </div>
          <span className="text-lg font-semibold tracking-tight">CallScope</span>
        </div>

        {/* Bilingual heading — staat sowieso voor de gebruiker zodat het
            zelfverklarend is, ongeacht welke taal hij spreekt. */}
        <h2 className="text-center text-base font-semibold text-gray-900 mb-1">
          Welkom · Welcome
        </h2>
        <p className="text-center text-sm text-gray-500 mb-5 leading-relaxed">
          Kies je taal · Choose your language
        </p>

        <div className="space-y-2">
          <LangButton
            label="Nederlands"
            sublabel="België · Nederland"
            flag="🇧🇪"
            highlight={suggested === 'nl'}
            onClick={() => pick('nl')}
          />
          <LangButton
            label="English"
            sublabel="International"
            flag="🇬🇧"
            highlight={suggested === 'en'}
            onClick={() => pick('en')}
          />
        </div>

        <p className="text-[11px] text-gray-400 text-center mt-4 leading-relaxed">
          Je kan dit later altijd wijzigen via de taal-knop bovenaan.
          <br/>
          You can change this later from the language switch on top.
        </p>
      </div>
    </div>
  )
}

function LangButton({
  label, sublabel, flag, highlight, onClick,
}: {
  label:     string
  sublabel:  string
  flag:      string
  highlight: boolean
  onClick:   () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors text-left ${
        highlight
          ? 'border-brand-300 bg-brand-50 hover:bg-brand-100'
          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
      }`}
    >
      <span className="text-2xl flex-shrink-0">{flag}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900">{label}</div>
        <div className="text-xs text-gray-500">{sublabel}</div>
      </div>
      {highlight && (
        <span className="text-[10px] uppercase tracking-wide text-brand-700 bg-white px-2 py-0.5 rounded-full font-medium">
          ✓
        </span>
      )}
    </button>
  )
}
