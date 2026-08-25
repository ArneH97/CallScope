'use client'

interface Project {
  id: string
  name: string
}

interface Props {
  projects: Project[]
  value: string                            // 'alle' of project.id
  onChange: (value: string) => void
  label?: string                            // Default: 'Alle projecten'
  className?: string
  /** Verberg de 'Alle projecten'-optie (bv. op het team-dashboard waar
   *  cross-project altijd onnuttig is). */
  hideAll?: boolean
}

/**
 * Gestylede project-filter dropdown — gebruikt op /dashboard/team en
 * /dashboard/appointments. Custom appearance met folder-icoon links en
 * chevron rechts; verbergt de native select-styling.
 */
export default function ProjectFilter({ projects, value, onChange, label = 'Alle projecten', className = '', hideAll = false }: Props) {
  if (projects.length === 0) return null

  const active = value !== 'alle' || hideAll
  const count = projects.length
  const allLabel = count > 0 ? `${label} (${count})` : label

  return (
    <div className={`relative inline-block ${className}`}>
      {/* Folder icoon */}
      <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M2 4.5C2 3.67 2.67 3 3.5 3h3.17l1.33 1.5h4.5c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5h-9C2.67 13.5 2 12.83 2 12V4.5z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`
          appearance-none bg-white border rounded-lg pl-9 pr-9 py-1.5 text-sm
          font-medium cursor-pointer transition-all min-w-[200px]
          focus:outline-none focus:ring-2 focus:ring-brand-500/20
          ${active
            ? 'border-brand-300 text-brand-700 bg-brand-50/40'
            : 'border-gray-200 text-gray-700 hover:border-gray-300'}
        `}
      >
        {!hideAll && <option value="alle">{allLabel}</option>}
        {projects.map(p => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      {/* Chevron */}
      <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    </div>
  )
}
