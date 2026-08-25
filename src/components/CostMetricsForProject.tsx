'use client'

import { useEffect, useState } from 'react'
import CostMetricsCard from './CostMetricsCard'
import type { CostMetrics } from '@/lib/cost-metrics'

/**
 * Client-side wrapper rond CostMetricsCard die metrics fetch'd via
 * /api/projects/[id]/cost-metrics. Bedoeld voor pagina's met dynamische
 * project + datum filters (zoals /dashboard/sales, /dashboard/team).
 *
 * 2026-05-20 (rev 2): de eigen filter (Deze week / Deze maand / Alles) is
 * weggehaald — de component volgt nu de fromIso/toIso die de parent
 * meegeeft. Op die manier sluit de tijd-en-kost-card aan bij de globale
 * datumfilter van de pagina (week/maand/aangepast in DateRangeFilter).
 *
 * Rendert NIETS als het project geen tarieven heeft of fetch faalt — de
 * feature is optioneel en mag stilletjes verborgen blijven.
 */
export default function CostMetricsForProject({
  projectId,
  fromIso,
  toIso,
}: {
  projectId: string
  /** Begin van de range (ISO 8601). Gebruik bv. dateRange.from.toISOString(). */
  fromIso:   string
  /** Einde van de range (ISO 8601). Gebruik bv. dateRange.to.toISOString(). */
  toIso:     string
}) {
  const [metrics, setMetrics] = useState<CostMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectId) {
      setMetrics(null)
      setLoading(false)
      return
    }
    // Cleanup-flag tegen race conditions: als de parent snel achtereenvolgens
    // andere from/to doorgeeft (bv. datumfilter wisselen, of eerste render
    // met sentinel gevolgd door echte maand), kan een trage eerste fetch
    // later terugkomen en de verse data overschrijven. Bij unmount / re-run
    // negeren we het resultaat van deze fetch.
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ from: fromIso, to: toIso })
    fetch(`/api/projects/${projectId}/cost-metrics?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) setMetrics(data?.metrics ?? null) })
      .catch(() => { if (!cancelled) setMetrics(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, fromIso, toIso])

  if (loading || !metrics) return null

  return <CostMetricsCard metrics={metrics} />
}
