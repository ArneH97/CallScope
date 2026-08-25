import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import DashboardNav from '@/components/layout/DashboardNav'
import Tutorial from '@/components/Tutorial'
import HelpButton from '@/components/HelpButton'
import WelcomeEmailTrigger from '@/components/WelcomeEmailTrigger'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/auth/login')

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <DashboardNav profile={profile} />
      {/* Mobile: extra top-padding voor de hamburger top-bar (h-12).
          Desktop: ml-56 voor de fixed sidebar, normale padding. */}
      <main className="flex-1 ml-0 md:ml-56 pt-16 md:pt-8 px-4 md:px-8 pb-8 max-w-6xl w-full">
        {children}
      </main>
      {/* Welkomst-modal — toont enkel bij eerste login (tutorial_completed_at IS NULL) */}
      <Tutorial />
      {/* Stille trigger: stuurt welkomstmail bij eerste dashboard-bezoek (idempotent) */}
      <WelcomeEmailTrigger />
      {/* Floating help-knop rechtsonder, op alle dashboard-pagina's */}
      <HelpButton />
    </div>
  )
}
