-- ────────────────────────────────────────────────────────────────────────────
-- Migratie: Trial + subscription velden voor paywall (Fase 1)
-- Datum:    2026-04-30
-- Reden:    Pricing model = €X/maand per project, met 30-dagen gratis trial
--           per project. We bewaren:
--             - trial_ends_at:           wanneer de gratis periode afloopt
--             - subscription_status:     trialing / active / past_due / cancelled / paused
--             - stripe_subscription_id:  link naar Stripe subscription object
--             - stripe_price_id:         welk Stripe price-record gebruikt is
--           Op profiles: stripe_customer_id zodat we de cc-manager (= klant)
--           kunnen koppelen aan een Stripe Customer record.
--
--           Fase 2 (Stripe webhook) updatet subscription_status, stripe_subscription_id
--           en mogelijk stripe_price_id wanneer er een payment-event binnenkomt.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Stripe customer-id op profiles ─────────────────────────────────────────
-- Een cc_manager (= billing owner) heeft één Stripe Customer record. Daaraan
-- hangen meerdere subscriptions (één per project).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

COMMENT ON COLUMN public.profiles.stripe_customer_id IS
  'Stripe Customer-id van deze cc_manager. NULL tot eerste checkout-flow. Aangemaakt door /api/billing/checkout.';


-- 2. Trial + subscription op projects ───────────────────────────────────────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS trial_ends_at         timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_status   text NOT NULL DEFAULT 'trialing',
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS stripe_price_id        text;

-- CHECK constraint op de subscription_status — Stripe levert deze waarden,
-- plus 'trialing' (interne staat tot eerste subscription bestaat).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname  = 'projects_subscription_status_check'
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_subscription_status_check
      CHECK (subscription_status IN (
        'trialing',     -- Initial state: trial loopt
        'active',       -- Stripe subscription is actief en betaald
        'past_due',     -- Betaling mislukt, Stripe probeert opnieuw
        'cancelled',    -- Gebruiker heeft opgezegd, project is read-only
        'paused'        -- Op pauze gezet (admin / billing-issue)
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.projects.trial_ends_at IS
  'Wanneer de 30-dagen gratis trial van dit project verloopt. Na die datum: paywall actief tot subscription_status = active.';
COMMENT ON COLUMN public.projects.subscription_status IS
  'Huidige status: trialing / active / past_due / cancelled / paused. Wordt door Stripe webhook bijgewerkt.';
COMMENT ON COLUMN public.projects.stripe_subscription_id IS
  'Stripe Subscription-id voor dit project. NULL zolang in trial of nooit geactiveerd.';
COMMENT ON COLUMN public.projects.stripe_price_id IS
  'Welk Stripe Price record gebruikt wordt voor dit project (bv. prijs €49/maand).';


-- 3. Backfill voor bestaande projecten ──────────────────────────────────────
-- Bestaande projecten waren tot nu toe gratis. We geven ze een 30-dagen trial
-- VANAF DE DATUM VAN DEZE MIGRATIE (niet vanaf created_at — anders zou een
-- project van 6 maanden oud meteen verlopen zijn). Zo krijgt iedereen eerlijk
-- de tijd om de paywall te leren kennen + te kiezen.
UPDATE public.projects
SET
  trial_ends_at       = now() + interval '30 days',
  subscription_status = 'trialing'
WHERE trial_ends_at IS NULL;


-- 4. Default voor nieuwe projecten ──────────────────────────────────────────
-- Trigger zorgt dat elk nieuw project automatisch een trial krijgt vanaf
-- creation date. We doen dit via een BEFORE INSERT trigger zodat de
-- create_project RPC niets extra hoeft te weten.
CREATE OR REPLACE FUNCTION public._set_project_trial_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.trial_ends_at IS NULL THEN
    NEW.trial_ends_at := now() + interval '30 days';
  END IF;
  IF NEW.subscription_status IS NULL THEN
    NEW.subscription_status := 'trialing';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS set_project_trial_defaults ON public.projects;
CREATE TRIGGER set_project_trial_defaults
  BEFORE INSERT ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public._set_project_trial_defaults();


NOTIFY pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ────────────────────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS set_project_trial_defaults ON public.projects;
-- DROP FUNCTION IF EXISTS public._set_project_trial_defaults();
-- ALTER TABLE public.projects
--   DROP CONSTRAINT IF EXISTS projects_subscription_status_check,
--   DROP COLUMN     IF EXISTS stripe_price_id,
--   DROP COLUMN     IF EXISTS stripe_subscription_id,
--   DROP COLUMN     IF EXISTS subscription_status,
--   DROP COLUMN     IF EXISTS trial_ends_at;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS stripe_customer_id;
