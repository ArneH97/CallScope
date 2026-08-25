import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'

/**
 * Gedeelde footer voor alle publieke marketing-pagina's.
 * Drie kolommen: navigatie, account, juridisch + branding-rij onderaan.
 *
 * Locale-aware: alle interne links blijven in dezelfde taal als de pagina
 * waar de footer op gerendered wordt.
 */
export default function MarketingFooter() {
  const t = useTranslations('marketing.footer')
  const tNav = useTranslations('marketing.nav')

  return (
    <footer className="border-t border-gray-100 bg-gray-50/50">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-8 mb-10">
          {/* Brand kolom */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 bg-brand-600 rounded-md flex items-center justify-center">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="5.5" stroke="white" strokeWidth="1.5"/>
                  <path d="M8 3v2M8 11v2M3 8h2M11 8h2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                  <circle cx="8" cy="8" r="1.4" fill="white"/>
                </svg>
              </div>
              <span className="font-semibold text-gray-900">CallScope</span>
            </div>
            <p className="text-sm text-gray-500 leading-relaxed">
              {t('tagline')}
            </p>
          </div>

          {/* Product */}
          <div>
            <div className="text-xs font-semibold text-gray-900 uppercase tracking-wide mb-3">
              {t('product')}
            </div>
            <ul className="space-y-2 text-sm">
              <li><Link href="/voor-agencies"    className="text-gray-500 hover:text-gray-900">{tNav('forAgencies')}</Link></li>
              <li><Link href="/voor-callcentra"  className="text-gray-500 hover:text-gray-900">{tNav('forCallCenters')}</Link></li>
              <li><Link href="/voor-sales-teams" className="text-gray-500 hover:text-gray-900">{tNav('forSalesTeams')}</Link></li>
              <li><Link href="/hoe-het-werkt"    className="text-gray-500 hover:text-gray-900">{tNav('howItWorks')}</Link></li>
              <li><Link href="/pricing"          className="text-gray-500 hover:text-gray-900">{tNav('pricing')}</Link></li>
            </ul>
          </div>

          {/* Account */}
          <div>
            <div className="text-xs font-semibold text-gray-900 uppercase tracking-wide mb-3">
              {t('account')}
            </div>
            <ul className="space-y-2 text-sm">
              <li><Link href="/auth/register" className="text-gray-500 hover:text-gray-900">{t('createAccount')}</Link></li>
              <li><Link href="/auth/login"    className="text-gray-500 hover:text-gray-900">{t('signIn')}</Link></li>
              <li>
                <a href="mailto:arne@halcoservices.be" className="text-gray-500 hover:text-gray-900">
                  {t('contact')}
                </a>
              </li>
            </ul>
          </div>

          {/* Juridisch / bedrijf */}
          <div>
            <div className="text-xs font-semibold text-gray-900 uppercase tracking-wide mb-3">
              {t('company')}
            </div>
            <ul className="space-y-2 text-sm text-gray-500">
              <li>{t('companyName')}</li>
              <li>{t('location')}</li>
              <li>{t('vat')}</li>
            </ul>
          </div>
        </div>

        <div className="pt-6 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-400">
          <div>© {new Date().getFullYear()} Halco Services · CallScope</div>
          <div className="flex gap-4">
            <span>{t('monthlyCancel')}</span>
            <span>·</span>
            <span>{t('noLockIn')}</span>
            <span>·</span>
            <span>{t('belgianProduct')}</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
