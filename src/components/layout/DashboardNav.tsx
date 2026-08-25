'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Link, usePathname, useRouter } from '@/i18n/routing'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/types/database'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import { userHasPlannerAccess } from '@/lib/feature-flags'

interface Props {
  profile: Profile
}

interface NavItem {
  href: string
  /** i18n key onder `nav.*` */
  labelKey: string
  icon: React.ReactNode
  roles: string[]
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/dashboard',
    labelKey: 'overview',
    roles: ['cold_caller'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    href: '/dashboard/sales',
    labelKey: 'overview',
    roles: ['sales_rep', 'sales_manager'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    href: '/dashboard/team',
    labelKey: 'myTeam',
    roles: ['cc_manager'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="11" cy="5" r="2" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M1 13c0-2.5 2-4 5-4s5 1.5 5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M13 13c0-1.5-.8-2.8-2-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    href: '/dashboard/upload',
    labelKey: 'upload',
    roles: ['cold_caller', 'cc_manager'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 10V3M8 3L5 6M8 3L11 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M3 11V13H13V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    href: '/dashboard/projects',
    labelKey: 'projects',
    roles: ['cold_caller', 'cc_manager', 'sales_rep', 'sales_manager'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 4H14M2 8H14M2 12H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    href: '/dashboard/appointments',
    labelKey: 'appointments',
    roles: ['sales_rep', 'sales_manager', 'cc_manager', 'cold_caller'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M5 2V4M11 2V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M2 7H14" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M5 10H8M5 12.5H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    // Appointment-planner: project-picker route die doorlinkt naar de
    // planner-pagina van het gekozen project. Eén project → auto-redirect.
    href: '/dashboard/planner',
    labelKey: 'planner',
    roles: ['cc_manager', 'sales_manager', 'sales_rep', 'cold_caller'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 3.5v4l2.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M13 3l-1.5 1.5M3 3l1.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    href: '/dashboard/settings/integrations',
    labelKey: 'integrations',
    // sales_rep zit er nu ook bij — die moet z'n Google Calendar kunnen
    // koppelen voor de appointment-planner (write naar agenda).
    roles: ['cc_manager', 'sales_manager', 'sales_rep'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 8H6M10 8H13M3 4H8M3 12H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="8" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="11" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="8" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
]

export default function DashboardNav({ profile }: Props) {
  const t = useTranslations('nav')
  const pathname = usePathname()
  const router = useRouter()
  // Mobile slide-in state. Op desktop wordt deze waarde genegeerd (sidebar
  // is altijd zichtbaar via md:translate-x-0). Sluit automatisch bij navigatie.
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => { setMobileOpen(false) }, [pathname])

  // Planner is private-beta voor RestoManager. We tonen de sidebar-knop alleen
  // wanneer de user op minstens één whitelisted project zit. Tot die check
  // klaar is laten we 'm uit (anders flasht hij even voor iedereen).
  const [hasPlanner, setHasPlanner] = useState(false)
  useEffect(() => {
    let cancelled = false
    const sb = createClient()
    ;(async () => {
      let projects: { id: string; name: string }[] = []
      if (profile.role === 'cc_manager') {
        // cc_manager → via call_centers → project_call_centers
        const { data: cc } = await sb
          .from('call_centers')
          .select('id')
          .eq('manager_id', profile.id)
          .maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ccId = (cc as any)?.id as string | undefined
        if (ccId) {
          const { data: pcc } = await sb
            .from('project_call_centers')
            .select('projects(id, name)')
            .eq('call_center_id', ccId)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          projects = ((pcc ?? []) as any[]).map(r => r.projects).filter(Boolean)
        }
      } else {
        const { data: pm } = await sb
          .from('project_members')
          .select('projects(id, name)')
          .eq('profile_id', profile.id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        projects = ((pm ?? []) as any[]).map(r => r.projects).filter(Boolean)
      }
      if (!cancelled) setHasPlanner(userHasPlannerAccess(projects))
    })()
    return () => { cancelled = true }
  }, [profile.id, profile.role])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/auth/login')
    router.refresh()
  }

  const isFreelance = profile.is_freelance && profile.role === 'cc_manager'
  const visibleItems = NAV_ITEMS.filter(item => {
    if (!item.roles.includes(profile.role)) return false
    // Planner is feature-flagged op project-niveau: hide tot we weten dat
    // de user op een whitelisted project zit.
    if (item.href === '/dashboard/planner' && !hasPlanner) return false
    return true
  })

  // Role-label uit i18n: 'cold_caller' → t('roles.cold_caller')
  const roleLabel = (() => {
    try { return t(`roles.${profile.role}`) } catch { return profile.role }
  })()

  const isPersonalView = pathname.startsWith('/dashboard/personal')
  const isTeamView     = pathname.startsWith('/dashboard/team')

  return (
    <>
      {/* Mobile-only hamburger top bar (verschijnt enkel onder md breakpoint) */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-12 bg-white border-b border-gray-100 z-20 flex items-center px-4 gap-3">
        <button
          onClick={() => setMobileOpen(true)}
          className="text-gray-700 hover:text-gray-900 -ml-1 p-2"
          aria-label={t('openMenu')}
        >
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-brand-600 rounded-md flex items-center justify-center flex-shrink-0">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="white" strokeWidth="1.5"/>
              <path d="M8 3v2M8 11v2M3 8h2M11 8h2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="8" cy="8" r="1.4" fill="white"/>
            </svg>
          </div>
          <span className="font-semibold text-sm tracking-tight">CallScope</span>
        </div>
      </div>

      {/* Backdrop overlay — alleen mobile, alleen wanneer menu open */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="md:hidden fixed inset-0 bg-black/40 z-30"
          aria-hidden="true"
        />
      )}

      <aside className={`
        fixed left-0 top-0 h-screen w-56 bg-white border-r border-gray-100 flex flex-col z-40
        transition-transform duration-200 ease-out
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        md:translate-x-0 md:z-10
      `}>
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="5.5" stroke="white" strokeWidth="1.5"/>
              <path d="M8 3v2M8 11v2M3 8h2M11 8h2" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="8" cy="8" r="1.4" fill="white"/>
            </svg>
          </div>
          <span className="font-semibold text-sm tracking-tight">CallScope</span>
        </div>
      </div>

      {isFreelance && (
        <div className="px-3 pt-3">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
            <Link
              href="/dashboard/team"
              className={`flex-1 text-center px-2 py-1.5 rounded-md text-xs transition-colors ${
                isTeamView
                  ? 'bg-white text-gray-900 font-medium shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t('team')}
            </Link>
            <Link
              href="/dashboard/personal"
              className={`flex-1 text-center px-2 py-1.5 rounded-md text-xs transition-colors ${
                isPersonalView
                  ? 'bg-white text-gray-900 font-medium shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t('myCalls')}
            </Link>
          </div>
        </div>
      )}

      <nav className="flex-1 p-3 space-y-0.5">
        {visibleItems.map(item => {
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-brand-50 text-brand-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <span className={isActive ? 'text-brand-600' : 'text-gray-400'}>
                {item.icon}
              </span>
              {t(item.labelKey)}
            </Link>
          )
        })}
      </nav>

      <div className="p-3 border-t border-gray-100">
        {/* Language switcher: laat de user wisselen tussen NL en EN. Plaatsing
            onder de profile-link houdt de meest gebruikte items bovenaan. */}
        <div className="px-3 mb-2 flex justify-end">
          <LanguageSwitcher />
        </div>
        <Link
          href="/dashboard/settings/account"
          className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg mb-1 transition-colors ${
            pathname.startsWith('/dashboard/settings/account')
              ? 'bg-brand-50'
              : 'hover:bg-gray-50'
          }`}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-900 truncate">{profile.full_name}</div>
            <div className="text-xs text-gray-400 mt-0.5">{roleLabel}</div>
          </div>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-gray-300 flex-shrink-0">
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </Link>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M11 11l3-3-3-3M14 8H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {t('logout')}
        </button>
      </div>
    </aside>
    </>
  )
}
