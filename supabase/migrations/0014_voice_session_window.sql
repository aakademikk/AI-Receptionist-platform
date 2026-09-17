-- =============================================================================
-- 0014 — A voice call is a session; a text thread is not
-- =============================================================================
-- `resolve_inbound` has reused an open thread since 0009, and the rule it uses is
-- the same for every channel: find a conversation for this customer on this
-- channel whose status is still open, and continue it. No time bound at all.
--
-- For SMS that is not merely acceptable, it is the point. A text thread *is*
-- continuous — a customer who replies three days later is replying to the same
-- message, sees the same history on their phone, and would be baffled to be
-- greeted as a stranger. Reuse is the correct behaviour and stays exactly as it
-- is.
--
-- For voice it is wrong, and the way it is wrong is easy to mistake for a
-- feature. A phone call is a discrete session: it starts, it ends, and the next
-- call is a new one. Observed on 2026-09-16 — two calls, fourteen minutes apart,
-- both joined a conversation created on 2026-09-13 because nothing had ever
-- closed it. The assistant opened the second call already knowing the caller's
-- name and the callback time it had agreed three days earlier. It sounds
-- delightful in a demo. It is a defect with a fuse in it:
--
--   * `ai_turn_count` is maintained by a trigger and never reset, so it
--     accumulates across every call that number ever makes. `handover` hands the
--     conversation to a human the moment it reaches `ai_max_turns`. That
--     conversation stood at 14 against a budget of 20 — so roughly six more
--     turns, spread over any number of future calls, and the assistant would
--     have abandoned every subsequent call mid-sentence for reasons belonging to
--     a call three days earlier, with no way for the caller to get past it.
--   * The transcript window and the lead fields both carry forward, so each call
--     re-prefills a prompt describing a conversation that already ended.
--   * A caller with a genuinely new problem is answered in the context of the
--     old one.
--
-- The fix is a recency window on reuse, applied to voice only. Within the window
-- a redial continues the session, which is what a caller who was cut off expects
-- and the reason this is a window rather than a hard close per call. Outside it,
-- the call opens a fresh conversation with a fresh turn budget.
--
-- Why a window rather than closing the conversation when the call ends: the
-- relay would have to be the thing that closes it, and the relay does not always
-- get to run its shutdown path — a dropped socket, a crashed process or a
-- restart mid-call all leave the row open forever. A rule evaluated at the point
-- of reuse cannot be skipped, whatever happened to the previous call. Closing on
-- `session_end` is still worth doing as tidiness; it is not worth relying on for
-- correctness.
--
-- Why a per-tenant column rather than a constant: it follows `ai_max_turns`,
-- `answer_mode` and `voice_greeting_template` — the same class of bound, already
-- expressed as tenant configuration. A firm whose callers routinely get cut off
-- in a basement wants a longer window than a firm whose callers do not.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The window itself.
--
-- 30 minutes is long enough that a dropped call redialled immediately, or a
-- caller who rings back to add one more detail, lands in the same session; short
-- enough that tomorrow's call is unambiguously a new one. Bounded at a day
-- because a value beyond that recreates the bug this migration exists to fix.
-- -----------------------------------------------------------------------------
alter table public.business_settings
  add column if not exists voice_session_minutes int not null default 30;

alter table public.business_settings
  drop constraint if exists business_settings_voice_session_minutes_check;

alter table public.business_settings
  add constraint business_settings_voice_session_minutes_check
  check (voice_session_minutes between 1 and 1440);

comment on column public.business_settings.voice_session_minutes is
  'How long after its last message an open voice conversation may still be continued by a new call. Outside this window a call starts a fresh conversation with a fresh AI turn budget. Does not affect SMS, where thread reuse is unbounded by design.';

