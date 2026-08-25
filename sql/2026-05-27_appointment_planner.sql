-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Appointment Planner (lead pool + bookings + caches)
-- Datum:    2026-05-27
-- Reden:    Nieuwe feature voor RestoManager (en later alle klanten):
--           cc/sales managers uploaden een lijst met leads (zaak + adres),
--           cold callers zoeken een lead op en krijgen 3 voorgestelde
--           afspraak-slots terug op basis van de Google Calendars van de
--           sales reps. Sales reps duiden hun werk-provincie aan via
--           all-day events in hun eigen Google Calendar (CallScope leest
--           dat passief; voor losse events parse'n we de locatie via
--           GPT-4o-mini en cachen we het resultaat).
--
-- Tabellen:
--   - lead_pool                 leads geüpload voor afspraak-planning
--   - appointment_bookings      door cold callers geboekte slots
--   - geocode_cache             adres → lat/lng + provincie cache (Google Maps)
--   - ai_event_location_cache   calendar event → provincie cache (GPT)
--
-- Scoping: alles per project, consistent met de bestaande flow.
-- ────────────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────────────
-- 1. lead_pool
--    Een lead is een (zaak-naam, adres)-paar dat opgevolgd moet worden door
--    de cold caller. Geocoding gebeurt asynchroon na upload — status laat
--    zien of het al gelukt is. Pas wanneer status='ok' is de lead bruikbaar
--    in het slot-zoek-scherm (anders kennen we de provincie niet).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_pool (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  business_name   text NOT NULL,
  address         text NOT NULL,                  -- volledige adresregel, zoals upload
  -- Velden hieronder worden gevuld door geocoding ───────────
  postal_code     text,
  city            text,
  province        text,                           -- 'antwerpen', 'limburg', ... (free-form; UI vertaalt)
  country_code    text,                           -- 'BE', 'NL', ...
  latitude        double precision,
  longitude       double precision,
  -- Geocoding state ───────────
  geocode_status  text NOT NULL DEFAULT 'pending' CHECK (geocode_status IN ('pending', 'ok', 'failed')),
  geocode_error   text,
  geocoded_at     timestamptz,
  -- Lead lifecycle ───────────
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'archived')),
  -- Metadata ───────────
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_pool_project       ON public.lead_pool (project_id);
CREATE INDEX IF NOT EXISTS idx_lead_pool_project_name  ON public.lead_pool (project_id, business_name);
CREATE INDEX IF NOT EXISTS idx_lead_pool_status        ON public.lead_pool (project_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_pool_province      ON public.lead_pool (project_id, province) WHERE province IS NOT NULL;

ALTER TABLE public.lead_pool ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.lead_pool');

-- SELECT: alle project members van het project (cold callers, sales reps,
-- sales managers) + cc_manager van het call_center mogen leads zien.
CREATE POLICY "lp_select_member" ON public.lead_pool
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = lead_pool.project_id
        AND pm.profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = lead_pool.project_id
        AND cc.manager_id  = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: cc_manager van het project, óf een sales_manager
-- die op het project staat (zij uploaden ook lead-lijsten volgens spec).
CREATE POLICY "lp_write_manager" ON public.lead_pool
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = lead_pool.project_id
        AND cc.manager_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = lead_pool.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role       = 'sales_manager'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = lead_pool.project_id
        AND cc.manager_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = lead_pool.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role       = 'sales_manager'
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 2. appointment_bookings
--    Een geboekte afspraak vanuit de planner-flow. Apart van
--    appointment_feedback want dit is een PROACTIEF gepland event, niet de
--    retrospectieve uitkomst van een afspraak. We bewaren het Google
--    Calendar event-id zodat we later kunnen updaten/annuleren.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.appointment_bookings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                  uuid NOT NULL REFERENCES public.lead_pool(id) ON DELETE CASCADE,
  project_id               uuid NOT NULL REFERENCES public.projects(id)  ON DELETE CASCADE,   -- redundant; vereenvoudigt RLS
  sales_rep_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cold_caller_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  scheduled_start          timestamptz NOT NULL,
  scheduled_end            timestamptz NOT NULL,
  caller_notes             text,                              -- door cold caller bij het boeken
  google_calendar_event_id text,                              -- voor update/cancel later
  status                   text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'completed')),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ab_project          ON public.appointment_bookings (project_id);
