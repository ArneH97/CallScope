import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import ProjectFilterUrl from '@/components/ui/ProjectFilterUrl'
import CoachingBlock from '@/components/CoachingBlock'
import PreferencesOnboarding from '@/components/PreferencesOnboarding'

export default async function DashboardPage({
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

  // Sync user_metadata → profile. De Supabase auth-trigger pakt soms niet alle
  // velden op (bv. role/full_name), dus we doen het hier nogmaals defensief.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metaUpdates: any = {}
  const metaRole = user.user_metadata?.role
  const metaIsFreelance = Boolean(user.user_metadata?.is_freelance)
  const metaFullName = user.user_metadata?.full_name
  if (metaRole && profile.role !== metaRole) metaUpdates.role = metaRole
  if (metaIsFreelance && !profile.is_freelance) metaUpdates.is_freelance = true
  if (metaFullName && (!profile.full_name || profile.full_name.trim() === '')) metaUpdates.full_name = metaFullName
  if (Object.keys(metaUpdates).length > 0) {
    await supabase.from('profiles').update(metaUpdates).eq('id', user.id)
    Object.assign(profile, metaUpdates)
  }

  if (profile.is_freelance && profile.role === 'cc_manager') {
    const { data: existingCc } = await supabase
      .from('call_centers')
      .select('id')
      .eq('manager_id', user.id)
      .maybeSingle()

    let callCenterId = existingCc?.id
    if (!callCenterId) {
      const { data: newCc } = await supabase
        .from('call_centers')
        .insert({ manager_id: user.id, name: profile.full_name })
        .select('id')
        .single()
      callCenterId = newCc?.id
    }

    if (callCenterId) {
      await supabase
        .from('call_center_members')
        .upsert(
          { call_center_id: callCenterId, profile_id: user.id },
          { onConflict: 'call_center_id,profile_id' },
        )
    }
  }

  if (profile.role === 'sales_manager' || profile.role === 'sales_rep') {
    redirect('/dashboard/sales')
  }

  if (profile.role === 'cc_manager') {
    redirect('/dashboard/team')
  }

  const projectFilter = searchParams?.project && searchParams.project !== 'alle' ? searchParams.project : null

  // Cold caller ziet ENKEL zijn eigen uploads — niet die van collega's of de
  // cc_manager. Cruciaal voor multi-caller setups: een nieuwe Arne Testcaller
  // op een lopend project mag geen 138 leads van iemand anders zien.
  let uploadsQuery = supabase
    .from('upload_summary')
    .select('*')
    .eq('caller_id', user.id)
    .order('uploaded_at', { ascending: false })
    .limit(5)
  if (projectFilter) uploadsQuery = uploadsQuery.eq('project_id', projectFilter)
  const { data: uploads } = await uploadsQuery

  // Lijst projecten waarop deze cold_caller werkt.
  const { data: callerProjects } = await supabase
    .from('project_members')
    .select('project_id, projects(id, name)')
    .eq('profile_id', user.id)
    .eq('role', 'cold_caller')
    .returns<{ project_id: string; projects: { id: string; name: string } | null }[]>()

  const projectList = (callerProjects ?? [])
    .filter(p => p.projects)
    .map(p => ({ id: p.projects!.id, name: p.projects!.name }))

  // Stats uit ALLE call_records van deze caller — niet enkel uit manuele
  // uploads. Bij projecten met Google Sheets / Lemlist sync zou anders
  // het dashboard leeg blijven omdat upload_summary leeg is voor synced data.
  // Filter ook op project_id wanneer projectFilter actief is.
  let recordsQuery = supabase
    .from('uploads')
    .select('id')
    .eq('caller_id', user.id)
  if (projectFilter) recordsQuery = recordsQuery.eq('project_id', projectFilter)
  const { data: callerUploads } = await recordsQuery
  const callerUploadIds = ((callerUploads ?? []) as { id: string }[]).map(u => u.id)

  let totalCalls = 0, totalReached = 0, totalAppointments = 0
  if (callerUploadIds.length > 0) {
    const { data: callRecords } = await supabase
      .from('call_records')
      .select('status')
      .in('upload_id', callerUploadIds)
    type CR = { status: string | null }
    const records = (callRecords ?? []) as CR[]
    totalCalls = records.length
    for (const r of records) {
      const s = (r.status ?? '').toLowerCase()
      if (s && !['niet bereikt', 'no answer', 'voicemail', 'vm', 'geen gehoor', 'nv'].some(k => s.includes(k))) {
        totalReached++
      }
      if (/afspraak|appointment/i.test(s)) {
        totalAppointments++
      }
    }
  }

  const totals = {
    calls:        totalCalls,
    reached:      totalReached,
    appointments: totalAppointments,
  }

  const conversionPct = totals.reached > 0
    ? Math.round(totals.appointments / totals.reached * 100)
    : 0

  // Heeft deze caller überhaupt al activiteit? Als nul records én geen uploads,
  // tonen we een welkom-empty-state in plaats van de stat-cards.
  const hasAnyActivity = totals.calls > 0 || (uploads ?? []).length > 0

  // Coaching-advies (gecached). Tonen we enkel als er activity is.
  // De UI is een client-component met een "Vernieuw advies"-knop.
  const { data: coaching } = await supabase
    .from('caller_coaching_insights')
    .select('advice_text, context_summary, generated_at')
    .eq('caller_id', user.id)
    .maybeSingle()

  const t = await getTranslations('dashboard')

  // Onboarding-modal: tonen wanneer user nog geen voorkeuren heeft gezet.
  // De modal saved naar /api/profile/preferences en doet daarna router.refresh().
  const showPrefsOnboarding = profile.preferences_set_at == null

  return (
    <div>
      {showPrefsOnboarding && (
        <PreferencesOnboarding
          initialLocale={profile.locale ?? 'nl'}
          initialCountry={profile.country ?? 'BE'}
          initialDateFormat={profile.date_format ?? 'DD/MM/YYYY'}
          initialCurrency={profile.currency ?? 'EUR'}
          initialTimezone={profile.timezone ?? 'Europe/Brussels'}
        />
      )}

      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            {t('greeting', { name: profile.full_name.split(' ')[0] })}
          </h1>
          <p className="text-gray-500 mt-1 text-sm">
            {t('subtitle')}
          </p>
        </div>
        <ProjectFilterUrl projects={projectList} />
      </div>

      {hasAnyActivity && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Leads gebeld',  value: totals.calls,        color: 'text-gray-900' },
            { label: 'Bereikt',       value: totals.reached,      color: 'text-gray-900' },
            { label: 'Afspraken',     value: totals.appointments, color: 'text-brand-700' },
            { label: 'Conversie',     value: `${conversionPct}%`, color: 'text-green-700' },
          ].map(stat => (
            <div key={stat.label} className="card p-4">
              <div className="text-xs text-gray-400 mb-1">{stat.label}</div>
              <div className={`text-2xl font-semibold ${stat.color}`}>{stat.value}</div>
            </div>
          ))}
        </div>
      )}

      <CoachingBlock
        initialAdvice={coaching?.advice_text ?? null}
        initialContext={coaching?.context_summary ?? null}
        initialGeneratedAt={coaching?.generated_at ?? null}
        hasActivity={hasAnyActivity}
      />

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
            <div className="w-14 h-14 mx-auto mb-3 rounded-xl bg-brand-50 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M12 16V4M8 8l4-4 4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" stroke="#1a35e6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h3 className="text-base font-semibold text-gray-900 mb-1.5">
              Nog geen calls
            </h3>
            <p className="text-sm text-gray-500 max-w-sm mx-auto leading-relaxed mb-4">
              Werk je in een Google Sheet of Lemlist? Je calls verschijnen hier dagelijks
              automatisch via de sync. Of upload zelf een CSV/Excel via de upload-pagina.
            </p>
            <div className="flex justify-center gap-2 flex-wrap">
              <a href="/dashboard/upload" className="btn-primary inline-block text-sm">
                Naar upload →
              </a>
              <a href="/dashboard/appointments" className="btn-secondary inline-block text-sm">
                Bekijk afspraken
              </a>
            </div>
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
