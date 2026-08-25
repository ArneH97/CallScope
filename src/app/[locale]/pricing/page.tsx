import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/routing'
import MarketingNav from '@/components/marketing/MarketingNav'
import MarketingFooter from '@/components/marketing/MarketingFooter'

export async function generateMetadata({ params: { locale } }: { params: { locale: string } }) {
  const t = await getTranslations({ locale, namespace: 'marketing.pricing' })
  return {
    title:       t('metaTitle'),
    description: t('metaDescription'),
  }
}

export default async function Pricing() {
  const t = await getTranslations('marketing.pricing')

  // Plan-features en FAQ-items zitten als arrays in de JSON. We lezen ze met
  // t.raw zodat de structuur (objects voor FAQ) bewaard blijft.
  const features = t.raw('plan.features') as string[]
  const faqItems = t.raw('faq.items')     as { q: string; a: string }[]

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <MarketingNav />

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand-50 text-brand-700 rounded-full text-xs font-medium mb-6">
          {t('hero.badge')}
        </div>
        <h1 className="text-4xl md:text-5xl font-semibold text-gray-900 tracking-tight leading-tight mb-5">
          {t('hero.title1')} <br className="hidden md:inline"/>
          <span className="text-brand-600">{t('hero.title2')}</span>
        </h1>
        <p className="text-lg text-gray-500 leading-relaxed max-w-2xl mx-auto">
          {t('hero.subtitle')}
        </p>
      </section>

      {/* Plan card */}
      <section className="px-6 pb-20">
        <div className="max-w-md mx-auto rounded-2xl border-2 border-brand-200 shadow-xl shadow-brand-100/50 bg-white overflow-hidden">
          <div className="bg-brand-50 px-8 py-3 text-center">
            <span className="text-xs font-semibold text-brand-700 uppercase tracking-wide">
              {t('plan.header')}
            </span>
          </div>
          <div className="p-8">
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-5xl font-semibold text-gray-900">€49</span>
              <span className="text-gray-500 ml-1">{t('plan.perMonth')}</span>
            </div>
            <p className="text-sm text-gray-500 mb-6">
              {t('plan.taxNote')}
            </p>

            <Link
              href="/auth/register"
              className="block w-full bg-brand-600 text-white text-center py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm mb-6"
            >
              {t('plan.cta')}
            </Link>

            <div className="space-y-2.5 text-sm">
              {features.map(f => (
                <div key={f} className="flex items-start gap-2 text-gray-700">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-brand-600 flex-shrink-0 mt-0.5">
                    <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {f}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="max-w-xl mx-auto mt-6 text-center">
          <p className="text-xs text-gray-500">
            {t('couponNote')}
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="bg-gray-50 border-y border-gray-100 py-20">
        <div className="max-w-3xl mx-auto px-6">
          <div className="text-center mb-12">
            <div className="text-xs font-medium text-brand-600 uppercase tracking-wide mb-2">
              {t('faq.eyebrow')}
            </div>
            <h2 className="text-3xl font-semibold text-gray-900 tracking-tight">
              {t('faq.title')}
            </h2>
          </div>

          <div className="space-y-3">
            {faqItems.map(item => (
              <details
                key={item.q}
                className="group bg-white border border-gray-100 rounded-xl px-5 py-4 cursor-pointer"
              >
                <summary className="font-medium text-gray-900 list-none flex justify-between items-start gap-4">
                  <span>{item.q}</span>
                  <span className="text-gray-400 group-open:rotate-180 transition-transform flex-shrink-0 mt-0.5">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                </summary>
                <p className="text-sm text-gray-500 leading-relaxed mt-3 pr-6">
                  {item.a}
                </p>
              </details>
            ))}
          </div>

          <div className="text-center mt-10 text-sm text-gray-500">
            {t('faq.contactPre')}{' '}
            <a href="mailto:arne@halcoservices.be" className="text-brand-600 hover:underline">
              {t('faq.contactLink')}
            </a>
            .
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 flex-1">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-4xl font-semibold text-gray-900 mb-4 tracking-tight">
            {t('finalCta.title')}
          </h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            {t('finalCta.desc')}
          </p>
          <Link
            href="/auth/register"
            className="bg-brand-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-brand-700 transition-colors text-sm inline-block"
          >
            {t('finalCta.button')}
          </Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
