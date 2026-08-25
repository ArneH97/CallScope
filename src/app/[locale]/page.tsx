import { redirect } from 'next/navigation'
import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { createClient } from '@/lib/supabase/server'
import { Link } from '@/i18n/routing'
import MarketingNav from '@/components/marketing/MarketingNav'
import MarketingFooter from '@/components/marketing/MarketingFooter'

/**
 * Publieke landingspagina op callscope.be (NL) / callscope.be/en (EN).
 * Authenticated users worden door-gerouteerd naar hun dashboard.
 *
 * Alle copy zit in messages/{nl,en}.json onder `marketing.home.*`. Vertalen =
 * keys aanpassen, niet deze file.
 */
export default async function HomePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect('/dashboard')

  const t = await getTranslations('marketing.home')

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <MarketingNav />

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand-50 text-brand-700 rounded-full text-xs font-medium mb-6">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="3" fill="#2d4fff"/>
          </svg>
          {t('hero.badge')}
        </div>

        <h1 className="text-4xl md:text-5xl font-semibold text-gray-900 tracking-tight leading-tight mb-5 max-w-3xl mx-auto">
          {t('hero.title1')} <br className="hidden md:inline"/>
          <span className="text-brand-600">{t('hero.title2')}</span>
        </h1>
        <p className="text-lg text-gray-500 max-w-2xl mx-auto mb-8 leading-relaxed">
          {t('hero.subtitle')}
        </p>

        <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
          <Link
            href="/auth/register"
            className="bg-brand-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm"
          >
            {t('hero.ctaPrimary')}
          </Link>
          <Link
            href="/hoe-het-werkt"
            className="text-gray-600 hover:text-gray-900 px-6 py-3 rounded-lg font-medium transition-colors text-sm"
          >
            {t('hero.ctaSecondary')}
          </Link>
        </div>

        <p className="text-xs text-gray-400">
          {t('hero.smallPrint')}
        </p>
      </section>

      {/* ── Hero screenshot ──────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="rounded-xl border border-gray-200 shadow-2xl shadow-brand-100/40 overflow-hidden bg-white">
          <Image
            src="/screenshots/Dashboard_CC_Manager.png"
            alt={t('hero.screenshotAlt')}
            width={1600}
            height={900}
            className="w-full h-auto"
            priority
          />
        </div>
      </section>

      {/* ── Voor wie ─────────────────────────────────────────────── */}
      <section className="bg-gray-50 border-y border-gray-100 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('audience.eyebrow')}
            </div>
            <h2 className="text-3xl font-semibold text-gray-900 tracking-tight">
              {t('audience.title')}
            </h2>
            <p className="text-gray-500 mt-3 max-w-xl mx-auto leading-relaxed">
              {t('audience.subtitle')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <Link
              href="/voor-agencies"
              className="group border border-gray-200 rounded-xl p-7 bg-white hover:border-brand-300 hover:shadow-lg transition-all"
            >
              <div className="w-12 h-12 rounded-lg bg-brand-50 flex items-center justify-center text-brand-600 mb-4 group-hover:bg-brand-100 transition-colors">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7h18M3 12h18M3 17h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <circle cx="7" cy="7" r="1.5" fill="currentColor"/>
                  <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                  <circle cx="17" cy="17" r="1.5" fill="currentColor"/>
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">{t('audience.agencies.title')}</h3>
              <p className="text-sm text-gray-500 leading-relaxed mb-4">
                {t('audience.agencies.desc')}
              </p>
              <span className="text-sm text-brand-600 font-medium group-hover:underline">
                {t('audience.agencies.cta')}
              </span>
            </Link>

            <Link
              href="/voor-callcentra"
              className="group border border-gray-200 rounded-xl p-7 bg-white hover:border-brand-300 hover:shadow-lg transition-all"
            >
              <div className="w-12 h-12 rounded-lg bg-brand-50 flex items-center justify-center text-brand-600 mb-4 group-hover:bg-brand-100 transition-colors">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">{t('audience.callCenters.title')}</h3>
              <p className="text-sm text-gray-500 leading-relaxed mb-4">
                {t('audience.callCenters.desc')}
              </p>
              <span className="text-sm text-brand-600 font-medium group-hover:underline">
                {t('audience.callCenters.cta')}
              </span>
            </Link>

            <Link
              href="/voor-sales-teams"
              className="group border border-gray-200 rounded-xl p-7 bg-white hover:border-brand-300 hover:shadow-lg transition-all"
            >
              <div className="w-12 h-12 rounded-lg bg-brand-50 flex items-center justify-center text-brand-600 mb-4 group-hover:bg-brand-100 transition-colors">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M3 3v18h18M9 17V9m4 8V5m4 12v-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">{t('audience.salesTeams.title')}</h3>
              <p className="text-sm text-gray-500 leading-relaxed mb-4">
                {t('audience.salesTeams.desc')}
              </p>
              <span className="text-sm text-brand-600 font-medium group-hover:underline">
                {t('audience.salesTeams.cta')}
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* ── HubSpot spotlight — killer feature, eigen sectie ─────── */}
      <section className="py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('hubspotSpotlight.eyebrow')}
            </div>
            <h2 className="text-3xl md:text-4xl font-semibold text-gray-900 tracking-tight max-w-3xl mx-auto">
              {t('hubspotSpotlight.title')}
            </h2>
            <p className="text-gray-500 mt-4 max-w-2xl mx-auto leading-relaxed">
              {t('hubspotSpotlight.desc')}
            </p>
            <div className="inline-flex items-center gap-2 mt-5 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-xs font-medium text-green-800">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {t('hubspotSpotlight.readOnlyBadge')}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="relative border border-gray-200 rounded-xl p-5 bg-white">
                <div className="absolute -top-3 left-5 w-7 h-7 rounded-full bg-brand-600 text-white text-xs font-semibold flex items-center justify-center">
                  {i}
                </div>
                <div className="pt-2">
                  <h3 className="text-sm font-semibold text-gray-900 mb-2">
                    {t(`hubspotSpotlight.flowStep${i}Title`).replace(/^\d+\.\s*/, '')}
                  </h3>
                  <p className="text-xs text-gray-500 leading-relaxed">
                    {t(`hubspotSpotlight.flowStep${i}Desc`)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="text-center">
            <Link
              href="/hoe-het-werkt"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              {t('hubspotSpotlight.cta')}
            </Link>
          </div>
        </div>
      </section>

      {/* ── Hoofdfeatures ────────────────────────────────────────── */}
      <section className="py-20 border-t border-gray-100">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('features.eyebrow')}
            </div>
            <h2 className="text-3xl font-semibold text-gray-900 tracking-tight">
              {t('features.title')}
            </h2>
          </div>

          {/* Feature 1: Sync */}
          <FeatureBlock
            label={t('features.sync.label')}
            title={t('features.sync.title')}
            desc={t('features.sync.desc')}
            bullets={[t('features.sync.bullet1'), t('features.sync.bullet2'), t('features.sync.bullet3')]}
            screenshot="/screenshots/Manuele_Upload_CC_Manager.png"
            alt={t('features.sync.alt')}
            reverse={false}
          />

          {/* Feature 2: AI analyse */}
          <FeatureBlock
            label={t('features.ai.label')}
            title={t('features.ai.title')}
            desc={t('features.ai.desc')}
            bullets={[t('features.ai.bullet1'), t('features.ai.bullet2'), t('features.ai.bullet3')]}
            screenshot="/screenshots/Dashboard_Sales_manageer.png"
            alt={t('features.ai.alt')}
            reverse
          />

          {/* Feature 3: HubSpot loop */}
          <FeatureBlock
            label={t('features.hubspot.label')}
            title={t('features.hubspot.title')}
            desc={t('features.hubspot.desc')}
            bullets={[t('features.hubspot.bullet1'), t('features.hubspot.bullet2'), t('features.hubspot.bullet3')]}
            screenshot="/screenshots/Integraties_Sales_manager.png"
            alt={t('features.hubspot.alt')}
            reverse={false}
            isLast
          />
        </div>
      </section>

      {/* ── Case study / proof — eerste eigen resultaten ─────────── */}
      <section className="py-20 border-t border-gray-100">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('caseStudy.eyebrow')}
            </div>
            <h2 className="text-3xl font-semibold text-gray-900 tracking-tight max-w-2xl mx-auto">
              {t('caseStudy.title')}
            </h2>
            <p className="text-gray-500 mt-4 max-w-xl mx-auto leading-relaxed">
              {t('caseStudy.desc')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
            {[1, 2, 3].map(i => (
              <div key={i} className="border border-gray-200 rounded-xl p-6 bg-white text-center">
                <div className="text-3xl font-semibold text-brand-600 mb-1">
                  {t(`caseStudy.metric${i}Value`)}
                </div>
                <div className="text-sm text-gray-600 leading-relaxed">
                  {t(`caseStudy.metric${i}Label`)}
                </div>
              </div>
            ))}
          </div>

          <figure className="max-w-3xl mx-auto bg-gray-50 border-l-4 border-brand-500 rounded-r-xl p-6">
            <blockquote className="text-lg text-gray-800 leading-relaxed italic">
              &ldquo;{t('caseStudy.quote')}&rdquo;
            </blockquote>
            <figcaption className="text-sm text-gray-500 mt-3">
              — {t('caseStudy.quoteAuthor')}
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ── Pricing teaser ───────────────────────────────────────── */}
      <section className="bg-gray-50 border-y border-gray-100 py-20">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
            {t('pricingTeaser.eyebrow')}
          </div>
          <h2 className="text-3xl font-semibold text-gray-900 mb-3 tracking-tight">
            {t('pricingTeaser.title')}
          </h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            {t('pricingTeaser.desc')}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/pricing"
              className="bg-brand-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm"
            >
              {t('pricingTeaser.ctaPrimary')}
            </Link>
            <Link
              href="/auth/register"
              className="border border-gray-200 bg-white text-gray-700 px-6 py-3 rounded-lg font-medium hover:border-gray-300 transition-colors text-sm"
            >
              {t('pricingTeaser.ctaSecondary')}
            </Link>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────── */}
      <section className="py-24 flex-1">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-semibold text-gray-900 mb-4 tracking-tight">
            {t('finalCta.title')}
          </h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            {t('finalCta.desc')}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/auth/register"
              className="bg-brand-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm"
            >
              {t('finalCta.ctaPrimary')}
            </Link>
            <Link
              href="/hoe-het-werkt"
              className="border border-gray-200 text-gray-700 px-6 py-3 rounded-lg font-medium hover:border-gray-300 transition-colors text-sm"
            >
              {t('finalCta.ctaSecondary')}
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}

