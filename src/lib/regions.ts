/**
 * Sub-regio configuratie voor de appointment-planner.
 *
 * RestoManager (en mogelijk toekomstige klanten) verdelen een provincie in
 * sub-regio's en taggen die in hun Google Calendar als "WVL-NW", "WVL-W",
 * etc. Voor MVP is de mapping hardcoded in deze module. Toekomstige
 * uitbreiding: per project configureerbaar via een `project_regions` tabel.
 *
 * Match-strategie in de slot-finder (samengevat):
 *   - Strict region match wint: lead in WVL-NW + rep tagt WVL-NW = match.
 *   - Provincie-fallback: rep tagt enkel "West-Vlaanderen" of "WVL" zonder
 *     sub-regio → matched met élke WVL-lead.
 *   - Tegenover een rep die specifiek WVL-W tagt: een WVL-NW lead matched
 *     NIET, want de rep zegt expliciet "ik werk vandaag elders in WVL".
 *
 * Postcode-mapping: exacte 4-cijferige lookup (bron =
 * west-vlaanderen-mapping-v3.csv aangeleverd door RestoManager).
 * Postcodes die niet in de tabel staan → return null (lead valt buiten
 * deze sub-regio-indeling; slot-finder valt terug op zuivere provincie-match).
 */

export type RegionConfig = {
  /** Code zoals die in calendar event titles staat (case-insensitive). */
  code:     string
  /** Mooie naam voor UI. */
  name:     string
  /** Welke provincie deze regio bedient (lowercased slug). */
  province: string
}

export const BE_REGIONS: RegionConfig[] = [
  { code: 'WVL-NW', name: 'Brugge & Kust-Noord', province: 'west-vlaanderen' },
  { code: 'WVL-W',  name: 'Westhoek',            province: 'west-vlaanderen' },
  { code: 'WVL-M',  name: 'Roeselare-Tielt',     province: 'west-vlaanderen' },
  { code: 'WVL-Z',  name: 'Kortrijk-Waregem',    province: 'west-vlaanderen' },
]

/**
 * Exacte postcode → region code. Bron: RestoManager
 * west-vlaanderen-mapping-v3.csv (101 unieke postcodes, geen conflicten).
 *
 * Eén Map met 4-cijferige keys is sneller dan een prefix-search en 100%
 * accuraat — geen guesswork over edge-cases zoals 8480 (deels WVL-NW, deels
 * WVL-W) of 8930 (WVL-Z, niet WVL-M).
 */
const POSTAL_TO_REGION: Record<string, string> = {
  // WVL-NW (Brugge & Kust-Noord) — 25 postcodes
  '8000': 'WVL-NW', '8020': 'WVL-NW', '8200': 'WVL-NW', '8210': 'WVL-NW', '8211': 'WVL-NW',
  '8300': 'WVL-NW', '8301': 'WVL-NW', '8310': 'WVL-NW', '8340': 'WVL-NW', '8370': 'WVL-NW',
  '8377': 'WVL-NW', '8380': 'WVL-NW', '8400': 'WVL-NW', '8420': 'WVL-NW', '8421': 'WVL-NW',
  '8430': 'WVL-NW', '8431': 'WVL-NW', '8432': 'WVL-NW', '8433': 'WVL-NW', '8434': 'WVL-NW',
  '8450': 'WVL-NW', '8460': 'WVL-NW', '8470': 'WVL-NW', '8490': 'WVL-NW', '8730': 'WVL-NW',

  // WVL-W (Westhoek) — 30 postcodes
  '8480': 'WVL-W', '8600': 'WVL-W', '8620': 'WVL-W', '8630': 'WVL-W', '8640': 'WVL-W',
  '8647': 'WVL-W', '8650': 'WVL-W', '8660': 'WVL-W', '8670': 'WVL-W', '8680': 'WVL-W',
  '8690': 'WVL-W', '8691': 'WVL-W', '8900': 'WVL-W', '8902': 'WVL-W', '8904': 'WVL-W',
  '8906': 'WVL-W', '8908': 'WVL-W', '8920': 'WVL-W', '8950': 'WVL-W', '8951': 'WVL-W',
  '8952': 'WVL-W', '8953': 'WVL-W', '8954': 'WVL-W', '8956': 'WVL-W', '8957': 'WVL-W',
  '8958': 'WVL-W', '8970': 'WVL-W', '8972': 'WVL-W', '8978': 'WVL-W', '8980': 'WVL-W',

  // WVL-M (Roeselare-Tielt) — 19 postcodes
  '8610': 'WVL-M', '8700': 'WVL-M', '8710': 'WVL-M', '8720': 'WVL-M', '8740': 'WVL-M',
  '8750': 'WVL-M', '8760': 'WVL-M', '8770': 'WVL-M', '8780': 'WVL-M', '8800': 'WVL-M',
  '8810': 'WVL-M', '8820': 'WVL-M', '8830': 'WVL-M', '8840': 'WVL-M', '8850': 'WVL-M',
  '8851': 'WVL-M', '8870': 'WVL-M', '8880': 'WVL-M', '8890': 'WVL-M',

  // WVL-Z (Kortrijk-Waregem) — 27 postcodes
  '8501': 'WVL-Z', '8510': 'WVL-Z', '8511': 'WVL-Z', '8520': 'WVL-Z', '8530': 'WVL-Z',
  '8531': 'WVL-Z', '8540': 'WVL-Z', '8550': 'WVL-Z', '8551': 'WVL-Z', '8552': 'WVL-Z',
  '8553': 'WVL-Z', '8554': 'WVL-Z', '8560': 'WVL-Z', '8570': 'WVL-Z', '8572': 'WVL-Z',
  '8573': 'WVL-Z', '8580': 'WVL-Z', '8581': 'WVL-Z', '8582': 'WVL-Z', '8587': 'WVL-Z',
  '8790': 'WVL-Z', '8791': 'WVL-Z', '8792': 'WVL-Z', '8793': 'WVL-Z', '8860': 'WVL-Z',
  '8930': 'WVL-Z', '8940': 'WVL-Z',
}

