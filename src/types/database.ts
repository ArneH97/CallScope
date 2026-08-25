// Database types — spiegelt het Supabase schema

export type Role = 'cc_manager' | 'cold_caller' | 'sales_rep' | 'sales_manager'
export type UploadStatus = 'pending' | 'processing' | 'done' | 'error'
export type AppointmentStatus = 'gepland' | 'no_show' | 'uitgevoerd' | 'geannuleerd'
export type Outcome = 'offerte' | 'deal' | 'verloren' | 'follow_up' | 'geen'

/**
 * Ondersteunde types voor projectspecifieke custom fields.
 */
export type CustomFieldType = 'text' | 'number' | 'date' | 'category'

export type DealstageCategory = 'won' | 'lost' | 'offerte' | 'in_progress' | 'no_show' | 'other'

/**
 * Bron van de leads/calls voor een project.
 *  - manual:        cc-manager of cold caller uploadt CSV/Excel manueel
 *  - google_sheets: dagelijkse sync uit een gekoppelde Google Sheet per caller
 *  - hubspot/aircall/lemlist: voorbereid voor toekomstige connectoren
 */
export type UploadSource = 'manual' | 'google_sheets' | 'hubspot' | 'aircall' | 'lemlist'

/**
 * Bron van de sales-feedback (outcome / appointment_status) voor een project.
 *  - manual:        sales rep vult feedback in op /dashboard/appointments
 *  - google_sheets: dealstage-kolom uit dezelfde sheet wordt door AI geclassificeerd
 *  - hubspot:       voorbereid voor toekomstige HubSpot CRM-koppeling
 */
export type FeedbackSource = 'manual' | 'google_sheets' | 'hubspot'

/**
 * Billing-status van een project. Mirror'd Stripe subscription status
 * plus 'trialing' als initial state voor de 30-dagen gratis periode.
 *  - trialing:  trial loopt nog
 *  - active:    Stripe-subscription is actief en betaald
 *  - past_due:  betaling mislukt, retry-flow loopt
 *  - cancelled: gebruiker heeft opgezegd, project is read-only
 *  - paused:    op pauze (admin/billing-issue)
 */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'paused'

export type CustomFieldDef = {
  key: string
  label: string
  type: CustomFieldType
}

export type CustomFieldValue = string | number | null
export type CustomFieldsBag = Record<string, CustomFieldValue>

export type CustomInsight = {
  field_keys: string[]
  headline: string
  detail: string
}

export type Profile = {
  id: string
  full_name: string
  email: string | null
  role: Role
  is_freelance: boolean
  /** Wanneer de welkomst-tutorial laatst afgerond/geskipt is. NULL = nog tonen. */
  tutorial_completed_at: string | null
  /** Stripe Customer-id van deze gebruiker (alleen relevant voor cc_managers). */
  stripe_customer_id: string | null
  /** Interne gebruiker (CallScope-owner, demo-accounts) — krijgt onbeperkt
   *  projecten + actieve status zonder Stripe-betaling. Beheerd via SQL. */
  is_internal: boolean
  /** Interface-taal: 'nl' | 'en' | 'fr' | 'de' */
  locale: string
  /** ISO 3166-1 alpha-2 land-code (bv. 'BE', 'NL', 'GB') */
  country: string
  /** Datumnotatie: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' */
  date_format: string
  /** ISO 4217 muntcode (bv. 'EUR', 'USD', 'GBP') */
  currency: string
  /** IANA tz (bv. 'Europe/Brussels') */
  timezone: string
  /** Heeft de user de preferences-onboarding doorlopen? NULL = modal nog tonen. */
  preferences_set_at: string | null
  created_at: string
}

export type CallCenter = {
  id: string
  manager_id: string
  name: string
  created_at: string
}

