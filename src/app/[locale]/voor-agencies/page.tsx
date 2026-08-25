import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/routing'
import MarketingNav from '@/components/marketing/MarketingNav'
import MarketingFooter from '@/components/marketing/MarketingFooter'

export async function generateMetadata({ params: { locale } }: { params: { locale: string } }) {
  const t = await getTranslations({ locale, namespace: 'marketing.agencies' })
  return {
    title:       t('metaTitle'),
    description: t('metaDescription'),
  }
}

export default async function VoorAgencies() {
  const t = await getTranslations('marketing.agencies')

  const pains    = t.raw('pains.items')      as { emoji: string; title: string; body: string }[]
  const solution = t.raw('solution.items')   as { title: string; desc: string }[]
  const stats    = t.raw('results.stats')    as { stat: string; label: string }[]

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
          <Link href="/pricing" className="text-gray-600 hover:text-gray-900 px-6 py-3 rounded-lg font-medium transition-colors text-sm">
            {t('hero.ctaSecondary')}
          </Link>
        </div>
      </section>

      {/* Pijnpunten */}
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {pains.map((p, i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-xl p-6">
                <div className="text-2xl mb-3">{p.emoji}</div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{p.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Oplossing */}
      <section className="py-20">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('solution.eyebrow')}
            </div>
            <h2 className="text-3xl font-semibold text-gray-900 tracking-tight">
              {t('solution.title')}
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {solution.map((s, i) => (
              <div key={i} className="border border-gray-200 rounded-xl p-6 bg-white">
                <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-600 font-semibold flex items-center justify-center mb-3 text-sm">
                  {i + 1}
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{s.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Resultaten */}
      <section className="bg-gray-50 border-y border-gray-100 py-20">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('results.eyebrow')}
            </div>
            <h2 className="text-3xl font-semibold text-gray-900 tracking-tight">
              {t('results.title')}
            </h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {stats.map((s, i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-xl p-5 text-center">
                <div className="text-2xl font-semibold text-brand-600 mb-1">{s.stat}</div>
                <div className="text-xs text-gray-500 leading-snug">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="py-20">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
            {t('pricing.eyebrow')}
          </div>
          <h2 className="text-3xl font-semibold text-gray-900 mb-3 tracking-tight">
            {t('pricing.title')}
          </h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            {t('pricing.desc')}
          </p>
          <Link href="/pricing" className="bg-brand-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm inline-block">
            {t('pricing.cta')}
          </Link>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-gray-50 border-t border-gray-100 py-24 flex-1">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-semibold text-gray-900 mb-4 tracking-tight">
            {t('cta.title')}
          </h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            {t('cta.subtitle')}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/auth/register" className="bg-brand-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm">
              {t('cta.ctaPrimary')}
            </Link>
            <Link href="/pricing" className="border border-gray-200 bg-white text-gray-700 px-6 py-3 rounded-lg font-medium hover:border-gray-300 transition-colors text-sm">
              {t('cta.ctaSecondary')}
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
