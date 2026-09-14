-- =============================================================================
-- 0011 — Outbound voice
-- =============================================================================
-- Every migration before this one assumed the platform only ever *reacts*: a call
-- arrives, a message arrives, we answer. This adds the minimum needed to *initiate*
-- — place a call, know why we placed it, and record what came back from it.
--
-- Deliberately small, and deliberately scoped. Phase B is DTMF confirmation only:
-- no speech recognition, no model, no media stream, so nothing here needs a
-- persistent process. The generative phases add their own tables when they arrive;
-- this migration does not pre-build for them.
--
-- What was already here, and why there is so little to add: `calls` has had
-- `direction` (with `'outbound'` in the enum), `provider_call_sid`, `call_status`,
-- `duration_seconds` and `recording_url` since 0004. An outbound call was already a
-- representable row. What was missing is attribution and outcome.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Voice consent.
--
-- The mirror of `sms_opt_out` / `opt_out_at`, and for the same reason: suppression
-- has to be a column read at origination, not an intention held in application code
-- that some future write path can forget.
--
-- Kept separate from the SMS pair on purpose. A customer who replied STOP to a text
-- has not thereby refused a phone call about an appointment they booked themselves,
-- and collapsing the two would silently suppress the wrong channel.
-- -----------------------------------------------------------------------------
alter table public.contacts
  add column voice_opt_out boolean not null default false,
  add column voice_opt_out_at timestamptz;

comment on column public.contacts.voice_opt_out is
  'Set when a customer asks not to be called. Checked at origination, before dialling.';

comment on column public.contacts.voice_opt_out_at is
  'When the voice opt-out was recorded. Kept for the audit trail, as with opt_out_at.';

-- Partial index: the suppression check only ever asks for the opted-out minority, so
-- indexing that minority keeps the index small however large the contact book grows.
create index contacts_voice_opt_out_idx
  on public.contacts (business_id) where voice_opt_out;

-- -----------------------------------------------------------------------------
-- Outbound call attribution and outcome.
--
-- Four columns, each answering a question the row could not previously answer:
--
--   purpose         why we placed this call at all
--   appointment_id  what it was about, with real referential integrity
--   digits_pressed  the raw keypad evidence
--   outcome         what we concluded from it
--
-- `digits_pressed` and `outcome` are both kept despite being close to redundant,
-- because one is fact and the other is interpretation. When an appointment was
-- wrongly marked confirmed, the pressed digit is what tells you whether the caller
-- pressed the wrong key or we mapped the right one wrongly. An interpretation with
-- no raw evidence underneath it cannot be audited.
-- -----------------------------------------------------------------------------
alter table public.calls
  add column purpose text,
  add column appointment_id uuid references public.appointments (id) on delete set null,
  add column digits_pressed text,
  add column outcome text;

comment on column public.calls.purpose is
  'The closed goal this call was placed to achieve. Never free text — see the check constraint.';
comment on column public.calls.outcome is
  'Our interpretation of how the call resolved. Null while the call is still in flight.';
comment on column public.calls.digits_pressed is
  'The raw DTMF key(s) the callee pressed, recorded uninterpreted alongside outcome.';

-- A closed list, enforced here as well as in the route that originates the call.
-- n8n and any future worker write to this table too, and the entire safety argument
-- for outbound rests on the purpose being a goal *we* chose from a fixed list rather
-- than a string some caller supplied. A free-text purpose is how "confirm an
-- appointment" quietly becomes "say whatever the operator typed".
alter table public.calls
  add constraint calls_purpose_known check (
    purpose is null or purpose in (
      'appointment_confirmation',
      'appointment_reminder',
      'callback_requested',
      'missed_call_followup'
    )
  ),
  add constraint calls_outcome_known check (
    outcome is null or outcome in (
      'confirmed',
      'cancelled',
      'rescheduled',
      -- The gather timed out: nothing was pressed. Distinct from `unrecognised`,
      -- which is a key we did not offer, and from `unanswered`, which is a call that
      -- never connected at all.
      'no_input',
      'unrecognised',
      'unanswered',
      'failed'
    )
  );

-- The outbound queue and its reporting: "what have we rung out, and how did it go".
-- Partial, because the overwhelmingly common direction is inbound and the inbound
-- indexes in 0004 already cover that side.
create index calls_outbound_idx
  on public.calls (business_id, started_at desc) where direction = 'outbound';

-- "Every call we made about this appointment" — used when reconciling a booking
-- against the calls that confirmed, moved or cancelled it.
create index calls_appointment_idx
  on public.calls (appointment_id) where appointment_id is not null;