export type Project = {
  id: string
  name: string
  description: string | null
  unique_id_label: string | null
  custom_field_definitions: CustomFieldDef[]
  last_column_mapping: Partial<ColumnMapping>
  default_sales_rep_id: string | null
  /** Hoe leads binnenkomen — manual / google_sheets / etc. */
  upload_source: UploadSource
  /** Hoe sales-feedback binnenkomt — manual / google_sheets / etc. */
  feedback_source: FeedbackSource
  /** Wanneer de 30-dagen gratis trial verloopt. Na die datum: paywall actief. */
  trial_ends_at: string | null
  /** Huidige billing-status (trialing / active / past_due / cancelled / paused). */
  subscription_status: SubscriptionStatus
  /** Stripe Subscription-id voor dit project. NULL zolang in trial of nooit geactiveerd. */
  stripe_subscription_id: string | null
  /** Welk Stripe Price-record gebruikt wordt voor dit project. */
  stripe_price_id: string | null
  /** Lemlist-campaign die als bron dient voor dit project (optioneel). */
  lemlist_campaign_id:   string | null
  lemlist_campaign_name: string | null
  /** HubSpot contact-list waarvan calls dagelijks gesynced worden (optioneel,
   *  cc_manager-side). hubspot_calls_synced_by = welke user-id de OAuth bezit. */
  hubspot_calls_list_id:   string | null
  hubspot_calls_list_name: string | null
  hubspot_calls_synced_by: string | null
  /** Trial-reminder timestamp (door cron gevuld). */
  trial_reminder_sent_at: string | null
  created_at: string
}

export type Upload = {
  id: string
  project_id: string
  caller_id: string
  call_center_id: string
  filename: string
  tool: string
  status: UploadStatus
  uploaded_at: string
}

export type CallRecord = {
  id: string
  upload_id: string
  project_id: string
  external_id: string | null
  lead_name: string | null
  email: string | null
  phone: string | null
  status: string | null
  notes: string | null
  call_date: string | null
  duration_seconds: number | null
  custom_fields: CustomFieldsBag
  dealstage_raw: string | null
  dealstage_category: DealstageCategory | null
  dealstage_synced_at: string | null
  dealstage_classified_at: string | null
  raw_sales_rep_name: string | null
  hubspot_deal_id: string | null
  created_at: string
}

export type AppointmentFeedback = {
  id: string
  call_record_id: string
  sales_rep_id: string
  appointment_status: AppointmentStatus
  outcome: Outcome
  quality_rating: number | null
  notes: string | null
  appointment_date: string | null
  created_at: string
  updated_at: string
}

export type Analysis = {
  id: string
  upload_id: string
  total_calls: number
  reached: number
  appointments: number
  callbacks: number
  voicemails: number
  objections: { label: string; count: number }[]
  rapport_text: string | null
  custom_insights: CustomInsight[]
  created_at: string
}

export type UploadSummary = Upload & {
  caller_name: string
  call_center_name: string
  project_name: string
  total_calls: number
  reached: number
  appointments: number
  callbacks: number
  objections: { label: string; count: number }[]
  rapport_text: string | null
  conversion_pct: number | null
}

export type AppointmentWithFeedback = {
  call_record_id: string
  lead_name: string | null
  call_date: string | null
  caller_notes: string | null
  custom_fields: Record<string, unknown> | null
  dealstage_raw: string | null
  dealstage_category: DealstageCategory | null
  dealstage_synced_at: string | null
  project_id: string
  call_center_id: string
  call_center_name: string
  upload_tool: string | null       // 'google_sheets' | 'lemlist' | 'manual' | ...
  upload_filename: string | null   // "Sheet-naam — 2026-07-30" of "Lemlist sync — ..."
  caller_id: string
  caller_name: string
  appointment_status: AppointmentStatus | null
  outcome: Outcome | null
  quality_rating: number | null
  sales_notes: string | null
  appointment_date: string | null
  sales_rep_id: string | null
  sales_rep_name: string | null
}

export type ColumnMapping = {
  lead_name: string
  email: string
  phone: string
  status: string
  notes: string
  call_date: string
  duration_seconds: string
  external_id: string
  dealstage: string
  sales_rep: string
}

export type CallCenterMember = {
  id: string
  call_center_id: string
  profile_id: string
}

export type ProjectCallCenter = {
  id: string
  project_id: string
  call_center_id: string
}

export type ProjectMember = {
  id: string
  project_id: string
  profile_id: string
  role: 'sales_rep' | 'sales_manager' | 'cold_caller'
}

export type GoogleIntegration = {
  user_id: string
  refresh_token: string
  access_token: string | null
  expires_at: string | null
  google_email: string | null
  connected_at: string
}

export type ProjectGoogleSheet = {
  id: string
  project_id: string
  caller_id: string
  spreadsheet_id: string
  sheet_name: string
  sheet_url: string | null
  last_synced_at: string | null
  last_sync_status: 'ok' | 'error' | 'no_changes' | null
  last_sync_error: string | null
  created_by: string | null
  created_at: string
}

export type ReportShare = {
  id: string
  project_id: string
  token: string
  created_by: string
  sent_to: string | null
  client_name: string | null
  message: string | null
  expires_at: string
  viewed_at: string | null
  view_count: number
  created_at: string
}