/**
 * Provincie-aliases. Naast de officiële namen accepteren we korte codes
 * (zoals "WVL" voor west-vlaanderen) en alternatieve schrijfwijzes. Wordt
 * gebruikt door de calendar-event-parser zodat een rep die "WVL" of
 * "West-Vlaanderen" als all-day event in z'n agenda zet, ook matched.
 */
export const PROVINCE_ALIASES: Record<string, string> = {
  'wvl':              'west-vlaanderen',
  'west-vlaanderen':  'west-vlaanderen',
  'west vlaanderen':  'west-vlaanderen',
  'westvlaanderen':   'west-vlaanderen',
  'ovl':              'oost-vlaanderen',
  'oost-vlaanderen':  'oost-vlaanderen',
  'oost vlaanderen':  'oost-vlaanderen',
  'oostvlaanderen':   'oost-vlaanderen',
  'ant':              'antwerpen',
  'antwerpen':        'antwerpen',
  'lim':              'limburg',
  'limburg':          'limburg',
  'vbr':              'vlaams-brabant',
  'vlaams-brabant':   'vlaams-brabant',
  'vlaams brabant':   'vlaams-brabant',
  'vlaamsbrabant':    'vlaams-brabant',
  'bru':              'brussel',
  'brussel':          'brussel',
}

/**
 * Bepaal welke region bij een postcode hoort. Exacte 4-cijferige lookup.
 * Returnt null voor postcodes buiten de mapping (typisch: niet-WVL of leeg).
 */
export function pickRegion(postalCode: string | null | undefined): RegionConfig | null {
  if (!postalCode) return null
  const pc = postalCode.replace(/\s/g, '').slice(0, 4)
  if (!/^\d{4}$/.test(pc)) return null
  const code = POSTAL_TO_REGION[pc]
  if (!code) return null
  return BE_REGIONS.find(r => r.code === code) ?? null
}

/**
 * Snelle regex-detect van een region code in een tekst (event-titel of
 * locatie-veld). Case-insensitive. Returnt de eerste match in BE_REGIONS-
 * volgorde — codes worden geacht uniek genoeg te zijn dat dit veilig is.
 */
export function extractRegionCode(text: string | null | undefined): string | null {
  if (!text) return null
  const upper = text.toUpperCase()
  for (const r of BE_REGIONS) {
    const re = new RegExp(`(^|[^A-Z0-9])${escapeRegex(r.code)}([^A-Z0-9]|$)`)
    if (re.test(upper)) return r.code
  }
  return null
}

/**
 * Provincie-alias detectie. Probeert in vrije tekst (zoals een event-titel)
 * een provincie-naam of -code te vinden. Returnt de canonieke slug of null.
 * Gebruikt door de AI-event-location parser als snelle fast-path voor reps
 * die hun hele provincie tagen i.p.v. een sub-regio.
 */
export function extractProvinceAlias(text: string | null | undefined): string | null {
  if (!text) return null
  const lower = text.toLowerCase()
  // Probeer langere aliassen eerst zodat "west-vlaanderen" wint van "wvl"
  // wanneer beide in de string staan. Pas een eenvoudige sort op key-lengte.
  const sortedKeys = Object.keys(PROVINCE_ALIASES).sort((a, b) => b.length - a.length)
  for (const alias of sortedKeys) {
    const re = new RegExp(`(^|[^a-z])${escapeRegex(alias)}([^a-z]|$)`, 'i')
    if (re.test(lower)) return PROVINCE_ALIASES[alias]
  }
  return null
}

/**
 * Helper: gebruikt door slot-finder om te beslissen of we voor een
 * given provincie strict-region-match doen (= sub-regio's bekend voor
 * deze provincie) of klassieke provincie-match.
 */
export function isStrictRegionProvince(province: string | null): boolean {
  if (!province) return false
  return BE_REGIONS.some(r => r.province === province)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
