'use client'

import { useState, useEffect, useRef } from 'react'

/**
 * Drie filter-modi:
 *  - month:  een specifieke maand (default = huidige), navigeerbaar via prev/next pijlen
 *  - week:   een specifieke week (maandag-zondag), navigeerbaar via prev/next pijlen
 *  - custom: gebruiker kiest from + to via twee date-inputs
 *
 * Sinds 2026-05-04 (rev 2): vereenvoudigd t.o.v. de oude 7d/30d/this_month/alle/custom
 * mix. Maand-navigatie is intuïtiever en past bij hoe BE-call centers facturatie
 * indelen (per maand).
 *
 * 2026-05-20 (rev 3): week-modus toegevoegd voor managers die op detail-niveau
 * willen kijken (welke week was beter dan vorige). Maand blijft default.
 */
export type DateFilterKind = 'month' | 'week' | 'custom'

export type DateRange = { from: Date | null; to: Date | null }

interface Props {
  /**
   * Welke kind is standaard geselecteerd. Default = 'month' op de huidige maand.
   * Legacy waardes ('7d', '30d', 'this_month', 'alle') worden silently als 'month' behandeld
   * voor backwards compat met pagina's die nog niet geüpdatet zijn.
   */
  defaultKind?: DateFilterKind | '7d' | '30d' | 'this_month' | 'alle'
  /** Callback met de afgeleide datum-range telkens iets wijzigt. */
  onChange: (range: DateRange, kind: DateFilterKind) => void
}

/** Eerste dag van de huidige maand, op 00:00 lokale tijd. */
function firstOfThisMonth(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

/** Maandag (00:00 lokale tijd) van de week waarin `date` valt. */
function mondayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0)
  const day = d.getDay()
  // Zondag = 0 → we willen 6 dagen terug; anders day - 1 dagen terug
  const offset = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + offset)
  return d
}

/** Maandag van de huidige week, 00:00 lokale tijd. */
function mondayOfThisWeek(): Date {
  return mondayOf(new Date())
}