/**
 * Per-project HubSpot OAuth-koppeling. Eén rij per project; cc_manager kan
 * voor elk project (= klant) een ander HubSpot-portaal verbinden. Wordt
 * gebruikt voor calls-sync (HubSpot lists + call engagements).
 *
 * NB: parallel aan `hubspot_integrations` (user-level) die nog steeds wordt
 * gebruikt voor sales_manager dealstage-sync.
 */
export type ProjectHubSpotIntegration = {
  project_id:           string
  refresh_token:        string
  access_token:         string | null
  expires_at:           string | null
  hubspot_account_id:   string | null
  hubspot_account_name: string | null
  hubspot_user_email:   string | null
  connected_by:         string | null
  connected_at:         string
}

/**
 * Lead in de appointment-planner pool. Geüpload door cc/sales manager, geocoded
 * via Google Maps zodat we de provincie kennen, en daarna doorzoekbaar door
 * cold callers die er een afspraak-slot voor willen boeken.
 */
export type LeadPool = {
  id:             string
  project_id:     string
  business_name:  string
  address:        string
  postal_code:    string | null
  city:           string | null
  province:       string | null
  /** Sub-regio binnen provincie (bv. 'WVL-NW'). NULL als geen mapping bekend
   *  voor de postcode — slot-finder valt dan terug op province-matching. */
  region:         string | null
  country_code:   string | null
  latitude:       number | null
  longitude:      number | null
  geocode_status: 'pending' | 'ok' | 'failed'
  geocode_error:  string | null
  geocoded_at:    string | null
  status:         'open' | 'booked' | 'archived'
  created_at:     string
  created_by:     string | null
}

/**
 * Door een cold caller geboekt afspraak-slot. Apart van appointment_feedback —
 * dit is een PROACTIEF gepland event (toekomst), niet de retrospectieve
 * outcome van een afspraak (verleden). google_calendar_event_id bewaren we
 * zodat we later kunnen updaten/annuleren via de Calendar API.
 */
export type AppointmentBooking = {
  id:                       string
  lead_id:                  string
  project_id:               string
  sales_rep_id:             string | null
  cold_caller_id:           string | null
  scheduled_start:          string
  scheduled_end:            string
  caller_notes:             string | null
  google_calendar_event_id: string | null
  status:                   'booked' | 'cancelled' | 'completed'
  created_at:               string
}

/**
 * Server-side cache voor Google Maps geocoding (kost per call → niet 2x
 * dezelfde lookup). Key = genormaliseerd adres (lowercased + trimmed).
 */
export type GeocodeCache = {
  normalized_address: string
  formatted_address:  string | null
  postal_code:        string | null
  city:               string | null
  province:           string | null
  country_code:       string | null
  latitude:           number | null
  longitude:          number | null
  status:             'ok' | 'failed'
  error_message:      string | null
  created_at:         string
}

/**
 * Cache voor GPT-extracties van Google Calendar event-titels naar BE-provincie.
 * event_hash invalideert wanneer titel/locatie/dag van een event wijzigen.
 */
