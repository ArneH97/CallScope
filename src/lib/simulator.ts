/**
 * Projectie-berekening voor de rapport-simulator.
 *
 * Idee: momenteel zijn een deel van de afspraken nog niet uitgevoerd of
 * hebben nog geen feedback. We projecteren wat er zou gebeuren als álle
 * afspraken volgens de historische conversie-cijfers zouden aflopen.
 *
 * Input: al gemaakte deals (wonSoFar) + open afspraken (pending) + kost.
 * Formule:
 *   effectivePending = pending × (1 - noShow/100)
 *   projectedNewDeals = effectivePending × closing/100
 *   projectedTotalDeals = wonSoFar + projectedNewDeals
 *   projectedArr = projectedTotalDeals × arrPerDeal
 *   roi = projectedArr / totalCost (indien kost bekend)
 */

export interface SimulatorAssumptions {
  no_show_rate:  number    // % (0..100)
  closing_rate:  number    // % (0..100)
  arr_per_deal:  number    // EUR
}

export interface SimulatorInput extends SimulatorAssumptions {
  appointments_total:  number   // Alle afspraken in de periode
  deals_realized:      number   // Al effectief gewonnen (outcome=deal of dealstage=won)
  lost_or_no_show:     number   // Al negatief afgesloten (won't convert, uit pool)
  cost_total:          number   // Totale kost in de periode (EUR)
}

export interface SimulatorResult {
  pending_appointments:  number
  effective_pending:     number
  projected_new_deals:   number
  projected_total_deals: number
  projected_arr:         number
  roi_ratio:             number | null    // arr / cost (bv 3.2 = 320%)
  additional_arr:        number           // Wat er nog bovenop wonSoFar's ARR komt
}

export function computeSimulation(input: SimulatorInput): SimulatorResult {
  const {
    appointments_total, deals_realized, lost_or_no_show,
    no_show_rate, closing_rate, arr_per_deal, cost_total,
  } = input

  // Pending = afspraken waarvan we het einde nog niet weten.
  // Nooit negatief laten worden (edge case: data-consistentie).
  const pending = Math.max(0, appointments_total - deals_realized - lost_or_no_show)

  // Van de openstaande afspraken vallen een deel weg als no-show.
  const effectivePending = pending * (1 - no_show_rate / 100)

  // Op de effectieve pending passen we de closing rate toe.
  const projectedNewDeals = effectivePending * (closing_rate / 100)

  // Totaal geprojecteerd = al gewonnen + nog te winnen.
  const projectedTotalDeals = deals_realized + projectedNewDeals

  const projectedArr = projectedTotalDeals * arr_per_deal
  const additionalArr = projectedNewDeals * arr_per_deal
  const roi = cost_total > 0 ? projectedArr / cost_total : null

  return {
    pending_appointments:  round(pending, 1),
    effective_pending:     round(effectivePending, 1),
    projected_new_deals:   round(projectedNewDeals, 1),
    projected_total_deals: round(projectedTotalDeals, 1),
    projected_arr:         Math.round(projectedArr),
    roi_ratio:             roi != null ? round(roi, 2) : null,
    additional_arr:        Math.round(additionalArr),
  }
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals)
  return Math.round(n * f) / f
}
