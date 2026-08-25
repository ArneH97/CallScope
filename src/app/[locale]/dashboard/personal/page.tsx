import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import ProjectFilterUrl from '@/components/ui/ProjectFilterUrl'

/**
 * Persoonlijk overzicht voor freelance appointment setters.
 */
export default async function PersonalDashboardPage({
  searchParams,
}: {
  searchParams?: { project?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/auth/login')

  // Alleen voor freelance cc_managers — anderen weg.
  if (!profile.is_freelance || profile.role !== 'cc_manager') {
    redirect('/dashboard')
  }

  const projectFilter = searchParams?.project && searchParams.project !== 'alle' ? searchParams.project : null

  let uploadsQuery = supabase
    .from('upload_summary')
    .select('*')
    .eq('caller_id', user.id)
    .order('uploaded_at', { ascending: false })
    .limit(5)
  if (projectFilter) uploadsQuery = uploadsQuery.eq('project_id', projectFilter)
  const { data: uploads } = await uploadsQuery

  // Projecten van deze freelancer (via call_center koppeling).
  const { data: cc } = await supabase
    .from('call_centers')
    .select('id')
    .eq('manager_id', user.id)
    .maybeSingle()

  let projectList: { id: string; name: string }[] = []
  if (cc?.id) {
    const { data: pccs } = await supabase
      .from('project_call_centers')
      .select('project_id, projects(id, name)')
      .eq('call_center_id', cc.id)
      .returns<{ project_id: string; projects: { id: string; name: string } | null }[]>()
    projectList = (pccs ?? [])
      .filter(p => p.projects)
      .map(p => ({ id: p.projects!.id, name: p.projects!.name }))
  }

  const totals = (uploads ?? []).reduce(
    (acc, u) => ({
      calls:        acc.calls        + (u.total_calls  ?? 0),
      reached:      acc.reached      + (u.reached      ?? 0),
      appointments: acc.appointments + (u.appointments ?? 0),
      callbacks:    acc.callbacks    + (u.callbacks    ?? 0),
    }),
    { calls: 0, reached: 0, appointments: 0, callbacks: 0 }
  )

  const conversionPct = totals.reached > 0
    ? Math.round(totals.appointments / totals.reached * 100)
    : 0

  const t = await getTranslations('dashboard')

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="badge badge-blue">{t('personalBadge')}</span>
          </div>
          <h1 className="text-2xl font-semibold text-gray-900">
            {t('greeting', { name: profile.full_name.split(' ')[0] })}
          </h1>
          <p className="text-gray-500 mt-1 text-sm">
            {t('personalSubtitle')}
          </p>
        </div>
        <ProjectFilterUrl projects={projectList} />
      </div>

      {(uploads ?? []).length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            { label: t('stats.callsMade'),     value: totals.calls,        color: 'text-gray-900' },
            { label: t('stats.reached'),       value: totals.reached,      color: 'text-gray-900' },
            { label: t('stats.appointments'),  value: totals.appointments, color: 'text-brand-700' },
            { label: t('stats.conversion'),    value: `${conversionPct}%`, color: 'text-green-700' },
          ].map(stat => (
            <div key={stat.label} className="card p-4">
              <div className="text-xs text-gray-400 mb-1">{stat.label}</div>
              <div className={`text-2xl font-semibold ${stat.color}`}>{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <a href="/dashboard/upload" className="card p-5 hover:shadow-md transition-shadow group">
          <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center mb-3 group-hover:bg-brand-100 transition-colors">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <path d="M8 10V3M8 3L5 6M8 3L11 6" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 11V13H13V11" stroke="#2d4fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="font-medium text-gray-900 text-sm">Nieuwe upload</div>
          <div className="text-xs text-gray-400 mt-1">CSV of Excel importeren</div>
        </a>
        <a href="/dashboard/projects" className="card p-5 hover:shadow-md transition-shadow group">
          <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center mb-3 group-hover:bg-green-100 transition-colors">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
              <path d="M2 4H14M2 8H14M2 12H9" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="font-medium text-gray-900 text-sm">Projecten</div>
          <div className="text-xs text-gray-400 mt-1">Overzicht van alle campagnes</div>
        </a>
      </div>

      <div>
        <h2 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Recente uploads</h2>
        {!uploads || uploads.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-sm text-gray-400">
              Nog geen uploads. Start met je eerste CSV upload.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {uploads.map(u => (
              <a key={u.id} href={`/dashboard/upload/${u.id}`} className="card p-4 flex items-center justify-between hover:shadow-md transition-shadow">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gray-50 rounded-lg flex items-center justify-center text-gray-400">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M4 2h6l4 4v8a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M10 2v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-900">{u.filename}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {u.project_name}
                      {u.total_calls ? ` · ${u.total_calls} calls` : ''}
                      {u.appointments ? ` · ${u.appointments} afspraken` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {u.conversion_pct != null && (
                    <span className="text-xs text-gray-400">{u.conversion_pct}% conv.</span>
                  )}
                  <span className={`badge ${
                    u.status === 'done'       ? 'badge-green' :
                    u.status === 'processing' ? 'badge-amber' :
                    u.status === 'error'      ? 'badge-red'   : 'badge-gray'
                  }`}>
                    {u.status === 'done' ? 'Klaar' : u.status === 'processing' ? 'Verwerken' : u.status === 'error' ? 'Fout' : 'In wachtrij'}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
