# CallScope i18n — voortgang

_Laatste update: 11 mei 2026_

## Status

Bezig met **bulk-vertaling van dashboard-pagina's en componenten** naar next-intl
(taak #195 in_progress). NL + EN messages in `src/messages/{nl,en}.json`.

## Wat staat er en wat moet nog

### ✅ Vertaald deze sessies

**Pagina's** (in `src/app/[locale]/dashboard/`):
- `appointments/page.tsx` (557 lijnen) — task #220
- `upload/[id]/page.tsx` (469 lijnen) — task #221
- `sales/page.tsx` (510 lijnen) — task #222
- `projects/page.tsx` (835 lijnen, projecten-lijst) — task #223
- `settings/integrations/page.tsx` (581 lijnen) — task #224
- `settings/account/page.tsx` (270 lijnen) — task #225
- `projects/[id]/confirm-hours/page.tsx` (498 lijnen) — task #226
- `projects/[id]/report/page.tsx` + ReportActions + ReportView + CostMetricsCard + `r/[token]` share — task #227
- `projects/new/page.tsx` (724 lijnen, wizard) — task #228
- `projects/[id]/settings/page.tsx` (1026 lijnen, GROOTSTE) — task #230

**Componenten**:
- `Tutorial.tsx` (251 lijnen, rol-specifieke welkomst-modal) — task #229
- `ReportActions.tsx`, `ReportView.tsx`, `CostMetricsCard.tsx` (in task #227)

### ⏳ Nog te doen

**Pagina** (de grote brok die nog open ligt):
- `upload/page.tsx` (1330 lijnen) — CSV/Excel/Google Sheets upload-wizard met
  drag-drop, kolom-mapping, data-preview, validatie, sessie-dating.

**Componenten** met substantiële NL hardcoded text:
1. **HubSpotListPicker.tsx** (289 lijnen) — HIGH prio. Strings: "HubSpot status
   laden", "HubSpot nog niet gekoppeld", "Verbind HubSpot", "Kon HubSpot-lists
   niet laden", "Netwerkfout", save-confirms.
2. **OnboardingChecklist.tsx** (261 lijnen) — HIGH prio. Checklist titels +
   descriptions: "Maak je eerste project aan", "Nodig je team uit", "Doe je
   eerste upload", step labels, progress text.
3. **HelpButton.tsx** (227 lijnen) — MEDIUM. Help-modal: "Hulp nodig?", form
   labels, placeholders, file size messages, error/success states.
4. **CoachingBlock.tsx** (155 lijnen) — MEDIUM. "Coaching op maat" header,
   "Genereer advies"/"Vernieuw advies" buttons, metric labels.
5. **LemlistCampaignPicker.tsx** — niet onderzocht maar wordt geïmporteerd door
   project-settings, check of er NL strings staan.
6. **CallerRatesEditor.tsx** — idem, gebruikt door project-settings.
7. **TrialBanner.tsx** — gebruikt door project-settings, vermoedelijk NL.

## Conventies / patronen die we gebruiken

### Locale-mapping voor datums/getallen
```ts
const locale = useLocale()           // 'nl' | 'en'
const bcp47 = locale === 'nl' ? 'nl-BE' : locale
date.toLocaleDateString(bcp47, { day: 'numeric', month: 'long', year: 'numeric' })
```
In server components: `await getLocale()` van `next-intl/server`.

### Server vs client components
- **Client** (`'use client'`): `import { useTranslations, useLocale } from 'next-intl'`
- **Server** (async): `import { getTranslations, getLocale } from 'next-intl/server'`
  → component moet **async** zijn. We hebben `ReportView` en `CostMetricsCard`
  van sync→async gemigreerd zonder dat de consumers ervan iets moesten wijzigen.

### HTML in strings
Voor strings met inline `<strong>`, `<em>`, `<code>` etc.: gebruik
`dangerouslySetInnerHTML={{ __html: t('key') }}`. Voor inline links: gebruik
`t.rich('key', { link: (chunks) => <Link href="...">{chunks}</Link> })` —
zie `project-settings.google.noMappingHint`.

### ICU plurals
```json
"recordsSuffix": " · {count, plural, =1 {# record} other {# records}}"
```

### JSON arrays (voor lijsten als content)
```ts
const items = t.raw('futureIntegrations.items') as string[]
{items.map((item, i) => <li key={i}>{item}</li>)}
```

### Suspense fallback met useTranslations
Maak een aparte component voor de fallback (kan niet de hook gebruiken in een
inline `<Suspense fallback={...}>`):
```tsx
function FallbackLoading() {
  const t = useTranslations('...')
  return <div>{t('loading')}</div>
}
<Suspense fallback={<FallbackLoading />}>
```

### Namespace structuur
```
dashboard.
  appointments.{...}
  upload.{detail, wizard}.{...}
  sales.{...}
  projects.
    {kpis, card, members, invite, createCallCenter, billing, empty, callCenterBanner, ...}
    new.{...}              # wizard
    settings.{...}         # project-settings — onboarding, general, members,
                           # hubspot.step1-4, hoursBanner, template, google,
                           # salesConfig, futureIntegrations, recentUploads,
                           # dangerZone, deleteModal, sheetPicker, selfSuffix
    confirmHours.{...}
    report.{actions, view, cost, share}
  settings.
    integrations.{loading, title, subtitle, banners, errors, common, google, lemlist, hubspot, future}
    account.{...}
components.
  tutorial.{...}
```

### Sync-success ICU patterns
Gebruik `t('syncSummary', { count: data.imported })` met pluralisering ipv string
concat — bv. `"✓ {count, plural, =1 {# lead} other {# leads}} gesynced"`.

## Open punten / volgende sessie

1. **Volgende waarschijnlijke target**: `upload/page.tsx` (1330 lijnen) — dat is
   de laatste grote pagina-brok. Daarna nog 4-7 componenten.
2. **Pending van eerdere sessies** (niet i18n):
   - Odoo-integratie (wachten op klant-info — Arne wilde nog niet starten)
   - Teamleader-integratie (tasks #132-138, wachten op dev access)
3. **Bekijken bij volgende start**:
   - `LemlistCampaignPicker`, `CallerRatesEditor`, `TrialBanner` — gebruikt door
     project-settings die nu vertaald is. Mogelijk renderen die nog NL in een
     anderstalige UI.
4. **i18n eindcheck wanneer alles klaar is**:
   - Build runnen (`npm run build` of via Vercel push) — onze patronen met
     `t.rich`, `dangerouslySetInnerHTML`, async server components moeten allemaal
     correct compileren.
   - Visuele check in `?lang=en` of `/en/dashboard/...`.

## Resume-commando

> "Volgende" of "ga verder met i18n" — dan pak ik `upload/page.tsx` op (de
> laatste grote pagina) of de prioritaire componenten (HubSpotListPicker,
> OnboardingChecklist, HelpButton, CoachingBlock).
