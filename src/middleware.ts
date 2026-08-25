import createIntlMiddleware from 'next-intl/middleware'
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { routing } from './i18n/routing'
import { locales } from './i18n/config'

/**
 * Combined middleware: locale-detection (next-intl) + auth (Supabase).
 *
 * Volgorde:
 *   1. next-intl middleware: detecteer locale, rewrite URL als nodig
 *   2. Supabase auth-check: redirect naar login/dashboard waar relevant
 *
 * We strippen de locale-prefix van het pad voor de auth-check zodat zowel
 * /dashboard (NL) als /en/dashboard (EN) dezelfde regel volgen.
 */

const intlMiddleware = createIntlMiddleware(routing)

/**
 * Verwijder de locale-prefix uit een URL-pad.
 * `/en/dashboard` → `/dashboard`
 * `/dashboard`    → `/dashboard`
 */
function stripLocale(pathname: string): string {
  for (const locale of locales) {
    if (pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)) {
      return pathname.replace(`/${locale}`, '') || '/'
    }
  }
  return pathname
}

/**
 * Geef het juiste pad terug voor een redirect, met de actieve locale-prefix
 * indien die er was. Zo blijven we binnen dezelfde taal bij login-redirects.
 */
function withLocale(pathname: string, originalPath: string): string {
  for (const locale of locales) {
    if (originalPath.startsWith(`/${locale}/`) || originalPath === `/${locale}`) {
      // Default locale (nl) krijgt geen prefix wegens 'as-needed'
      if (locale === routing.defaultLocale) return pathname
      return `/${locale}${pathname}`
    }
  }
  return pathname
}

export async function middleware(request: NextRequest) {
  // Stap 1: laat next-intl de locale-detection + rewrites doen
  const intlResponse = intlMiddleware(request)

  // Stap 2: Supabase auth — uitsluitend voor /dashboard en /auth paden
  const stripped = stripLocale(request.nextUrl.pathname)
  const isDashboard = stripped.startsWith('/dashboard')
  const isAuth      = stripped.startsWith('/auth')

  if (!isDashboard && !isAuth) {
    return intlResponse
  }

  let supabaseResponse = intlResponse

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = intlResponse
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Niet ingelogd en probeert dashboard te bereiken → naar login (in dezelfde taal)
  if (!user && isDashboard) {
    const target = withLocale('/auth/login', request.nextUrl.pathname)
    return NextResponse.redirect(new URL(target, request.url))
  }

  // Al ingelogd en gaat naar auth pagina → naar dashboard (in dezelfde taal)
  if (user && isAuth) {
    const target = withLocale('/dashboard', request.nextUrl.pathname)
    return NextResponse.redirect(new URL(target, request.url))
  }

  return supabaseResponse
}

export const config = {
  // Match alles BEHALVE:
  //   - API routes (locale-agnostic, geen auth-redirect nodig)
  //   - Next.js internals (_next, _vercel)
  //   - Static assets met een file-extensie (favicon, .css, .png, ...)
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
}
