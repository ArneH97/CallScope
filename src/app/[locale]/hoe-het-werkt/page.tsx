import Image from 'next/image'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/routing'
import MarketingNav from '@/components/marketing/MarketingNav'
import MarketingFooter from '@/components/marketing/MarketingFooter'

export async function generateMetadata({ params: { locale } }: { params: { locale: string } }) {
  const t = await getTranslations({ locale, namespace: 'marketing.howItWorks' })
  return {
    title:       t('metaTitle'),
    description: t('metaDescription'),
  }
}

type Step = {
  n:           string
  who:         string
  title:       string
  body:        string
  bullets?:    string[]
  screenshot?: string
  alt?:        string
}

export default async function HoeHetWerkt() {
  const t = await getTranslations('marketing.howItWorks')
  const STEPS = t.raw('steps') as Step[]

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <MarketingNav />

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-brand-50 text-brand-700 rounded-full text-xs font-medium mb-6">
          {t('hero.badge')}
        </div>
        <h1 className="text-4xl md:text-5xl font-semibold text-gray-900 tracking-tight leading-tight mb-5">
          {t('hero.title')}<span className="text-brand-600">{t('hero.title2')}</span>
        </h1>
        <p className="text-lg text-gray-500 leading-relaxed">
          {t('hero.subtitle')}
        </p>
      </section>

      {/* Stappen */}
      <section className="py-12">
        <div className="max-w-4xl mx-auto px-6 space-y-16">
          {STEPS.map((step, idx) => (
            <div key={step.n} className="relative">
              {/* Verbindingslijn behalve bij laatste */}
              {idx < STEPS.length - 1 && (
                <div className="absolute left-7 top-16 bottom-[-4rem] w-px bg-gray-100 hidden md:block"/>
              )}
              <div className="grid grid-cols-1 md:grid-cols-[auto,1fr] gap-6 items-start">
                {/* Nummer */}
                <div className="relative z-10 w-14 h-14 bg-brand-600 text-white rounded-2xl flex items-center justify-center font-semibold text-xl shadow-md shadow-brand-200">
                  {step.n}
                </div>

                <div>
                  <div className="text-xs font-semibold text-brand-700 bg-brand-50 inline-block px-2.5 py-1 rounded-full mb-3">
                    {step.who}
                  </div>
                  <h2 className="text-2xl font-semibold text-gray-900 mb-2 tracking-tight">
                    {step.title}
                  </h2>
                  <p className="text-gray-500 leading-relaxed mb-4">
                    {step.body}
                  </p>
                  {step.bullets && step.bullets.length > 0 && (
                    <ul className="space-y-1.5 text-sm text-gray-600 mb-4">
                      {step.bullets.map(b => (
                        <li key={b} className="flex items-start gap-2">
                          <span className="text-brand-600 flex-shrink-0">✓</span>
                          {b}
                        </li>
                      ))}
                    </ul>
                  )}
                  {step.screenshot && (
                    <div className="rounded-xl border border-gray-200 shadow-sm overflow-hidden mt-4">
                      <Image
                        src={step.screenshot}
                        alt={step.alt ?? step.title}
                        width={1200} height={750}
                        className="w-full h-auto"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 flex-1 bg-gray-50/50 mt-16">
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
