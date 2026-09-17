-- =============================================================================
-- 0013 — The spoken greeting gets its own field
-- =============================================================================
-- `business_profiles.greeting_template` has been doing two jobs since 0003, and
-- it was never good at either. It was written as the owner's opening line, but
-- the only thing that reads it on the SMS side is `renderMissedCallSms`, as the
-- last fallback after `after_hours_template` and `missed_call_template` — so for
-- text it is dead weight. The one place it actually took effect was the voice
-- greeting, added in the ConversationRelay work, and there it was actively
-- wrong.
--
-- The seeded value is byte-identical to `business_settings.missed_call_template`:
--
--   'Hi, thanks for contacting {{business_name}}. We''re sorry we missed your
--    call. How can we help today?'
--
-- On SMS that reads as intended. Spoken as the *greeting* it means the assistant
-- opens a call it has just answered by apologising for missing it. Nobody wrote
-- that sentence for this purpose — it was inherited from a column whose name
-- looked close enough, and the failure only surfaces when a human rings the
-- number and hears it. It did: heard on a live call on 2026-09-16.
--
-- So voice gets its own field rather than a copy of a field that means something
-- else. `greeting_template` is left exactly as it is, because the SMS fallback
-- chain still reads it and repurposing it is a second decision on top of this
-- one.
--
-- Nullable with no default is deliberate. NULL means "use the built-in greeting",
-- which is a real, written line in `renderVoiceGreeting` rather than an empty
-- string, so a tenant who has configured nothing still gets a sensible opening.
-- It also means this migration changes no tenant's behaviour on its own: the only
-- thing that moves is which field is consulted first, and every existing row has
-- the new one unset.
--
-- No view change. `business_ai_context` selects `to_jsonb(p) - 'business_id' -
-- 'created_at' - 'updated_at'`, which spreads the whole profile row, so the
-- column reaches the prompt context with no edit there.
-- =============================================================================

alter table public.business_profiles
  add column voice_greeting_template text;

comment on column public.business_profiles.voice_greeting_template is
  'The first thing a caller hears, spoken from the TwiML before the socket is involved. NULL falls back to the built-in greeting. Distinct from greeting_template, which is the SMS missed-call fallback and apologises for a call that was not answered.';
