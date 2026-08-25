import type { Metadata, Viewport } from 'next'
import { DM_Sans, DM_Mono } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { locales, type Locale } from '@/i18n/config'
import LanguagePickerOnFirstVisit from '@/components/LanguagePickerOnFirstVisit'
import '../globals.css'

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
})

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
})

export const metadata: Metadata = {
  title:       'CallScope',
  description: 'From call list to insight — automated reports for cold callers',
  // PWA manifest — laat de browser weten dat dit een installeerbare app is.
  manifest:    '/manifest.json',
  applicationName: 'CallScope',
  // iOS-specifieke tags: Safari negeert manifest.json grotendeels bij "Add to
  // Home Screen" en gebruikt in de plaats z'n eigen apple-* meta-tags.
  appleWebApp: {
    capable:        true,
    title:          'CallScope',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/callscope-logo-128.png', sizes: '128x128', type: 'image/png' },
      { url: '/callscope-logo-256.png', sizes: '256x256', type: 'image/png' },
      { url: '/callscope-logo-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      // iOS accepteert graag één "apple-touch-icon" van 180×180. We geven
      // 256px omdat we die al hebben — iOS schaalt zelf naar 180.
      { url: '/callscope-logo-256.png', sizes: '256x256', type: 'image/png' },
    ],
  },
}

/**
 * Viewport-config gescheiden van metadata (Next.js 14 convention). Bevat de
 * theme_color (voor Safari's URL-bar op mobile) en de standaard-viewport
 * zodat de site op iPhone-formaat niet ge-zoomed rendert.
 */
export const viewport: Viewport = {
  themeColor:      '#1a35e6',
  width:           'device-width',
  initialScale:    1,
  maximumScale:    5,   // sta pinch-to-zoom toe voor toegankelijkheid
  viewportFit:     'cover',
}

/**
 * Pre-genereert de locale-segmenten zodat de routes statisch kunnen renderen.
 * Vereist door next-intl voor optimale build-time performance.
 */
export function generateStaticParams() {
  return locales.map(locale => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params: { locale },
}: {
  children: React.ReactNode
  params:   { locale: string }
}) {
  // 404 als de URL een ongeldige locale heeft (bv. /xx/dashboard)
  if (!locales.includes(locale as Locale)) notFound()

  // Belangrijk voor static rendering — moet vóór alle async-calls
  setRequestLocale(locale)

  // Messages voor deze locale ophalen — bezorgd aan client-components via provider
  const messages = await getMessages()

  return (
    <html lang={locale} className={`${dmSans.variable} ${dmMono.variable}`}>
      <body className="bg-gray-50 text-gray-900 antialiased">
        <NextIntlClientProvider messages={messages}>
          {children}
          {/* Toont eenmalig een NL/EN-keuzemodal aan anonieme bezoekers van
              de marketing-site. Component beslist zelf wel of niet te tonen
              op basis van pathname + cookie + auth-status. */}
          <LanguagePickerOnFirstVisit />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
