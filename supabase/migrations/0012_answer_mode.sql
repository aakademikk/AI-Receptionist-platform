-- =============================================================================
-- 0012 — How a number answers a call
-- =============================================================================
-- Until now the platform answered an inbound call in exactly one way, and that way
-- was hardcoded in the route: `<Dial>` the business's own line, and when nobody
-- picks up, hang up and send the missed-call text. The behaviour was never a
-- decision anybody made — it was the only thing the code could do.
--
-- ConversationRelay changed that. There are now two genuine ways to answer, and
-- which one is correct is a per-number commercial decision, not a constant:
--
--   dial_through    ring the business's own line; fall back to the missed-call
--                   text when it goes unanswered. What every number does today.
--   conversational  answer with the assistant itself — speech in, speech out —
--                   instead of forwarding.
--
-- The reason this is a column and not a second number: Twilio holds exactly one
-- Voice URL per number, so "both" cannot mean one number on two routes. It means
-- one route that reads this column and emits the TwiML this column implies. Two
-- numbers would work, and is the right answer for a demo, but it does not scale —
-- a tenant would need a second number, a second bill line and a second place to be
-- wrong, in order to express one word of configuration.
--
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The column.
--
-- `not null` with a default of 'dial_through' is the load-bearing part. Every
-- number that already exists keeps the exact behaviour it has this second, so
-- applying this migration cannot change how a single live call is answered.
-- Introducing the ability to answer differently and silently switching to it are
-- different things, and only the first one belongs in a migration.
--
-- Scoped to the number rather than the business on purpose. A tenant may
-- legitimately want one line answered by the assistant and another dialled
-- straight through — a dedicated demo number alongside a real one is the obvious
-- case, and it is exactly the case that is about to exist. Per-business would make
-- that impossible to express.
-- -----------------------------------------------------------------------------
alter table public.phone_numbers
  add column answer_mode text not null default 'dial_through';

comment on column public.phone_numbers.answer_mode is
  'How an inbound call to this number is answered. Read by the voice route, which emits different TwiML per value.';

-- A closed list, enforced here as well as in the route — the same reasoning as
-- `calls.purpose` in 0011. The route picks a TwiML branch from this value, and a
-- value the route does not recognise has no safe default branch: guessing
-- "dial_through" would silently forward a call the operator meant the assistant to
-- answer, and guessing "conversational" would put an automated voice on a line that
-- was supposed to ring a human. Constraining it means the ambiguity cannot be
-- written down in the first place.
--
-- Plain text with a check rather than a Postgres enum type, matching 0011: adding a
-- value later is an `alter ... drop constraint / add constraint` inside one
-- transaction, where an enum needs `alter type ... add value` and carries
-- ordering rules that make the migration harder to reason about for no gain.
alter table public.phone_numbers
  add constraint phone_numbers_answer_mode_known check (
    answer_mode in (
      -- Ring the business's own line, then fall back to the missed-call text.
      -- Still governed by `missed_call_enabled` and `forward_to` as it is today;
      -- this column chooses the answering strategy, it does not replace them.
      'dial_through',
      -- Answer with the assistant: ConversationRelay takes the call and the socket
      -- holds the conversation. `forward_to` is not consulted in this mode.
      'conversational'
    )
  );

-- Deliberately no index. The mode is read one row at a time, by the number that was
-- dialled, and the unique index on `e164` from 0004 already serves that lookup.
-- Nothing in the platform asks "which numbers are conversational", so an index for
-- that question would be dead weight maintained on every write.
