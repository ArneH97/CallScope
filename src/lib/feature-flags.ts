/**
 * Feature-flags die op project-niveau gelden.
 *
 * Momenteel alleen de Appointment-planner: die zit nog in private-beta voor
 * één klant (RestoManager) en mag niet zichtbaar zijn voor andere users.
 *
 * Strategie:
 *   1. ENV `NEXT_PUBLIC_PLANNER_PROJECT_IDS` heeft voorrang — comma-separated
 *      lijst van project-UUIDs die de planner mogen zien. Bij elke nieuwe
 *      klant zet je z'n project-id erbij op Vercel en push je opnieuw.
 *   2. Fallback: project-naam matcht regex `/restomanager/i`. Handig zodat de
 *      eerste werking direct out-of-the-box klopt zonder dat we de UUID
 *      van het RestoManager-project moeten opzoeken.
 *
 * Wanneer de planner GA gaat (= voor alle gebruikers): vervang deze functie
 * door `return true` en haal hem stapsgewijs weg uit alle callers.
 */

const RAW_WHITELIST = process.env.NEXT_PUBLIC_PLANNER_PROJECT_IDS ?? ''
const PLANNER_PROJECT_IDS = RAW_WHITELIST
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const PLANNER_NAME_PATTERN = /restomanager/i

export type PlannerProjectRef = { id: string; name?: string | null }

/**
 * True wanneer dit specifieke project de planner-feature mag tonen.
 */
export function isPlannerProject(p: PlannerProjectRef | null | undefined): boolean {
  if (!p) return false
  if (PLANNER_PROJECT_IDS.length > 0) return PLANNER_PROJECT_IDS.includes(p.id)
  return !!p.name && PLANNER_NAME_PATTERN.test(p.name)
}

/**
 * True wanneer de user op minstens één planner-project zit. Gebruikt door
 * de sidebar om de Planner-knop wel/niet te tonen.
 */
export function userHasPlannerAccess(projects: PlannerProjectRef[]): boolean {
  return projects.some(isPlannerProject)
}