/**
 * Hergebruikbaar feature-blok om de drie sync/AI/HubSpot secties consistent
 * te renderen. `reverse` plaatst de screenshot links i.p.v. rechts.
 */
function FeatureBlock({
  label, title, desc, bullets, screenshot, alt, reverse, isLast,
}: {
  label:      string
  title:      string
  desc:       string
  bullets:    string[]
  screenshot: string
  alt:        string
  reverse:    boolean
  isLast?:    boolean
}) {
  return (
    <div className={`grid grid-cols-1 lg:grid-cols-2 gap-10 items-center ${isLast ? '' : 'mb-20'}`}>
      <div className={reverse ? 'lg:order-2' : ''}>
        <div className="inline-block text-xs font-semibold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-full mb-3">
          {label}
        </div>
        <h3 className="text-2xl font-semibold text-gray-900 mb-3">{title}</h3>
        <p className="text-gray-500 leading-relaxed mb-4">{desc}</p>
        <ul className="space-y-2 text-sm">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-gray-600">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-brand-600 flex-shrink-0 mt-0.5">
                <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {b}
            </li>
          ))}
        </ul>
      </div>
      <div className={`${reverse ? 'lg:order-1' : ''} rounded-xl border border-gray-200 shadow-lg overflow-hidden`}>
        <Image src={screenshot} alt={alt} width={1200} height={750} className="w-full h-auto"/>
      </div>
    </div>
  )
}