export default function DateRangeFilter({ defaultKind = 'month', onChange }: Props) {
  // Legacy defaultKinds normaliseren naar 'month'
  const initialKind: DateFilterKind =
    defaultKind === 'custom' ? 'custom' :
    defaultKind === 'week'   ? 'week'   : 'month'

  const [kind, setKind]               = useState<DateFilterKind>(initialKind)
  const [monthDate, setMonthDate]     = useState<Date>(firstOfThisMonth())
  const [weekDate, setWeekDate]       = useState<Date>(mondayOfThisWeek())  // maandag
  const [customFrom, setCustomFrom]   = useState<string>('')
  const [customTo, setCustomTo]       = useState<string>('')

  // We bewaren de laatste callback in een ref zodat de useEffect niet
  // hertriggert bij elke render van de parent (callback is meestal inline).
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  useEffect(() => {
    onChangeRef.current(resolveRange(kind, monthDate, weekDate, customFrom, customTo), kind)
  }, [kind, monthDate, weekDate, customFrom, customTo])

  function shiftMonth(delta: number) {
    if (kind !== 'month') setKind('month')
    setMonthDate(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
  }

  function shiftWeek(delta: number) {
    if (kind !== 'week') setKind('week')
    setWeekDate(prev => {
      const d = new Date(prev)
      d.setDate(d.getDate() + delta * 7)
      return d
    })
  }

  /** Pijl-handler die kijkt naar de actieve mode (custom valt terug op maand). */
  function shift(delta: number) {
    if (kind === 'week') shiftWeek(delta)
    else                 shiftMonth(delta)
  }

  function jumpToCurrent() {
    if (kind === 'week') {
      setWeekDate(mondayOfThisWeek())
    } else {
      setKind('month')
      setMonthDate(firstOfThisMonth())
    }
  }

  // Maand-label, eerste letter hoofdletter ("Mei 2026")
  const rawMonth   = monthDate.toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' })
  const monthLabel = rawMonth.charAt(0).toUpperCase() + rawMonth.slice(1)

  // Week-label — "11-17 mei" of "29 dec - 4 jan" als de week over een maandgrens loopt
  const weekLabel = formatWeekLabel(weekDate)

  // Detecteer of we op de huidige periode zitten (voor tooltip-tekst)
  const thisMonth = firstOfThisMonth()
  const isCurrentMonth =
    kind === 'month' &&
    monthDate.getFullYear() === thisMonth.getFullYear() &&
    monthDate.getMonth()    === thisMonth.getMonth()
  const thisWeekMonday = mondayOfThisWeek()
  const isCurrentWeek =
    kind === 'week' &&
    weekDate.getTime() === thisWeekMonday.getTime()
  const isCurrent = isCurrentMonth || isCurrentWeek

  // Welk label tonen we in het midden van de navigator?
  const navLabel = kind === 'week' ? weekLabel : monthLabel

  // Tooltip-strings
  const prevTitle = kind === 'week' ? 'Vorige week'   : 'Vorige maand'
  const nextTitle = kind === 'week' ? 'Volgende week' : 'Volgende maand'
  const jumpTitle = kind === 'week'
    ? (isCurrent ? 'Deze week'  : 'Spring naar deze week')
    : (isCurrent ? 'Deze maand' : 'Spring naar deze maand')

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Maand/Week pill-toggle */}
      <div className="inline-flex gap-0.5 bg-gray-100 p-0.5 rounded-md">
        <button
          onClick={() => setKind('month')}
          className={`text-xs px-2.5 py-1 rounded transition-colors ${
            kind === 'month'
              ? 'bg-white text-gray-900 font-medium shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Maand
        </button>
        <button
          onClick={() => setKind('week')}
          className={`text-xs px-2.5 py-1 rounded transition-colors ${
            kind === 'week'
              ? 'bg-white text-gray-900 font-medium shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Week
        </button>
      </div>

      {/* Navigator — chevrons + label.  Mode-afhankelijk: maand of week. */}
      <div className={`inline-flex items-center bg-gray-50 rounded-lg border ${
        kind !== 'custom' ? 'border-brand-300' : 'border-gray-200'
      }`}>
        <button
          onClick={() => shift(-1)}
          className="px-2 py-1.5 text-gray-500 hover:text-gray-900 transition-colors"
          aria-label={prevTitle}
          title={prevTitle}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          onClick={jumpToCurrent}
          className={`px-3 py-1.5 text-xs font-medium min-w-[110px] text-center transition-colors ${
            kind !== 'custom' ? 'text-gray-900' : 'text-gray-500 hover:text-gray-700'
          }`}
          title={jumpTitle}
        >
          {navLabel}
        </button>
        <button
          onClick={() => shift(+1)}
          className="px-2 py-1.5 text-gray-500 hover:text-gray-900 transition-colors"
          aria-label={nextTitle}
          title={nextTitle}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* Aangepast-knop */}
      <button
        onClick={() => setKind(kind === 'custom' ? 'month' : 'custom')}
        className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
          kind === 'custom'
            ? 'border-brand-300 bg-brand-50 text-brand-700 font-medium'
            : 'border-gray-200 text-gray-600 hover:border-brand-200 hover:text-gray-900'
        }`}
      >
        Aangepast
      </button>

      {kind === 'custom' && (
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={customFrom}
            onChange={e => setCustomFrom(e.target.value)}
            className="text-xs border border-gray-200 rounded-md px-2 py-1.5 text-gray-700 bg-white"
            aria-label="Vanaf datum"
          />
          <span className="text-xs text-gray-400">→</span>
          <input
            type="date"
            value={customTo}
            onChange={e => setCustomTo(e.target.value)}
            className="text-xs border border-gray-200 rounded-md px-2 py-1.5 text-gray-700 bg-white"
            aria-label="Tot datum"
          />
        </div>
      )}
    </div>
  )
}

/**
 * Vertaalt de gekozen filter naar een concrete { from, to } range.
 *  - month:  van eerste tot laatste dag van de gekozen maand
 *  - week:   van maandag 00:00 tot zondag 23:59 van de gekozen week
 *  - custom: from = customFrom 00:00, to = customTo 23:59
 */
function resolveRange(
  kind:       DateFilterKind,
  monthDate:  Date,
  weekDate:   Date,
  customFrom: string,
  customTo:   string,
): DateRange {
  if (kind === 'month') {
    const from = new Date(monthDate.getFullYear(), monthDate.getMonth(),     1, 0, 0, 0)
    const to   = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59)
    return { from, to }
  }
  if (kind === 'week') {
    // weekDate is altijd een maandag (00:00). Zondag = maandag + 6 dagen.
    const from = new Date(weekDate.getFullYear(), weekDate.getMonth(), weekDate.getDate(),     0,  0,  0)
    const to   = new Date(weekDate.getFullYear(), weekDate.getMonth(), weekDate.getDate() + 6, 23, 59, 59)
    return { from, to }
  }
  if (kind === 'custom') {
    return {
      from: customFrom ? new Date(customFrom + 'T00:00:00') : null,
      to:   customTo   ? new Date(customTo   + 'T23:59:59') : null,
    }
  }
  return { from: null, to: null }
}

/**
 * "11-17 mei" wanneer de week binnen één maand valt, anders "29 dec - 4 jan".
 * Verwacht een maandag-datum als input.
 */
function formatWeekLabel(monday: Date): string {
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  const sameMonth = monday.getMonth() === sunday.getMonth() && monday.getFullYear() === sunday.getFullYear()

  if (sameMonth) {
    const monthShort = monday.toLocaleDateString('nl-BE', { month: 'short' })
    return `${monday.getDate()}-${sunday.getDate()} ${monthShort}`
  }
  // Week strekt over maand- of jaargrens
  const a = monday.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })
  const b = sunday.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })
  return `${a} - ${b}`
}

/**
 * Helper: filtert of een datum binnen de gekozen range valt.
 */
export function isInRange(date: Date, range: DateRange): boolean {
  if (range.from && date < range.from) return false
  if (range.to   && date > range.to)   return false
  return true
}
