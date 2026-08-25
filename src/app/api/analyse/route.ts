import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createClient as createSbClient } from '@/lib/supabase/server'
import OpenAI from 'openai'
import type { CustomFieldDef, CustomFieldsBag, CustomInsight } from '@/types/database'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Service role client — omzeilt RLS voor server-side operaties
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export async function POST(req: NextRequest) {
  try {
    // ── AUTH ─────────────────────────────────────────────────────────────
    // Twee paden:
    //  - Server-to-server (vanuit google-sync route en eventueel cron): bearer
    //    Authorization-header met CRON_SECRET. Bypass user-auth.
    //  - Frontend call (vanuit upload-pagina): ingelogde user moet project-
    //    toegang hebben tot de upload (caller, project_member, of cc_manager).
    //
    // Zonder deze check kon iedereen op het internet POSTen met een (gegokt)
    // uploadId en OpenAI tokens verbranden. Sinds 2026-05-04 dichtgetimmerd.
    const cronSecret = process.env.CRON_SECRET
    const authHeader = req.headers.get('authorization') ?? ''
    const isInternal = !!cronSecret && authHeader === `Bearer ${cronSecret}`

    const { uploadId } = await req.json()
    if (!uploadId) return NextResponse.json({ error: 'uploadId ontbreekt' }, { status: 400 })

    // ── Project-permissie check voor frontend calls ─────────────────────
    if (!isInternal) {
      const userClient = createSbClient()
      const { data: { user } } = await userClient.auth.getUser()
      if (!user) {
        return NextResponse.json({ error: 'Niet ingelogd' }, { status: 401 })
      }

      // Pak het project van de upload — enkel users die er toegang toe
      // hebben mogen analyse triggeren.
      const { data: uploadRow } = await supabase
        .from('uploads')
        .select('project_id, caller_id')
        .eq('id', uploadId)
        .single()

      if (!uploadRow) {
        return NextResponse.json({ error: 'Upload niet gevonden' }, { status: 404 })
      }

      type UploadLite = { project_id: string; caller_id: string }
      const u = uploadRow as UploadLite

      // Toegang als: zelf de caller, of project_member, of cc_manager
      let hasAccess = u.caller_id === user.id

      if (!hasAccess) {
        const { data: pm } = await supabase
          .from('project_members')
          .select('id')
          .eq('project_id', u.project_id)
          .eq('profile_id', user.id)
          .maybeSingle()
        hasAccess = !!pm
      }
      if (!hasAccess) {
        const { data: cc } = await supabase
          .from('project_call_centers')
          .select('call_centers!inner(manager_id)')
          .eq('project_id', u.project_id)
          .maybeSingle()
        type CCRow = { call_centers: { manager_id: string } | { manager_id: string }[] | null }
        const row = cc as CCRow | null
        const ccObj = Array.isArray(row?.call_centers) ? row?.call_centers[0] : row?.call_centers
        hasAccess = ccObj?.manager_id === user.id
      }
      if (!hasAccess) {
        return NextResponse.json({ error: 'Geen toegang tot deze upload' }, { status: 403 })
      }
    }

    // Haal alle call records op voor deze upload
    const { data: records, error: recordsError } = await supabase
      .from('call_records')
      .select('*')
      .eq('upload_id', uploadId)

    if (recordsError || !records) {
      console.error('Records ophalen mislukt:', recordsError)
      return NextResponse.json({ error: 'Records niet gevonden' }, { status: 404 })
    }

    console.log(`Analyse gestart voor upload ${uploadId}: ${records.length} records`)

    // ── PROJECT + CUSTOM FIELDS ─────────────────────────────────
    // Haal project-id van de upload op, daarna custom_field_definitions
    const { data: upload } = await supabase
      .from('uploads')
      .select('project_id')
      .eq('id', uploadId)
      .single()

    let customDefs: CustomFieldDef[] = []
    if (upload?.project_id) {
      const { data: proj } = await supabase
        .from('projects')
        .select('custom_field_definitions')
        .eq('id', upload.project_id)
        .single()
      customDefs = (proj as { custom_field_definitions?: CustomFieldDef[] } | null)?.custom_field_definitions ?? []
    }

    // ── HARDE CIJFERS ────────────────────────────────────────────

    const total = records.length
    const normalize = (s: string | null) => (s ?? '').toLowerCase().trim()

    const reached = records.filter(r => {
      const s = normalize(r.status)
      return !['niet bereikt', 'no answer', 'voicemail', 'vm', 'geen gehoor', 'nv'].some(k => s.includes(k))
    }).length

    const appointments = records.filter(r => {
      const s = normalize(r.status)
      return ['afspraak', 'appointment', 'meeting', 'demo', 'gepland'].some(k => s.includes(k))
    }).length

    const callbacks = records.filter(r => {
      const s = normalize(r.status)
      return ['callback', 'terugbellen', 'call back', 'cb'].some(k => s.includes(k))
    }).length

    const voicemails = records.filter(r => {
      const s = normalize(r.status)
      return ['vm', 'voicemail', 'voice mail'].some(k => s.includes(k))
    }).length

    // ── CUSTOM-FIELD SAMENVATTING VOOR DE PROMPT ─────────────────
    // We sturen niet alle 30+ rijen aan GPT, maar een aggregatie + 5 voorbeelden.
    // Per veld: top categorieën, of som/avg voor numbers, of range voor dates.
    let customSummary = ''
    if (customDefs.length > 0) {
      const lines: string[] = []
      for (const def of customDefs) {
        const values = records
          .map(r => (r as { custom_fields?: CustomFieldsBag }).custom_fields?.[def.key])
          .filter((v): v is NonNullable<typeof v> => v !== null && v !== undefined && v !== '')

        if (values.length === 0) continue

        if (def.type === 'number') {
          const nums = values.map(Number).filter(n => Number.isFinite(n))
          if (nums.length === 0) continue
          const sum = nums.reduce((s, n) => s + n, 0)
          const avg = sum / nums.length
          const min = Math.min(...nums)
          const max = Math.max(...nums)
          lines.push(`- ${def.label} (number): som=${sum.toFixed(2)}, gem=${avg.toFixed(2)}, min=${min}, max=${max}, n=${nums.length}`)
        } else if (def.type === 'date') {
          const dates = values.map(v => new Date(String(v))).filter(d => !Number.isNaN(d.getTime()))
          if (dates.length === 0) continue
          const earliest = new Date(Math.min(...dates.map(d => d.getTime())))
          const latest = new Date(Math.max(...dates.map(d => d.getTime())))
          lines.push(`- ${def.label} (date): van ${earliest.toISOString().slice(0, 10)} tot ${latest.toISOString().slice(0, 10)}, n=${dates.length}`)
        } else {
          // text / category — top 5 voorkomens
          const counts = new Map<string, number>()
          for (const v of values) {
            const k = String(v)
            counts.set(k, (counts.get(k) ?? 0) + 1)
          }
          const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
          const inline = top.map(([k, n]) => `${k}=${n}`).join(', ')
          lines.push(`- ${def.label} (${def.type}): ${inline} (n=${values.length})`)
        }
      }
      if (lines.length > 0) {
        // Plus paar voorbeelden van rijen mét status
        const examples = records
          .filter(r => {
            const cf = (r as { custom_fields?: CustomFieldsBag }).custom_fields
            return cf && Object.keys(cf).length > 0 && r.status
          })
          .slice(0, 8)
          .map(r => {
            const cf = (r as { custom_fields?: CustomFieldsBag }).custom_fields ?? {}
            const cfStr = Object.entries(cf).map(([k, v]) => `${k}=${v}`).join(', ')
            return `  - status="${r.status}", ${cfStr}`
          })
          .join('\n')

        customSummary = `

EXTRA VELDEN (per project geconfigureerd):
${lines.join('\n')}

VOORBEELD-RIJEN (eerste 8 met data):
${examples}
`
      }
    }

    // ── AI ANALYSE ───────────────────────────────────────────────

    // Notities worden GENUMMERD aan GPT gegeven zodat we per-call kunnen
    // afdwingen dat er max één bezwaar wordt geclassificeerd. We sturen ook
    // de status mee — soms zit het bezwaar niet in de notitie maar EXACT in
    // de status (bv. status="Gaat op pensioen" zonder body). Max 200 calls om
    // binnen token-budget te blijven.
    //
    // Filter-logica: een call wordt meegegeven als er ofwel een notitie van
    // betekenis is (>5 chars), OFWEL een status die NIET tot de "generieke
    // techniek-dispositions" hoort. Status-only calls met "No answer" /
    // "Busy" / "Connected" / "Voicemail" leveren geen bezwaar-info — die
    // skippen we om token-budget te sparen. Alle andere statussen (incl.
    // custom dispositions zoals "Gaat op pensioen", "Verkeerd nummer", …)
    // mogen mee. GPT krijgt te zien dat er geen body is en kan dan kiezen
    // tussen status-als-bezwaar of "geen".
    // Generieke statussen op zichzelf zeggen niets over bezwaren. MAAR als
    // dezelfde call óók extra context heeft (b.v. Lemlist company_type +
    // concurrent_name), is die call wél interessant om te classificeren —
    // "call met Zenchef-klant, connected" is een sterk signaal.
    const GENERIC_STATUSES = new Set([
      'connected', 'bereikt', 'opgebeld',
      'no answer', 'no-answer', 'niet bereikt',
      'busy', 'bezet',
      'voicemail', 'left voicemail',
      '', '—',
    ])

    /**
     * Bouwt de rijkste context-string beschikbaar voor één call. Combineert
     * notitie + Lemlist-custom_fields (concurrent, type, campaign, callStatus,
     * duration). Retourneert een string die aan GPT wordt gegeven, plus een
     * boolean `hasSignal` — is er meer dan de generieke status alleen?
     */
    function buildCallContext(r: {
      notes:         string | null
      status:        string | null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      custom_fields: any
      duration_seconds: number | null
    }): { line: string; hasSignal: boolean } {
      const cf = (r.custom_fields ?? {}) as Record<string, unknown>
      const status  = (r.status ?? '').trim()
      const notes   = (r.notes ?? '').trim().slice(0, 400)
      const conc    = String(cf.concurrent_name ?? '').trim()
      const cType   = String(cf.company_type   ?? '').trim()
      const camp    = String(cf.lemlist_campaign_name ?? '').trim()
      const callSt  = String(cf.lemlist_call_status   ?? '').trim()
      const dur     = typeof r.duration_seconds === 'number' ? r.duration_seconds : null

      // Compact key=value formaat zodat GPT structuur ziet zonder veel tokens
      const parts: string[] = []
      parts.push(`status="${status || '—'}"`)
      if (callSt)         parts.push(`callStatus="${callSt}"`)
      if (dur !== null)   parts.push(`duration=${dur}s`)
      if (conc)           parts.push(`concurrent="${conc}"`)
      if (cType)          parts.push(`type="${cType}"`)
      if (camp)           parts.push(`campaign="${camp}"`)

      const noteSegment = notes || '(geen notitie)'
      const line = `[${parts.join(' ')}] ${noteSegment}`

      // Signaal-check: notitie ≥5 chars, of niet-generieke status, of concrete
      // Lemlist context (concurrent-naam / callStatus buiten "connected"/"no-answer")
      const hasMeaningfulNotes = notes.length > 5
      const isGenericStatus    = GENERIC_STATUSES.has(status.toLowerCase())
      const hasSpecificStatus  = status.length > 0 && !isGenericStatus
      const hasConcurrent      = conc.length > 0
      const hasInterestingCall = callSt.length > 0 && !['connected', 'no-answer'].includes(callSt.toLowerCase())
      const hasSignal = hasMeaningfulNotes || hasSpecificStatus || hasConcurrent || hasInterestingCall

      return { line, hasSignal }
    }

    const notedRecords = records
      .map(r => ({
        r,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx: buildCallContext(r as any),
      }))
      .filter(x => x.ctx.hasSignal)
      .slice(0, 200)
    const notesNumbered = notedRecords
      .map((x, i) => `${i + 1}. ${x.ctx.line}`)
      .join('\n')

    let objections: { label: string; count: number }[] = []
    let rapportText = ''
    let customInsights: CustomInsight[] = []

    const hasNotes = notesNumbered.length > 0
    const hasCustomData = customSummary.length > 0

    if (hasNotes || hasCustomData) {
      const customInsightsClause = customDefs.length > 0
        ? `,
  "custom_insights": [
    { "field_keys": ["sleutel1"], "headline": "korte titel", "detail": "1-3 zinnen met cijfers" }
  ]`
        : ''

      const customInsightsRules = customDefs.length > 0
        ? `
- 2 tot 4 inzichten over de extra velden ("custom_insights"). Zoek correlaties:
  - Conversie per categorie ("Bron 'Google Ads' converteert 2x beter dan 'LinkedIn'")
  - Range-verschillen voor numbers ("Leads met offertewaarde > €100k hebben 50% conversie tegen 20% bij <€50k")
  - Tijdspatronen voor dates ("Events in week 18 zijn oververtegenwoordigd")
- Veld-keys die je mag gebruiken: ${customDefs.map(d => `"${d.key}"`).join(', ')}
- Wees concreet met cijfers — geen vage beweringen
- Als er te weinig variatie is in een veld om iets zinvols te zeggen: skip dat veld liever`
        : ''

      const prompt = `
Je bent een expert in cold calling en sales analytics. Analyseer de volgende belnotities${hasCustomData ? ' en extra projectdata' : ''}.

GENUMMERDE BELNOTITIES (één per call):
${notesNumbered || '(geen notities beschikbaar)'}

STATISTIEKEN:
- Totaal gebeld: ${total}
- Bereikt: ${reached}
- Afspraken: ${appointments}
- Callbacks: ${callbacks}
- Voicemails: ${voicemails}
${customSummary}

TAAK 1 — BEZWAREN per call:
Voor ELKE genummerde call hierboven (1 tot ${notedRecords.length}), kies MAXIMAAL ÉÉN primair bezwaar.
Géén dubbele classificatie per call. Eén call → één label OF "geen".

CONTEXT-INTERPRETATIE (elk item tussen [ ] is metadata over de call):
- status="..." — het CallScope status-veld (bereikt/niet bereikt/…)
- callStatus="..." — Lemlist VoIP dispositie (connected, no-answer, gatekeeper, voicemail, connected-positive, connected-negative, …)
- duration=Xs — hoe lang de call duurde. <30s = meestal gatekeeper of voicemail. >120s = echt gesprek.
- concurrent="..." — welke concurrent-tool de klant al gebruikt (Zenchef, Easybooker, Wix, …). DIT IS EEN STERK BEZWAAR-SIGNAAL: als er een concurrent-naam staat én callStatus is negatief, is het bezwaar "Tevreden met {concurrent}".
- type="..." — bedrijfstype (Restaurant, Brasserie, …). Meestal irrelevant voor bezwaar-classificatie.
- campaign="..." — welke Lemlist-campaign. Geeft context (bv "Recyclage" = eerder benaderd).

BEZWAAR-CATEGORIEËN (gebruik deze consistente labels, kies één per call):

Reeds tevreden bij concurrent:
- "Tevreden met Zenchef" / "Tevreden met Easybooker" / "Tevreden met Wix" — als concurrent="X" én callStatus of notitie negatief
- "Contract loopt nog" — expliciet vermeld dat contract elders nog loopt

Prijs / budget:
- "Prijs" — te duur, budget, prijzenslag, kostenbesparing

Vertrouwen / onbekendheid:
- "Onbekend merk" — RestoManager niet bekend, wantrouwt overstap
- "Slecht moment" — timing niet goed, terugbellen later

Complexiteit:
- "Te ingewikkeld" — overschakelen te veel werk, angst voor data-verlies
- "Missende feature" — specifiek gemis in het product

Situationeel:
- "Gaat op pensioen" / "Failliet" / "Verkocht" / "Verhuisd" / "Overleden"
- "Op vakantie" / "Terugbellen" — beslisser tijdelijk afwezig
- "Beslisser afwezig" — gatekeeper hield tegen (callStatus="gatekeeper" of note vermeldt boekhouder/personeel)

Contact-issues:
- "Verkeerd nummer" — status of note zegt zo
- "Voicemail" — callStatus="voicemail" en geen inhoudelijk gesprek
- "Gatekeeper" — callStatus="gatekeeper" of note zegt "boekhouder blokkeerde"

Vaag / geen inhoud:
- "Geen interesse" — expliciet geen interesse ZONDER specifieke reden

Overige:
- "geen" — call was succesvol (afspraak, positieve interactie) of technisch niet-bezwaar (voicemail zonder inhoud, no-answer korter dan 10s)

REGELS:
- Voorkeur voor SPECIFIEKE labels — "Tevreden met Zenchef" is altijd beter dan "Tevreden met concurrent".
- Als concurrent="Zenchef" en callStatus in (no-answer, gatekeeper, voicemail): gebruik toch "Tevreden met Zenchef" want dat is het waarschijnlijkste bezwaar.
- callStatus="connected-positive" of "connected_positive" met korte duration → "geen" (afspraak gemaakt).
- duration<30s + callStatus="no-answer" → meestal "geen" (technisch, geen echt bezwaar).

TAAK 2 — Klant-rapport (rapport veld):
3-4 zinnen samenvatting in het Nederlands voor de eindklant.

Geef je antwoord UITSLUITEND als geldig JSON in dit exacte formaat, zonder markdown of uitleg:
{
  "per_call": [
    { "idx": 1, "objection": "label OF geen" },
    { "idx": 2, "objection": "label OF geen" }
  ],
  "rapport": "3-4 zinnen samenvatting voor de klant in het Nederlands."${customInsightsClause}
}

Regels:
- "per_call" moet EXACT ${notedRecords.length} entries bevatten, één per genummerde call
- "objection" is OFWEL een kort label OFWEL letterlijk "geen"
- Labels moeten consistent zijn — schrijf "Prijs" niet als "prijs" of "te duur"${customInsightsRules}
- Geef ALLEEN JSON terug
`
      try {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 4000,
        })

        const raw = response.choices[0]?.message?.content ?? '{}'
        const clean = raw.replace(/```json|```/g, '').trim()
        const parsed = JSON.parse(clean)

        // ── Aggregeer bezwaren per call ──────────────────────────────────
        // Garantie via prompt-structuur: max 1 bezwaar per call. Wij maken
        // hier zelf de counts (labels → aantal calls).
        const perCall: Array<{ idx?: number; objection?: string }> = Array.isArray(parsed.per_call)
          ? parsed.per_call
          : []
        const counts = new Map<string, number>()
        for (const entry of perCall) {
          const raw = (entry.objection ?? '').trim()
          if (!raw) continue
          // "geen" = geen bezwaar — niet meetellen
          if (raw.toLowerCase() === 'geen') continue
          // Normaliseer: trim + eerste letter hoofdletter voor consistente weergave
          const label = normalizeObjectionLabel(raw)
          counts.set(label, (counts.get(label) ?? 0) + 1)
        }
        objections = Array.from(counts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([label, count]) => ({ label, count }))

        rapportText = parsed.rapport ?? ''
        // custom_insights validatie: alleen rijen met geldige field_keys
        const knownKeys = new Set(customDefs.map(d => d.key))
        customInsights = Array.isArray(parsed.custom_insights)
          ? parsed.custom_insights
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .filter((ci: any) =>
                ci && typeof ci.headline === 'string' && typeof ci.detail === 'string'
              )
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((ci: any) => ({
                field_keys: Array.isArray(ci.field_keys)
                  ? ci.field_keys.filter((k: unknown) => typeof k === 'string' && knownKeys.has(k))
                  : [],
                headline: ci.headline,
                detail: ci.detail,
              }))
          : []
        console.log('AI analyse geslaagd:', {
          per_call:        perCall.length,
          objections:      objections.length,
          rapportLength:   rapportText.length,
          customInsights:  customInsights.length,
        })
      } catch (aiError) {
        console.error('OpenAI fout:', aiError)
        rapportText = `Deze week werden ${total} leads gecontacteerd, waarvan ${reached} effectief bereikt. Dit resulteerde in ${appointments} afspraken en ${callbacks} geplande callbacks.`
      }
    } else {
      rapportText = `Deze week werden ${total} leads gecontacteerd, waarvan ${reached} effectief bereikt (${total > 0 ? Math.round(reached / total * 100) : 0}%). Dit resulteerde in ${appointments} afspraken en ${callbacks} geplande callbacks.`
    }

    // ── OPSLAAN ──────────────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const analysisInsert: any = {
      upload_id: uploadId,
      total_calls: total,
      reached,
      appointments,
      callbacks,
      voicemails,
      objections,
      rapport_text: rapportText,
      custom_insights: customInsights,
    }
    const { error: insertError } = await supabase
      .from('analyses')
      .upsert(analysisInsert, { onConflict: 'upload_id' })

    if (insertError) {
      console.error('Analyse opslaan mislukt:', insertError)
      // Probeer status op error te zetten
      await supabase.from('uploads').update({ status: 'error' }).eq('id', uploadId)
      return NextResponse.json({ error: 'Opslaan mislukt', details: insertError.message }, { status: 500 })
    }

    // Update upload status naar done
    await supabase.from('uploads').update({ status: 'done' }).eq('id', uploadId)

    console.log(`Analyse klaar voor upload ${uploadId}`)
    return NextResponse.json({
      success: true, total, reached, appointments, callbacks,
      customInsights: customInsights.length,
    })

  } catch (err: unknown) {
    console.error('Analyse API fout:', err)
    const message = err instanceof Error ? err.message : 'Onbekende fout'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Normaliseer een bezwaar-label voor consistente aggregatie.
 *
 * - Trim whitespace
 * - Eerste letter hoofdletter
 * - Lowercase variants van bekende labels mappen naar canonieke vorm zodat
 *   "prijs" en "Prijs" als één bucket geteld worden — ook over meerdere
 *   uploads heen. Onbekende labels behouden de GPT-spelling.
 */
function normalizeObjectionLabel(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  const lower = trimmed.toLowerCase()

  // Canonical mapping voor de meest voorkomende labels. Houden we klein —
  // de prompt zelf instrueert GPT al om consistent te zijn.
  const CANONICAL: Record<string, string> = {
    'prijs':              'Prijs',
    'te duur':            'Prijs',
    'concurrent':         'Concurrent',
    'tevreden huidig':    'Tevreden huidig',
    'tevreden':           'Tevreden huidig',
    'geen interesse':     'Geen interesse',
    'niet geïnteresseerd':'Geen interesse',
    'te druk':            'Te druk',
    'geen tijd':          'Te druk',
    'beslisser afwezig':  'Beslisser afwezig',
    'geen budget':        'Geen budget',
    'gaat op pensioen':   'Gaat op pensioen',
    'pensioen':           'Gaat op pensioen',
    'verhuisd':           'Verhuisd',
    'failliet':           'Failliet',
    'overleden':          'Overleden',
  }
  if (CANONICAL[lower]) return CANONICAL[lower]

  // Onbekend label → eerste letter hoofdletter
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}
