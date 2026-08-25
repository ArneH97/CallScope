'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/types/database'
import { isPlannerProject } from '@/lib/feature-flags'

/**
 * Project-picker voor de planner. Sidebar linkt hierheen omdat de sidebar
 * (in tegenstelling tot de project-pagina's) geen project-context heeft.
 *
 * Flow:
 *   - 0 projecten: melding + link naar projecten-pagina
 *   - 1 project: redirect direct naar /dashboard/projects/[id]/planner
 *   - 2+ projecten: lijst met kaartjes, klik = naar planner van dat project
 */
export default function PlannerHubPage() {
  const t = useTranslations('dashboard.planner.hub')
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data: prof } = await sb.from('profiles').select('*').eq('id', user.id).single()
      const p = prof as Profile | null
      setProfile(p)

      // Welke projecten zijn voor de user toegankelijk?
      //  - cold_caller / sales_rep / sales_manager: via project_members
      //  - cc_manager:                              via project_call_centers → call_centers
      let result: { id: string; name: string }[] = []
      if (p?.role === 'cc_manager') {
        const { data: cc } = await sb.from('call_centers').select('id').eq('manager_id', user.id).maybeSingle()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ccId = (cc as any)?.id as string | undefined
        if (ccId) {
          const { data: pccRows } = await sb
            .from('project_call_centers')
            .select('project_id, projects(id, name)')
            .eq('call_center_id', ccId)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result = ((pccRows ?? []) as any[])
            .map(r => r.projects)
            .filter(Boolean)
            .map(p => ({ id: p.id, name: p.name }))
        }
      } else {
        const { data: pmRows } = await sb
          .from('project_members')
          .select('project_id, projects(id, name)')
          .eq('profile_id', user.id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = ((pmRows ?? []) as any[])
          .map(r => r.projects)
          .filter(Boolean)
          .map(p => ({ id: p.id, name: p.name }))
      }

      // Dedup (een freelance cc_manager kan ook lid zijn als sales_rep)
      const seen = new Set<string>()
      result = result.filter(p => {
        if (seen.has(p.id)) return false
        seen.add(p.id)
        return true
      })

      // Feature-flag: planner is private-beta voor RestoManager. Andere
      // projecten verdwijnen uit de keuze. Als er niks overblijft krijgt
      // de user de empty-state met link naar /dashboard/projects.
      result = result.filter(isPlannerProject)

      // Auto-redirect bij precies 1 project
      if (result.length === 1) {
        router.replace(`/dashboard/projects/${result[0].id}/planner`)
        return
      }

      setProjects(result)
      setLoading(false)
    })
  }, [router])

  if (loading) return <div className="text-sm text-gray-400 p-8">{t('loading')}</div>
  if (!profile) return null

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{t('title')}</h1>
        <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
      </div>

      {projects.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-gray-500 mb-3">{t('empty')}</p>
          <Link href="/dashboard/projects" className="text-sm text-brand-600 hover:underline">
            {t('emptyLink')}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {projects.map(p => (
            <Link
              key={p.id}
              href={`/dashboard/projects/${p.id}/planner`}
              className="card p-5 hover:border-brand-300 transition-colors group"
            >
              <div className="text-sm font-medium text-gray-900 mb-1">{p.name}</div>
              <div className="text-xs text-brand-600 group-hover:underline">
                {t('openLink')}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