export type AiEventLocationCache = {
  event_id:   string
  event_hash: string
  province:   string | null
  confidence: number | null
  raw_signal: string | null
  created_at: string
}

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile
        Insert: Omit<Profile, 'created_at'>
        Update: Partial<Profile>
        Relationships: []
      }
      call_centers: {
        Row: CallCenter
        Insert: Omit<CallCenter, 'id' | 'created_at'>
        Update: Partial<CallCenter>
        Relationships: []
      }
      call_center_members: {
        Row: CallCenterMember
        Insert: Omit<CallCenterMember, 'id'>
        Update: Partial<CallCenterMember>
        Relationships: []
      }
      projects: {
        Row: Project
        Insert: {
          name: string
          description?: string | null
          unique_id_label?: string | null
          custom_field_definitions?: CustomFieldDef[]
          last_column_mapping?: Partial<ColumnMapping>
          upload_source?: UploadSource
          feedback_source?: FeedbackSource
          default_sales_rep_id?: string | null
        }
        Update: Partial<Project>
        Relationships: []
      }
      project_call_centers: {
        Row: ProjectCallCenter
        Insert: Omit<ProjectCallCenter, 'id'>
        Update: Partial<ProjectCallCenter>
        Relationships: []
      }
      project_members: {
        Row: ProjectMember
        Insert: Omit<ProjectMember, 'id'>
        Update: Partial<ProjectMember>
        Relationships: []
      }
      uploads: {
        Row: Upload
        Insert: Omit<Upload, 'id' | 'uploaded_at'>
        Update: Partial<Upload>
        Relationships: []
      }
      call_records: {
        Row: CallRecord
        Insert: Omit<CallRecord, 'id' | 'created_at' | 'dealstage_raw' | 'dealstage_category' | 'dealstage_synced_at' | 'dealstage_classified_at' | 'raw_sales_rep_name'> & {
          dealstage_raw?: string | null
          dealstage_category?: DealstageCategory | null
          dealstage_synced_at?: string | null
          dealstage_classified_at?: string | null
          raw_sales_rep_name?: string | null
        }
        Update: Partial<CallRecord>
        Relationships: []
      }
      appointment_feedback: {
        Row: AppointmentFeedback
        Insert: Omit<AppointmentFeedback, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<AppointmentFeedback>
        Relationships: []
      }
      analyses: {
        Row: Analysis
        Insert: Omit<Analysis, 'id' | 'created_at'>
        Update: Partial<Analysis>
        Relationships: []
      }
      report_shares: {
        Row: ReportShare
        Insert: {
          project_id: string
          token: string
          created_by: string
          sent_to?: string | null
          client_name?: string | null
          message?: string | null
          expires_at?: string
        }
        Update: Partial<ReportShare>
        Relationships: []
      }
      google_integrations: {
        Row: GoogleIntegration
        Insert: {
          user_id: string
          refresh_token: string
          access_token?: string | null
          expires_at?: string | null
          google_email?: string | null
          connected_at?: string
        }
        Update: Partial<GoogleIntegration>
        Relationships: []
      }
      project_google_sheets: {
        Row: ProjectGoogleSheet
        Insert: {
          project_id: string
          caller_id: string
          spreadsheet_id: string
          sheet_name: string
          sheet_url?: string | null
          created_by?: string | null
        }
        Update: Partial<ProjectGoogleSheet>
        Relationships: []
      }
      project_hubspot_integrations: {
        Row: ProjectHubSpotIntegration
        Insert: {
          project_id:            string
          refresh_token:         string
          access_token?:         string | null
          expires_at?:           string | null
          hubspot_account_id?:   string | null
          hubspot_account_name?: string | null
          hubspot_user_email?:   string | null
          connected_by?:         string | null
          connected_at?:         string
        }
        Update: Partial<ProjectHubSpotIntegration>
        Relationships: []
      }
      lead_pool: {
        Row: LeadPool
        Insert: {
          id?:             string
          project_id:      string
          business_name:   string
          address:         string
          postal_code?:    string | null
          city?:           string | null
          province?:       string | null
          region?:         string | null
          country_code?:   string | null
          latitude?:       number | null
          longitude?:      number | null
          geocode_status?: LeadPool['geocode_status']
          geocode_error?:  string | null
          geocoded_at?:    string | null
          status?:         LeadPool['status']
          created_at?:     string
          created_by?:     string | null
        }
        Update: Partial<LeadPool>
        Relationships: []
      }
      appointment_bookings: {
        Row: AppointmentBooking
        Insert: {
          id?:                       string
          lead_id:                   string
          project_id:                string
          sales_rep_id?:             string | null
          cold_caller_id?:           string | null
          scheduled_start:           string
          scheduled_end:             string
          caller_notes?:             string | null
          google_calendar_event_id?: string | null
          status?:                   AppointmentBooking['status']
          created_at?:               string
        }
        Update: Partial<AppointmentBooking>
        Relationships: []
      }
      geocode_cache: {
        Row: GeocodeCache
        Insert: {
          normalized_address: string
          formatted_address?: string | null
          postal_code?:       string | null
          city?:              string | null
          province?:          string | null
          country_code?:      string | null
          latitude?:          number | null
          longitude?:         number | null
          status?:            GeocodeCache['status']
          error_message?:     string | null
          created_at?:        string
        }
        Update: Partial<GeocodeCache>
        Relationships: []
      }
      ai_event_location_cache: {
        Row: AiEventLocationCache
        Insert: {
          event_id:    string
          event_hash:  string
          province?:   string | null
          confidence?: number | null
          raw_signal?: string | null
          created_at?: string
        }
        Update: Partial<AiEventLocationCache>
        Relationships: []
      }
    }
    Views: {
      upload_summary: { Row: UploadSummary; Relationships: [] }
      appointments_with_feedback: { Row: AppointmentWithFeedback; Relationships: [] }
    }
    Functions: {}
    Enums: {}
    CompositeTypes: {}
  }
}
