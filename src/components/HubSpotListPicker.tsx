'use client'

import { useEffect, useState } from 'react'

type HubSpotList = {
  list_id:     string
  name:        string
  size:        number | null
  list_type:   string | null
  processing:  string | null
}

type Status = {
  connected:    boolean
  account_name?: string | null
  user_email?:   string | null
  connected_at?: string | null
}

type Props = {
  /** project_id voor de save-action + per-project token resolution */
  projectId: string
  /** Initiële waarde — uit projects.hubspot_calls_list_id */
  initialListId:   string | null
  initialListName: string | null
  /** Callback na succesvolle save (parent kan z'n state refreshen) */
  onSaved?: (listId: string | null, listName: string | null) => void
}

/**
 * Per-project HubSpot calls-sync configuratie.
 *
 * Toont:
 *   - Verbindings-status (welk HubSpot-portaal hangt aan dit project)
 *   - Verbind / Ontkoppel knop
 *   - List-picker (alleen als verbonden) met alle contact-lists uit de
 *     gekoppelde HubSpot
 *
 * Verschilt van de oude (user-level) variant: elk project heeft hier z'n
 * eigen OAuth-koppeling. Verschillende klanten = verschillende HubSpots.
 */
export default function HubSpotListPicker({
  projectId,
  initialListId,
  initialListName,
  onSaved,
}: Props) {
  const [status, setStatus]     = useState<Status | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)

  const [lists, setLists]       = useState<HubSpotList[]>([])
  const [listsLoading, setListsLoading] = useState(false)
  const [needUpgrade, setNeedUpgrade]   = useState<string | null>(null)

  const [selected, setSelected] = useState<string | null>(initialListId)
  const [saving, setSaving]     = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function loadStatus() {
    setStatusLoading(true)
    try {
      const res = await fetch(`/api/integrations/hubspot-project/status?project_id=${projectId}`)
      if (!res.ok) {
        setStatus({ connected: false })
        return
      }
      const data: Status = await res.json()
      setStatus(data)
      if (data.connected) {
        loadLists()
      }
    } catch {
      setStatus({ connected: false })
    } finally {
      setStatusLoading(false)
    }
  }

  async function loadLists() {
    setListsLoading(true)
    setError(null)
    setNeedUpgrade(null)
    try {
      const res = await fetch(`/api/integrations/hubspot-cc/lists?project_id=${projectId}`)
      if (res.status === 400 || res.status === 500) {
        const data = await res.json().catch(() => ({}))
        const msg = String(data?.error ?? '')
        if (msg.toLowerCase().includes('lists') &&
            (msg.includes('upgrade') || msg.includes('Sales Starter'))) {
          setNeedUpgrade(msg)
        } else {
          setError(msg || 'Kon HubSpot-lists niet laden')
        }
        return
      }
      const data = await res.json()
      setLists(data.lists ?? [])
    } catch {
      setError('Netwerkfout — probeer opnieuw')
    } finally {
      setListsLoading(false)
    }
  }

  async function save() {
    setSaving(true)
    setSavedMsg(null)
    setError(null)
    try {
      const chosen = selected
        ? lists.find(l => l.list_id === selected) ?? null
        : null
      const res = await fetch(`/api/projects/${projectId}/hubspot-calls`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          list_id:   chosen?.list_id   ?? null,
          list_name: chosen?.name      ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Opslaan mislukt')
        return
      }
      setSavedMsg(chosen ? 'List gekoppeld' : 'List ontkoppeld')
      onSaved?.(chosen?.list_id ?? null, chosen?.name ?? null)
    } catch {
      setError('Netwerkfout — probeer opnieuw')
    } finally {
      setSaving(false)
    }
  }

  async function disconnect() {
    if (!confirm('HubSpot-koppeling voor dit project verwijderen? De gekoppelde list wordt ook ontkoppeld.')) {
      return
    }
    setDisconnecting(true)
    setError(null)
    try {
      const res = await fetch('/api/integrations/hubspot-project/disconnect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ project_id: projectId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data?.error ?? 'Ontkoppelen mislukt')
        return
      }
      // Status + lists resetten
      setStatus({ connected: false })
      setLists([])
      setSelected(null)
      onSaved?.(null, null)
    } catch {
      setError('Netwerkfout — probeer opnieuw')
    } finally {
      setDisconnecting(false)
    }
  }

  function connect() {
    // Server-side redirect — laat de browser de OAuth-flow doorlopen.
    window.location.href = `/api/integrations/hubspot-project/start?project_id=${projectId}`
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (statusLoading) {
    return <div className="text-xs text-gray-400">HubSpot-status laden…</div>
  }

  // Niet verbonden — toon connect-knop
  if (!status?.connected) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
          <strong className="font-medium block mb-1">HubSpot nog niet gekoppeld voor dit project</strong>
          <p className="text-gray-600 text-xs leading-relaxed">
            Verbind het HubSpot-portaal van deze klant. Elk project kan een ander HubSpot-account
            gebruiken — handig als je voor meerdere klanten cold-callt.
          </p>
        </div>
        <button
          onClick={connect}
          className="btn-primary text-sm"
        >
          Verbind HubSpot voor dit project
        </button>
      </div>
    )
  }

  // Verbonden — toon account-info + ontkoppel + list-picker
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap rounded-lg border border-green-100 bg-green-50/60 p-3 text-sm">
        <div>
          <div className="font-medium text-green-900">
            HubSpot verbonden
            {status.account_name && (
              <span className="text-green-700"> — {status.account_name}</span>
            )}
          </div>
          {status.user_email && (
            <div className="text-xs text-green-700 mt-0.5">
              Geautoriseerd door {status.user_email}
            </div>
          )}
        </div>
        <button
          onClick={disconnect}
          disabled={disconnecting}
          className="text-xs text-red-700 hover:text-red-800 underline disabled:opacity-50"
        >
          {disconnecting ? 'Ontkoppelen…' : 'Ontkoppel'}
        </button>
      </div>

      {needUpgrade ? (
        <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800">
          <strong className="font-medium block mb-1">HubSpot upgrade nodig</strong>
          <p className="text-blue-700 leading-relaxed">{needUpgrade}</p>
          <p className="text-xs text-blue-600 mt-2">
            Tip: contact-lists zijn beschikbaar vanaf <strong>HubSpot Sales Starter</strong> (€15/u/m).
            Op het Free-plan kan je deze koppeling niet gebruiken — maar dealstage-sync werkt wél op Free.
          </p>
        </div>
      ) : listsLoading ? (
        <div className="text-xs text-gray-400">HubSpot-lists laden…</div>
      ) : (
        <>
          {initialListName && initialListId !== selected && (
            <div className="text-xs text-gray-500">
              Huidige list: <span className="font-medium text-gray-700">{initialListName}</span>
            </div>
          )}

          <div className="flex gap-2 items-center flex-wrap">
            <select
              value={selected ?? ''}
              onChange={e => setSelected(e.target.value || null)}
              className="form-select text-sm flex-1 min-w-[200px]"
              disabled={saving}
            >
              <option value="">— Geen list gekoppeld —</option>
              {lists.map(l => (
                <option key={l.list_id} value={l.list_id}>
                  {l.name}{l.size != null ? ` (${l.size} contacten)` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={save}
              disabled={saving || selected === initialListId}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {saving ? 'Opslaan…' : 'Opslaan'}
            </button>
          </div>

          {lists.length === 0 && !listsLoading && (
            <div className="text-xs text-gray-400">
              Geen contact-lists gevonden in HubSpot. Maak eerst een list aan in HubSpot zodat je
              die hier kan kiezen.
            </div>
          )}
        </>
      )}

      {error && (
        <div className="text-xs text-red-600">{error}</div>
      )}
      {savedMsg && (
        <div className="text-xs text-green-700">{savedMsg}</div>
      )}
    </div>
  )
}
