/**
 * Domain types.
 *
 * These mirror the database, but they are hand-written rather than generated. The
 * generated `database.ts` (via `pnpm db:types`) is the source of truth for table
 * row shapes; this file describes the *aggregates* the application actually passes
 * around — chiefly `BusinessContext`, which is one row of the
 * `business_ai_context` view and the single input to every prompt.
 */

export type ProviderName = 'anthropic' | 'openai' | 'google';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * A JSON Schema document. Loose by necessity: the three provider SDKs each type
 * schemas differently, so the shared declaration stays structural and the
 * adapters narrow it.
 */
export type JsonSchemaLike = Record<string, unknown>;

export type CommsChannel = 'sms' | 'whatsapp' | 'voice' | 'web' | 'email';

export type ConversationStatus =
  | 'active'
  | 'waiting_for_human'
  | 'human_handling'
  | 'resolved'
  | 'closed'
  | 'archived';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageSender = 'customer' | 'ai' | 'human' | 'system';

export type LeadStatus =
  | 'new'
  | 'qualifying'
  | 'qualified'
  | 'booked'
  | 'nurture'
  | 'unqualified'
  | 'lost'
  | 'won';

export type UrgencyLevel = 'low' | 'normal' | 'high' | 'emergency';

export type HandoverReason =
  | 'customer_request'
  | 'emergency'
  | 'urgent'
  | 'complaint'
  | 'repeated_confusion'
  | 'low_confidence'
  | 'keyword'
  | 'manual'
  | 'ai_error'
  | 'out_of_scope';

export type NotificationEvent =
  | 'missed_call'
  | 'new_conversation'
  | 'new_message'
  | 'lead_captured'
  | 'lead_qualified'
  | 'handover_required'
  | 'appointment_booked'
  | 'appointment_cancelled'
  | 'daily_digest'
  | 'weekly_digest';

export type NotificationChannel =
  | 'email'
  | 'sms'
  | 'whatsapp'
  | 'push'
  | 'dashboard'
  | 'webhook'
  | 'slack';

// -----------------------------------------------------------------------------
// Business context — the prompt input
// -----------------------------------------------------------------------------

export interface BusinessProfileContext {
  legal_name: string | null;
  trading_name: string | null;
  tagline: string | null;
  description: string | null;
  industry: string | null;
  founded_year: number | null;
  website_url: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  brand_primary: string;
  brand_accent: string;
  brand_background: string;
  brand_foreground: string;
  brand_font: string | null;
  custom_domain: string | null;
  tone_of_voice: string;
  ai_assistant_name: string;
  greeting_template: string | null;
  signature: string | null;
  custom_instructions: string | null;
  social_links: Record<string, string>;
}

export interface BusinessSettingsContext {
  ai_provider: ProviderName;
  ai_model: string;
  ai_effort: Effort;
  ai_max_output_tokens: number;
  ai_temperature: number | null;
  extraction_provider: ProviderName;
  extraction_model: string;
  ai_enabled: boolean;
  ai_max_turns: number;
  missed_call_sms_enabled: boolean;
  missed_call_sms_delay_seconds: number;
  missed_call_template: string | null;
  after_hours_template: string | null;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  max_sms_segments: number;
  handover_enabled: boolean;
  handover_keywords: string[];
  handover_on_emergency: boolean;
  handover_on_complaint: boolean;
  handover_confusion_threshold: number;
  handover_sla_minutes: number;
  notify_events: NotificationEvent[];
  notify_channels: NotificationChannel[];
  digest_hour_local: number;
  booking_enabled: boolean;
  booking_provider: string | null;
  booking_calendar_id: string | null;
  booking_slot_minutes: number;
  booking_buffer_minutes: number;
  booking_min_notice_hours: number;
  booking_max_days_ahead: number;
  booking_requires_confirmation: boolean;
  data_retention_days: number;
  recording_consent_text: string | null;
}

export interface ServiceContext {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_text: string | null;
  duration_minutes: number | null;
  is_bookable: boolean;
}

export interface ServiceAreaContext {
  name: string;
  postcode_prefixes: string[];
  radius_miles: number | null;
  notes: string | null;
}

export interface OpeningHoursContext {
  day_of_week: number;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
}

export interface KnowledgeItemContext {
  id: string;
  kind: 'faq' | 'policy' | 'about' | 'general' | 'document' | 'hours_note' | 'pricing_note';
  title: string | null;
  content: string;
}

export interface PhoneNumberContext {
  e164: string;
  channels: CommsChannel[];
  is_primary: boolean;
}

/** One row of the `business_ai_context` view. */
export interface BusinessContext {
  business_id: string;
  slug: string;
  name: string;
  status: string;
  timezone: string;
  locale: string;
  default_region: string;
  currency: string;
  profile: BusinessProfileContext;
  settings: BusinessSettingsContext;
  services: ServiceContext[];
  service_areas: ServiceAreaContext[];
  opening_hours: OpeningHoursContext[];
  knowledge: KnowledgeItemContext[];
  phone_numbers: PhoneNumberContext[];
}

// -----------------------------------------------------------------------------
// Conversation memory
// -----------------------------------------------------------------------------

export interface TranscriptMessage {
  id: string;
  direction: MessageDirection;
  sender: MessageSender;
  body: string | null;
  created_at: string;
}

/**
 * Everything the AI knows about the conversation so far.
 *
 * `summary` exists so long threads don't have to be replayed verbatim: older
 * turns are compacted into prose and only the recent window is sent in full.
 */
export interface ConversationMemory {
  conversation_id: string;
  business_id: string;
  channel: CommsChannel;
  status: ConversationStatus;
  customer_phone: string | null;
  customer_name: string | null;
  summary: string | null;
  current_topic: string | null;
  lead_status: LeadStatus;
  ai_enabled: boolean;
  ai_turn_count: number;
  confusion_count: number;
  message_count: number;
  /** Most recent messages, oldest first. */
  transcript: TranscriptMessage[];
  /** Known lead fields so the AI stops asking for things it already has. */
  known: KnownLeadFields;
  is_returning_contact: boolean;
}

export interface KnownLeadFields {
  name: string | null;
  phone: string | null;
  email: string | null;
  postcode: string | null;
  service: string | null;
  enquiry: string | null;
  urgency: UrgencyLevel | null;
  callback: string | null;
}

// -----------------------------------------------------------------------------
// Extraction
// -----------------------------------------------------------------------------

/** The shape the lead extractor is constrained to return. */
export interface LeadExtraction {
  name: string;
  phone: string;
  email: string;
  postcode: string;
  service: string;
  summary: string;
  enquiry: string;
  urgency: UrgencyLevel | '';
  lead_status: LeadStatus | '';
  callback_time: string;
}