-- -----------------------------------------------------------------------------
-- resolve_inbound, with the window.
--
-- Everything outside the thread-reuse block is unchanged from 0009 and is
-- restated here in full because this is a `create or replace` of the whole
-- function, not a patch to part of it.
-- -----------------------------------------------------------------------------
create or replace function public.resolve_inbound(
  p_to_number   text,
  p_from_number text,
  p_channel     comms_channel default 'sms',
  p_source      text default 'inbound_sms'
)
returns table (
  business_id      uuid,
  business_slug    text,
  phone_number_id  uuid,
  contact_id       uuid,
  conversation_id  uuid,
  is_new_conversation boolean,
  is_returning_contact boolean
)
language plpgsql
security definer
set search_path = public
as $$
-- The RETURNS TABLE names (business_id, contact_id, …) are also real column
-- names, which makes bare references inside ON CONFLICT ambiguous. Resolve
-- ambiguity toward the column; every output value is assigned via a v_ local, so
-- the OUT parameters are only ever read in the final RETURN QUERY.
#variable_conflict use_column
declare
  v_to      text := public.normalize_phone(p_to_number);
  v_from    text := public.normalize_phone(p_from_number);
  v_number  public.phone_numbers;
  v_business public.businesses;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_stale_id uuid;
  v_window_minutes int;
  v_is_new boolean := false;
  v_returning boolean := false;
begin
  if v_to is null or v_from is null then
    raise exception 'resolve_inbound requires both to and from numbers (got % / %)',
      p_to_number, p_from_number;
  end if;

  select * into v_number from public.phone_numbers pn
  where pn.e164 = v_to and pn.released_at is null;

  if v_number.id is null then
    raise exception 'no active phone number provisioned for %', v_to
      using errcode = 'no_data_found';
  end if;

  select * into v_business from public.businesses b where b.id = v_number.business_id;

  if v_business.deleted_at is not null or v_business.status in ('suspended', 'cancelled') then
    raise exception 'business % is not active (status %)', v_business.id, v_business.status
      using errcode = 'check_violation';
  end if;

  -- Contact: upsert on the normalised phone.
  insert into public.contacts (business_id, phone, first_seen_at, last_seen_at, conversation_count)
  values (v_business.id, v_from, now(), now(), 0)
  on conflict (business_id, phone_normalized) where phone_normalized is not null
  do update set last_seen_at = now()
  returning id, (conversation_count > 0) into v_contact_id, v_returning;

  -- Reuse an open thread for this customer on this channel.
  select c.id into v_conversation_id
  from public.conversations c
  where c.business_id = v_business.id
    and c.customer_phone = v_from
    and c.channel = p_channel
    and c.status in ('active', 'waiting_for_human', 'human_handling')
  order by c.last_message_at desc nulls last
  limit 1;

  -- On voice, that thread is only the same *session* if it is still recent.
  -- `last_message_at` is null until the first message lands, so a conversation
  -- opened seconds ago by a missed call and not yet spoken into falls back to
  -- `opened_at` rather than being treated as infinitely stale.
  if v_conversation_id is not null and p_channel = 'voice' then
    select bs.voice_session_minutes into v_window_minutes
    from public.business_settings bs
    where bs.business_id = v_business.id;

    v_window_minutes := coalesce(v_window_minutes, 30);

    if not exists (
      select 1 from public.conversations c
      where c.id = v_conversation_id
        and coalesce(c.last_message_at, c.opened_at, c.created_at)
            > now() - make_interval(mins => v_window_minutes)
    ) then
      v_stale_id := v_conversation_id;
      v_conversation_id := null;
    end if;
  end if;

  if v_conversation_id is null then
    -- The previous voice session is over and will not be continued. Close it, so
    -- the inbox does not accumulate a permanently `active` row per caller.
    -- Deliberately only when `active`: `waiting_for_human` and `human_handling`
    -- mean a person owns that thread and still has a callback to make, and this
    -- function has no business marking their work done.
    if v_stale_id is not null then
      update public.conversations c
      set status = 'resolved',
          closed_at = coalesce(c.closed_at, now())
      where c.id = v_stale_id
        and c.status = 'active';
    end if;

    insert into public.conversations (
      business_id, contact_id, phone_number_id, channel, customer_phone, source
    ) values (
      v_business.id, v_contact_id, v_number.id, p_channel, v_from, p_source
    )
    returning id into v_conversation_id;

    update public.contacts set conversation_count = conversation_count + 1
    where id = v_contact_id;

    v_is_new := true;
  end if;

  return query select
    v_business.id, v_business.slug, v_number.id, v_contact_id,
    v_conversation_id, v_is_new, v_returning;
end;
$$;
