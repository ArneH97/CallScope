'use client'

import { useLocale } from 'next-intl'
import { useRouter, usePathname } from '@/i18n/routing'
import { locales, localeLabels, type Locale } from '@/i18n/config'

/**
 * Compact language-switcher voor in de sidebar of footer.
 *
 * Werkt locale-aware: switching naar 'en' op /dashboard navigeert naar
 * /en/dashboard. De huidige route blijft behouden, alleen de taal verandert.
 */
export default function LanguageSwitcher() {
  const locale = useLocale() as Locale
  const router = useRouter()
  const pathname = usePathname()

  function switchTo(newLocale: Locale) {
    if (newLocale === locale) return
    router.replace(pathname, { locale: newLocale })
  }

  return (
    <div className="flex gap-1 text-xs">
      {locales.map(l => (
        <button
          key={l}
          onClick={() => switchTo(l)}
          className={`px-2 py-1 rounded-md transition-colors ${
            l === locale
              ? 'bg-gray-100 text-gray-900 font-medium'
              : 'text-gray-400 hover:text-gray-700'
          }`}
          aria-label={`Switch to ${localeLabels[l]}`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
