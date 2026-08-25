'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import ProjectFilter from './ProjectFilter'

interface Project {
  id: string
  name: string
}

interface Props {
  projects: Project[]
  paramName?: string
}

/**
 * Wrapper rond ProjectFilter voor server-components: schrijft de selectie in de
 * URL als ?project=xxx (of een custom paramName), zodat de server-component
 * via searchParams kan filteren. Gebruikt router.replace zodat het geen
 * history-entry creëert.
 */
export default function ProjectFilterUrl({ projects, paramName = 'project' }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const value = searchParams.get(paramName) ?? 'alle'

  function handleChange(next: string) {
    const params = new URLSearchParams(searchParams)
    if (next === 'alle') params.delete(paramName)
    else params.set(paramName, next)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
  }

  return <ProjectFilter projects={projects} value={value} onChange={handleChange} />
}
