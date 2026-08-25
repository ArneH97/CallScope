import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/routing'
import MarketingNav from '@/components/marketing/MarketingNav'
import MarketingFooter from '@/components/marketing/MarketingFooter'

export async function generateMetadata({ params: { locale } }: { params: { locale: string } }) {
  const t = await getTranslations({ locale, namespace: 'marketing.salesTeams' })
  return {
    title:       t('metaTitle'),
    description: t('metaDescription'),
  }
}

export default async function VoorSalesTeams() {
  const t = await getTranslations('marketing.salesTeams')

  const pains = t.raw('pains.items')   as { emoji: string; title: string; body: string }[]
  const stats = t.raw('results.stats') as { stat: string; label: string }[]
  const paths = t.raw('paths.items')   as { title: string; body: string }[]

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <MarketingNav />

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-20 pb-12 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand-50 text-brand-700 rounded-full text-xs font-medium mb-6">
          {t('hero.badge')}
        </div>
        <h1 className="text-4xl md:text-5xl font-semibold text-gray-900 tracking-tight leading-tight mb-5 max-w-3xl mx-auto">
          {t('hero.title1')} <br className="hidden md:inline"/>
          <span className="text-brand-600">{t('hero.title2')}</span>
        </h1>
        <p className="text-lg text-gray-500 max-w-2xl mx-auto mb-8 leading-relaxed">
          {t('hero.subtitle')}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/auth/register" className="bg-brand-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm">
            {t('hero.ctaPrimary')}
          </Link>
          <Link href="/hoe-het-werkt" className="text-gray-600 hover:text-gray-900 px-6 py-3 rounded-lg font-medium transition-colors text-sm">
            {t('hero.ctaSecondary')}
          </Link>
        </div>
      </section>

      {/* Hero screenshot */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="rounded-xl border border-gray-200 shadow-2xl shadow-brand-100/40 overflow-hidden bg-white">
          <Image
            src="/screenshots/Dashboard_Sales_manageer.png"
            alt={t('hero.screenshotAlt')}
            width={1600} height={900}
            className="w-full h-auto"
            priority
          />
        </div>
      </section>

      {/* Frustraties */}
      <section className="bg-gray-50 border-y border-gray-100 py-20">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('pains.eyebrow')}
            </div>
            <h2 className="text-3xl font-semibold text-gray-900 tracking-tight">
              {t('pains.title')}
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {pains.map(p => (
              <div key={p.title} className="bg-white border border-gray-100 rounded-xl p-6">
                <div className="text-3xl mb-3">{p.emoji}</div>
                <h3 className="font-semibold text-gray-900 mb-2">{p.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Oplossingen */}
      <section className="py-20">
        <div className="max-w-6xl mx-auto px-6">
          {/* Appointments */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center mb-20">
            <div>
              <div className="inline-block text-xs font-semibold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-full mb-3">
                {t('appointments.label')}
              </div>
              <h2 className="text-3xl font-semibold text-gray-900 mb-3 tracking-tight">{t('appointments.title')}</h2>
              <p className="text-gray-500 leading-relaxed mb-4">{t('appointments.desc')}</p>
              <ul className="space-y-2 text-sm text-gray-600">
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('appointments.bullet1')}</li>
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('appointments.bullet2')}</li>
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('appointments.bullet3')}</li>
              </ul>
            </div>
            <div className="rounded-xl border border-gray-200 shadow-lg overflow-hidden">
              <Image src="/screenshots/Afspraken_Sales_manager.png" alt={t('appointments.alt')} width={1200} height={750} className="w-full h-auto"/>
            </div>
          </div>

          {/* HubSpot */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center mb-20">
            <div className="lg:order-2">
              <div className="inline-block text-xs font-semibold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-full mb-3">
                {t('hubspot.label')}
              </div>
              <h2 className="text-3xl font-semibold text-gray-900 mb-3 tracking-tight">{t('hubspot.title')}</h2>
              <p className="text-gray-500 leading-relaxed mb-4">{t('hubspot.desc')}</p>
              <ul className="space-y-2 text-sm text-gray-600">
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('hubspot.bullet1')}</li>
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('hubspot.bullet2')}</li>
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('hubspot.bullet3')}</li>
              </ul>
            </div>
            <div className="lg:order-1 rounded-xl border border-gray-200 shadow-lg overflow-hidden">
              <Image src="/screenshots/Integraties_Sales_manager.png" alt={t('hubspot.alt')} width={1200} height={750} className="w-full h-auto"/>
            </div>
          </div>

          {/* Manager */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
            <div>
              <div className="inline-block text-xs font-semibold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-full mb-3">
                {t('manager.label')}
              </div>
              <h2 className="text-3xl font-semibold text-gray-900 mb-3 tracking-tight">{t('manager.title')}</h2>
              <p className="text-gray-500 leading-relaxed mb-4">{t('manager.desc')}</p>
              <ul className="space-y-2 text-sm text-gray-600">
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('manager.bullet1')}</li>
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('manager.bullet2')}</li>
                <li className="flex items-start gap-2"><span className="text-brand-600 flex-shrink-0">✓</span>{t('manager.bullet3')}</li>
              </ul>
            </div>
            <div className="rounded-xl border border-gray-200 shadow-lg overflow-hidden">
              <Image src="/screenshots/Dashboard_Sales_manageer.png" alt={t('manager.alt')} width={1200} height={750} className="w-full h-auto"/>
            </div>
          </div>
        </div>
      </section>

      {/* Resultaat */}
      <section className="bg-gray-50 border-y border-gray-100 py-20">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
            {t('results.eyebrow')}
          </div>
          <h2 className="text-3xl font-semibold text-gray-900 mb-10 tracking-tight">
            {t('results.title')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {stats.map(s => (
              <div key={s.label} className="bg-white border border-gray-100 rounded-xl p-6">
                <div className="text-4xl font-semibold text-brand-600 mb-2">{s.stat}</div>
                <div className="text-sm text-gray-500 leading-relaxed">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Hoe te krijgen */}
      <section className="py-20">
        <div className="max-w-3xl mx-auto px-6">
          <div className="text-center mb-10">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('paths.eyebrow')}
            </div>
            <h2 className="text-3xl font-semibold text-gray-900 tracking-tight">
              {t('paths.title')}
            </h2>
          </div>
          <div className="space-y-4">
            {paths.map(p => (
              <div key={p.title} className="border border-gray-200 rounded-xl p-6 bg-white">
                <h3 className="font-semibold text-gray-900 mb-2">{p.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 flex-1 bg-gray-50/50">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-semibold text-gray-900 mb-4 tracking-tight">
            {t('finalCta.title')}
          </h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            {t('finalCta.desc')}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/auth/register" className="bg-brand-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm">
              {t('finalCta.ctaPrimary')}
            </Link>
            <Link href="/pricing" className="border border-gray-200 bg-white text-gray-700 px-6 py-3 rounded-lg font-medium hover:border-gray-300 transition-colors text-sm">
              {t('finalCta.ctaSecondary')}
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