CREATE INDEX IF NOT EXISTS idx_ab_lead             ON public.appointment_bookings (lead_id);
CREATE INDEX IF NOT EXISTS idx_ab_sales_rep_start  ON public.appointment_bookings (sales_rep_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_ab_project_start    ON public.appointment_bookings (project_id, scheduled_start);

ALTER TABLE public.appointment_bookings ENABLE ROW LEVEL SECURITY;
SELECT public._drop_all_policies('public.appointment_bookings');

-- SELECT: alle project members + cc_manager
CREATE POLICY "ab_select_member" ON public.appointment_bookings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = appointment_bookings.project_id
        AND pm.profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = appointment_bookings.project_id
        AND cc.manager_id  = auth.uid()
    )
  );

-- INSERT: cold caller (die zelf member is van het project) of cc_manager / sales_manager
CREATE POLICY "ab_insert_member" ON public.appointment_bookings
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = appointment_bookings.project_id
        AND pm.profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = appointment_bookings.project_id
        AND cc.manager_id  = auth.uid()
    )
  );

-- UPDATE: cc_manager, sales_manager, of de toegewezen sales_rep zelf
CREATE POLICY "ab_update_manager_or_assigned" ON public.appointment_bookings
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = appointment_bookings.project_id
        AND cc.manager_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = appointment_bookings.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role       = 'sales_manager'
    )
    OR appointment_bookings.sales_rep_id   = auth.uid()
    OR appointment_bookings.cold_caller_id = auth.uid()
  );

-- DELETE: cc_manager / sales_manager / de boekende cold caller
CREATE POLICY "ab_delete_manager_or_caller" ON public.appointment_bookings
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_call_centers pcc
      JOIN public.call_centers cc ON cc.id = pcc.call_center_id
      WHERE pcc.project_id = appointment_bookings.project_id
        AND cc.manager_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = appointment_bookings.project_id
        AND pm.profile_id = auth.uid()
        AND pm.role       = 'sales_manager'
    )
    OR appointment_bookings.cold_caller_id = auth.uid()
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 3. geocode_cache
--    Server-side cache voor Google Maps geocoding. Key = genormaliseerd
--    adres (lowercased + trimmed). Per adres één rij. Vermijdt dat we
--    bij re-uploads van dezelfde lijst opnieuw geld uitgeven aan Google.
--
--    Géén RLS — alleen toegankelijk via service_role server-side. We
--    schakelen RLS uit zodat de service-role-client direct kan lezen/
--    schrijven zonder policy-overhead. Bevat publieke adressen (geen PII).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.geocode_cache (
  normalized_address text PRIMARY KEY,
  formatted_address  text,
  postal_code        text,
  city               text,
  province           text,
  country_code       text,
  latitude           double precision,
  longitude          double precision,
  status             text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed')),
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_geocode_cache_created_at ON public.geocode_cache (created_at);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. ai_event_location_cache
--    Cache voor GPT-extracties: gegeven een Google Calendar event titel
--    (+ optioneel locatie-veld), welke BE-provincie hoort daarbij?
--    Key = google calendar event_id (uniek genoeg voor MVP — we resetten
--    cache bij event-update via een hash van de payload).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_event_location_cache (
  event_id        text PRIMARY KEY,                           -- Google Calendar event-id
  event_hash      text NOT NULL,                              -- hash van (title|location|day) — invalidate bij wijziging
  province        text,                                       -- NULL = AI kon niets afleiden
  confidence      double precision,                           -- 0-1
  raw_signal      text,                                       -- welk veld de match opleverde (debug)
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aielc_created_at ON public.ai_event_location_cache (created_at);

NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.appointment_bookings;
-- DROP TABLE IF EXISTS public.lead_pool;
-- DROP TABLE IF EXISTS public.geocode_cache;
-- DROP TABLE IF EXISTS public.ai_event_location_cache;
