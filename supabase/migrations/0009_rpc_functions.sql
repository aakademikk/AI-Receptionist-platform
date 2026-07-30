-- =============================================================================
-- 0009 — RPC surface for the internal API and n8n
-- =============================================================================
-- These functions exist because the alternative — n8n issuing four sequential
-- HTTP calls that each touch one table — is not atomic. A retried webhook must
-- not create a duplicate conversation, and a lead upsert must not race with a
-- concurrent extraction. Each function below is one transaction.
--
-- All are SECURITY DEFINER and callable only by service_role. The dashboard never
-- calls them; it goes through RLS-protected tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Resolve an inbound event to (business, contact, conversation).
--
-- This is the first thing every inbound webhook does. It:
--   1. maps the dialled number to a tenant (globally unique index)
--   2. finds or creates the contact
--   3. reuses the open conversation if there is one, else opens a new thread
--
-- Reusing the open thread is what makes the AI feel like it remembers the
-- customer instead of starting from scratch on every message.
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

  if v_conversation_id is null then
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

-- -----------------------------------------------------------------------------
-- Append a message, idempotently.
--
-- Returns the message id and whether it was newly created. Twilio will retry a
-- webhook it thinks failed; `was_created = false` tells the caller to stop
-- processing rather than generate a second AI reply.
-- -----------------------------------------------------------------------------
create or replace function public.append_message(
  p_conversation_id uuid,
  p_direction     message_direction,
  p_sender        message_sender,
  p_body          text,
  p_channel       comms_channel default 'sms',
  p_provider      text default 'twilio',
  p_provider_message_id text default null,
  p_status        message_status default null,
  p_media         jsonb default '[]'::jsonb,
  p_sent_by_user_id uuid default null,
  p_ai_log_id     uuid default null,
  p_metadata      jsonb default '{}'::jsonb
)
returns table (message_id uuid, was_created boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_business_id uuid;
  v_id uuid;
begin
  select c.business_id into v_business_id
  from public.conversations c where c.id = p_conversation_id;

  if v_business_id is null then
    raise exception 'conversation % not found', p_conversation_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotency check first: cheaper than an INSERT that will conflict, and it
  -- avoids burning a sequence value on every Twilio retry.
  if p_provider_message_id is not null then
    select m.id into v_id from public.messages m
    where m.business_id = v_business_id
      and m.provider_message_id = p_provider_message_id;

    if v_id is not null then
      return query select v_id, false;
      return;
    end if;
  end if;

  insert into public.messages (
    conversation_id, business_id, direction, sender, channel, body, media,
    provider, provider_message_id, status, sent_by_user_id, ai_log_id, metadata,
    sent_at
  ) values (
    p_conversation_id, v_business_id, p_direction, p_sender, p_channel, p_body, p_media,
    p_provider, p_provider_message_id,
    coalesce(
      p_status,
      case when p_direction = 'inbound' then 'received'::message_status
           else 'queued'::message_status end
    ),
    p_sent_by_user_id, p_ai_log_id, p_metadata,
    case when p_direction = 'outbound' then now() else null end
  )
  on conflict (business_id, provider_message_id) where provider_message_id is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost the race with a concurrent retry; return the winner's row.
    select m.id into v_id from public.messages m
    where m.business_id = v_business_id
      and m.provider_message_id = p_provider_message_id;
    return query select v_id, false;
    return;
  end if;

  return query select v_id, true;
end;
$$;

-- -----------------------------------------------------------------------------
-- Record a missed call and open the follow-up thread in one step.
-- -----------------------------------------------------------------------------
create or replace function public.record_missed_call(
  p_to_number   text,
  p_from_number text,
  p_provider_call_sid text default null,
  p_call_status text default 'no-answer',
  p_started_at  timestamptz default now(),
  p_metadata    jsonb default '{}'::jsonb
)
returns table (
  call_id         uuid,
  business_id     uuid,
  conversation_id uuid,
  contact_id      uuid,
  was_created     boolean,
  sms_enabled     boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_resolved record;
  v_call_id uuid;
  v_created boolean := true;
  v_sms_enabled boolean;
begin
  select * into v_resolved
  from public.resolve_inbound(p_to_number, p_from_number, 'voice', 'missed_call');

  -- Idempotency on the provider's call SID.
  if p_provider_call_sid is not null then
    select c.id into v_call_id from public.calls c
    where c.provider = 'twilio' and c.provider_call_sid = p_provider_call_sid;
  end if;

  if v_call_id is null then
    insert into public.calls (
      business_id, phone_number_id, contact_id, conversation_id,
      provider_call_sid, direction, from_number, to_number,
      call_status, is_missed, started_at, metadata
    ) values (
      v_resolved.business_id, v_resolved.phone_number_id, v_resolved.contact_id,
      v_resolved.conversation_id, p_provider_call_sid, 'inbound',
      public.normalize_phone(p_from_number), public.normalize_phone(p_to_number),
      p_call_status, true, p_started_at, p_metadata
    )
    returning id into v_call_id;
  else
    v_created := false;
  end if;

  select s.missed_call_sms_enabled and s.ai_enabled into v_sms_enabled
  from public.business_settings s where s.business_id = v_resolved.business_id;

  return query select
    v_call_id, v_resolved.business_id, v_resolved.conversation_id,
    v_resolved.contact_id, v_created, coalesce(v_sms_enabled, false);
end;
$$;

-- -----------------------------------------------------------------------------
-- Upsert the lead for a conversation from an extraction payload.
--
-- Merge semantics matter here: extraction runs after every inbound message, and
-- a later run that fails to restate the customer's postcode must not erase it.
-- So every field is COALESCE(new, existing) — we only ever add information.
-- -----------------------------------------------------------------------------
create or replace function public.upsert_lead(
  p_conversation_id uuid,
  p_extraction      jsonb,
  p_extraction_version int default 1
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.conversations;
  v_lead_id uuid;
  v_service_id uuid;
  v_name text := nullif(btrim(p_extraction ->> 'name'), '');
  v_phone text := nullif(btrim(p_extraction ->> 'phone'), '');
  v_email text := nullif(btrim(p_extraction ->> 'email'), '');
  v_postcode text := nullif(btrim(upper(p_extraction ->> 'postcode')), '');
  v_service_text text := nullif(btrim(p_extraction ->> 'service'), '');
  v_enquiry text := nullif(btrim(p_extraction ->> 'enquiry'), '');
  v_summary text := nullif(btrim(p_extraction ->> 'summary'), '');
  v_urgency urgency_level;
  v_status lead_status;
  v_callback text := nullif(btrim(p_extraction ->> 'callback_time'), '');
begin
  select * into v_conv from public.conversations c where c.id = p_conversation_id;
  if v_conv.id is null then
    raise exception 'conversation % not found', p_conversation_id
      using errcode = 'no_data_found';
  end if;

  -- Enum coercion is defensive: a model that returns "very urgent" instead of
  -- "high" should degrade to a sane default, not abort the whole workflow.
  begin
    v_urgency := coalesce(nullif(lower(p_extraction ->> 'urgency'), ''), 'normal')::urgency_level;
  exception when invalid_text_representation then
    v_urgency := 'normal';
  end;

  begin
    v_status := coalesce(nullif(lower(p_extraction ->> 'lead_status'), ''), 'qualifying')::lead_status;
  exception when invalid_text_representation then
    v_status := 'qualifying';
  end;

  -- Match the free-text service to the catalogue so reporting can group by it.
  if v_service_text is not null then
    select s.id into v_service_id
    from public.services s
    where s.business_id = v_conv.business_id
      and s.is_published
      and (lower(s.name) = lower(v_service_text) or lower(v_service_text) like '%' || lower(s.name) || '%')
    order by length(s.name) desc
    limit 1;
  end if;

  insert into public.leads (
    business_id, conversation_id, contact_id, name, phone, email, postcode,
    service_id, service_text, enquiry, summary, urgency, status, callback_text,
    source, raw_extraction, extraction_version, extracted_at
  ) values (
    v_conv.business_id, p_conversation_id, v_conv.contact_id,
    v_name, coalesce(v_phone, v_conv.customer_phone), v_email::citext, v_postcode,
    v_service_id, v_service_text, v_enquiry, v_summary, v_urgency, v_status, v_callback,
    v_conv.source, p_extraction, p_extraction_version, now()
  )
  on conflict (conversation_id) do update set
    name          = coalesce(excluded.name, leads.name),
    phone         = coalesce(excluded.phone, leads.phone),
    email         = coalesce(excluded.email, leads.email),
    postcode      = coalesce(excluded.postcode, leads.postcode),
    service_id    = coalesce(excluded.service_id, leads.service_id),
    service_text  = coalesce(excluded.service_text, leads.service_text),
    enquiry       = coalesce(excluded.enquiry, leads.enquiry),
    summary       = coalesce(excluded.summary, leads.summary),
    urgency       = excluded.urgency,
    -- Never walk a lead backwards: a won/lost lead stays that way.
    status        = case
                      when leads.status in ('won', 'lost', 'booked') then leads.status
                      else excluded.status
                    end,
    callback_text = coalesce(excluded.callback_text, leads.callback_text),
    raw_extraction = excluded.raw_extraction,
    extraction_version = excluded.extraction_version,
    extracted_at  = excluded.extracted_at
  returning id into v_lead_id;

  -- Promote what we learned onto the contact record so the next conversation
  -- starts warm.
  if v_conv.contact_id is not null then
    update public.contacts ct
    set full_name = coalesce(ct.full_name, v_name),
        email     = coalesce(ct.email, v_email::citext),
        postcode  = coalesce(ct.postcode, v_postcode)
    where ct.id = v_conv.contact_id;
  end if;

  return v_lead_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Handover: stop the AI, flag the thread, and let the notification engine know.
-- Idempotent — a second trigger on an already-escalated thread is a no-op.
-- -----------------------------------------------------------------------------
create or replace function public.request_handover(
  p_conversation_id uuid,
  p_reason handover_reason,
  p_note text default null
)
returns table (conversation_id uuid, was_escalated boolean, business_id uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_business_id uuid;
  v_updated int;
begin
  update public.conversations c
  set status = 'waiting_for_human',
      ai_enabled = false,
      handover_reason_code = p_reason,
      handover_note = coalesce(p_note, c.handover_note),
      handover_at = now()
  where c.id = p_conversation_id
    and c.status not in ('waiting_for_human', 'human_handling')
  returning c.business_id into v_business_id;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    select c.business_id into v_business_id
    from public.conversations c where c.id = p_conversation_id;
    return query select p_conversation_id, false, v_business_id;
    return;
  end if;

  return query select p_conversation_id, true, v_business_id;
end;
$$;

-- A human picks up the thread.
create or replace function public.take_over_conversation(
  p_conversation_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
  set status = 'human_handling',
      ai_enabled = false,
      assigned_user_id = p_user_id,
      taken_over_at = coalesce(taken_over_at, now()),
      taken_over_by = p_user_id
  where id = p_conversation_id;
end;
$$;

-- ...and hands it back.
create or replace function public.resume_ai(
  p_conversation_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
  set status = 'active',
      ai_enabled = true,
      confusion_count = 0,
      handover_reason_code = null,
      handover_at = null
  where id = p_conversation_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Notification fan-out.
--
-- Expands one event into one outbox row per subscribed recipient, respecting both
-- the business-wide event/channel subscription and each recipient's own filter.
-- dedupe_key is namespaced per recipient so two people both get told, but neither
-- gets told twice.
-- -----------------------------------------------------------------------------
create or replace function public.enqueue_notification(
  p_business_id uuid,
  p_event notification_event,
  p_subject text default null,
  p_body text default null,
  p_payload jsonb default '{}'::jsonb,
  p_conversation_id uuid default null,
  p_lead_id uuid default null,
  p_appointment_id uuid default null,
  p_dedupe_key text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.business_settings;
  v_inserted int := 0;
begin
  select * into v_settings from public.business_settings s where s.business_id = p_business_id;

  if v_settings.business_id is null or not (p_event = any (v_settings.notify_events)) then
    return 0;
  end if;

  with eligible as (
    select r.*
    from public.notification_recipients r
    where r.business_id = p_business_id
      and r.is_active
      and r.channel = any (v_settings.notify_channels)
      and (cardinality(r.events) = 0 or p_event = any (r.events))
  ),
  ins as (
    insert into public.notifications (
      business_id, event, channel, recipient_id, destination,
      subject, body, payload, conversation_id, lead_id, appointment_id, dedupe_key
    )
    select
      p_business_id, p_event, e.channel, e.id, e.destination,
      p_subject, p_body, p_payload, p_conversation_id, p_lead_id, p_appointment_id,
      case when p_dedupe_key is null then null
           else p_dedupe_key || ':' || e.id::text end
    from eligible e
    on conflict (business_id, dedupe_key) where dedupe_key is not null
    do nothing
    returning 1
  )
  select count(*)::int into v_inserted from ins;

  return v_inserted;
end;
$$;

-- Worker claim: atomically grab a batch of due notifications.
-- FOR UPDATE SKIP LOCKED is what lets several workers drain the queue in
-- parallel without handing the same row to two of them.
create or replace function public.claim_notifications(p_limit int default 25)
returns setof public.notifications
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select n.id
    from public.notifications n
    where n.status = 'pending'
      and n.scheduled_for <= now()
      and n.channel <> 'dashboard'   -- in-app needs no delivery
      and n.attempts < 5
    order by n.scheduled_for
    for update skip locked
    limit p_limit
  )
  update public.notifications n
  set status = 'sending', attempts = n.attempts + 1
  from claimed
  where n.id = claimed.id
  returning n.*;
end;
$$;

-- -----------------------------------------------------------------------------
-- Analytics rollup. Idempotent for any given day; safe to re-run and backfill.
-- -----------------------------------------------------------------------------
create or replace function public.rollup_analytics_daily(
  p_business_id uuid,
  p_day date default (current_date - 1)
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  select b.timezone into v_tz from public.businesses b where b.id = p_business_id;
  v_tz := coalesce(v_tz, 'UTC');

  -- Day boundaries in the tenant's own timezone — a "day" for a London business
  -- is not the same window as for one in Sydney.
  v_start := (p_day::text || ' 00:00:00')::timestamp at time zone v_tz;
  v_end := v_start + interval '1 day';

  insert into public.analytics_daily as ad (
    business_id, day,
    calls_total, calls_missed,
    conversations_started, conversations_resolved,
    messages_inbound, messages_outbound, messages_ai, messages_human,
    leads_captured, leads_qualified, appointments_booked, handovers,
    avg_first_response_seconds, median_first_response_seconds,
    ai_handled_pct, human_handled_pct,
    ai_cost_usd, messaging_cost_usd, computed_at
  )
  select
    p_business_id, p_day,
    (select count(*) from public.calls c
       where c.business_id = p_business_id and c.started_at >= v_start and c.started_at < v_end),
    (select count(*) from public.calls c
       where c.business_id = p_business_id and c.is_missed
         and c.started_at >= v_start and c.started_at < v_end),
    (select count(*) from public.conversations cv
       where cv.business_id = p_business_id and cv.opened_at >= v_start and cv.opened_at < v_end),
    (select count(*) from public.conversations cv
       where cv.business_id = p_business_id and cv.status = 'resolved'
         and cv.closed_at >= v_start and cv.closed_at < v_end),
    coalesce(m.inbound, 0), coalesce(m.outbound, 0), coalesce(m.ai, 0), coalesce(m.human, 0),
    (select count(*) from public.leads l
       where l.business_id = p_business_id and l.created_at >= v_start and l.created_at < v_end),
    (select count(*) from public.leads l
       where l.business_id = p_business_id
         and l.status in ('qualified','booked','won')
         and l.created_at >= v_start and l.created_at < v_end),
    (select count(*) from public.appointments a
       where a.business_id = p_business_id and a.created_at >= v_start and a.created_at < v_end
         and a.status in ('pending','confirmed','completed')),
    (select count(*) from public.conversations cv
       where cv.business_id = p_business_id and cv.handover_at >= v_start and cv.handover_at < v_end),
    frt.avg_seconds, frt.median_seconds,
    -- AI-handled share of outbound traffic. The two percentages are the headline
    -- "is this thing working?" metric on the dashboard.
    case when coalesce(m.outbound, 0) = 0 then null
         else round(100.0 * coalesce(m.ai, 0) / m.outbound, 2) end,
    case when coalesce(m.outbound, 0) = 0 then null
         else round(100.0 * coalesce(m.human, 0) / m.outbound, 2) end,
    (select coalesce(sum(al.cost_usd), 0) from public.ai_logs al
       where al.business_id = p_business_id and al.created_at >= v_start and al.created_at < v_end),
    (select coalesce(sum(msg.price_amount), 0) from public.messages msg
       where msg.business_id = p_business_id and msg.created_at >= v_start and msg.created_at < v_end),
    now()
  from (
    select
      count(*) filter (where direction = 'inbound')  as inbound,
      count(*) filter (where direction = 'outbound') as outbound,
      count(*) filter (where sender = 'ai')          as ai,
      count(*) filter (where sender = 'human')       as human
    from public.messages
    where business_id = p_business_id and created_at >= v_start and created_at < v_end
  ) m
  cross join (
    select
      round(avg(first_response_seconds)::numeric, 2) as avg_seconds,
      round(percentile_cont(0.5) within group (order by first_response_seconds)::numeric, 2) as median_seconds
    from public.conversations
    where business_id = p_business_id
      and first_response_seconds is not null
      and opened_at >= v_start and opened_at < v_end
  ) frt
  on conflict (business_id, day) do update set
    calls_total = excluded.calls_total,
    calls_missed = excluded.calls_missed,
    conversations_started = excluded.conversations_started,
    conversations_resolved = excluded.conversations_resolved,
    messages_inbound = excluded.messages_inbound,
    messages_outbound = excluded.messages_outbound,
    messages_ai = excluded.messages_ai,
    messages_human = excluded.messages_human,
    leads_captured = excluded.leads_captured,
    leads_qualified = excluded.leads_qualified,
    appointments_booked = excluded.appointments_booked,
    handovers = excluded.handovers,
    avg_first_response_seconds = excluded.avg_first_response_seconds,
    median_first_response_seconds = excluded.median_first_response_seconds,
    ai_handled_pct = excluded.ai_handled_pct,
    human_handled_pct = excluded.human_handled_pct,
    ai_cost_usd = excluded.ai_cost_usd,
    messaging_cost_usd = excluded.messaging_cost_usd,
    computed_at = now();
end;
$$;

-- Roll up every active tenant. Called nightly by the Analytics workflow.
create or replace function public.rollup_analytics_all(p_day date default (current_date - 1))
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_count int := 0;
begin
  for v_id in
    select id from public.businesses
    where deleted_at is null and status in ('trialing','active','past_due')
  loop
    perform public.rollup_analytics_daily(v_id, p_day);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- GDPR erasure.
--
-- Anonymises rather than hard-deletes: the business keeps its aggregate history
-- (it has a legitimate interest in knowing it handled 400 calls last month) while
-- every identifier tying those rows to a person is destroyed. Message bodies are
-- redacted because a transcript is itself personal data.
-- -----------------------------------------------------------------------------
create or replace function public.erase_contact(
  p_business_id uuid,
  p_contact_id uuid,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversations int := 0;
  v_messages int := 0;
  v_leads int := 0;
  v_calls int := 0;
  v_result jsonb;
begin
  if not exists (
    select 1 from public.contacts c
    where c.id = p_contact_id and c.business_id = p_business_id
  ) then
    raise exception 'contact % not found in business %', p_contact_id, p_business_id
      using errcode = 'no_data_found';
  end if;

  with target as (
    select id from public.conversations
    where business_id = p_business_id and contact_id = p_contact_id
  ),
  redacted as (
    update public.messages m
    set body = '[erased at data subject request]',
        media = '[]'::jsonb,
        metadata = '{}'::jsonb
    where m.conversation_id in (select id from target)
    returning 1
  )
  select count(*)::int into v_messages from redacted;

  update public.conversations
  set customer_phone = null,
      customer_name = null,
      summary = null,
      last_ai_response = null,
      current_topic = null,
      status = 'archived',
      metadata = '{}'::jsonb
  where business_id = p_business_id and contact_id = p_contact_id;
  get diagnostics v_conversations = row_count;

  update public.leads
  set name = null, phone = null, email = null, postcode = null,
      enquiry = null, summary = null, notes = null,
      raw_extraction = '{}'::jsonb
  where business_id = p_business_id and contact_id = p_contact_id;
  get diagnostics v_leads = row_count;

  update public.calls
  set from_number = 'erased',
      recording_url = null,
      voicemail_url = null,
      voicemail_transcript = null,
      metadata = '{}'::jsonb
  where business_id = p_business_id and contact_id = p_contact_id;
  get diagnostics v_calls = row_count;

  update public.appointments
  set customer_name = null, customer_phone = null, customer_email = null, notes = null
  where business_id = p_business_id and contact_id = p_contact_id;

  -- AI logs hold prompt fragments; drop them entirely for this subject.
  delete from public.ai_logs
  where business_id = p_business_id
    and conversation_id in (
      select id from public.conversations
      where business_id = p_business_id and contact_id = p_contact_id
    );

  -- Finally the contact itself. Keep the row (FKs point at it) but strip it bare.
  update public.contacts
  set phone = null, email = null, full_name = null, postcode = null,
      notes = null, tags = '{}'::text[], sms_opt_out = true, opt_out_at = now()
  where id = p_contact_id;

  v_result := jsonb_build_object(
    'contact_id', p_contact_id,
    'conversations_anonymised', v_conversations,
    'messages_redacted', v_messages,
    'leads_anonymised', v_leads,
    'calls_anonymised', v_calls,
    'erased_at', now()
  );

  if p_request_id is not null then
    update public.gdpr_requests
    set status = 'completed', completed_at = now(), result = v_result
    where id = p_request_id;
  end if;

  insert into public.audit_logs (
    business_id, actor_type, action, entity_type, entity_id, after
  ) values (
    p_business_id, 'system', 'erase', 'contacts', p_contact_id::text, v_result
  );

  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Retention sweep. Honours each tenant's data_retention_days.
-- Run nightly; deliberately bounded so one huge tenant cannot stall the job.
-- -----------------------------------------------------------------------------
create or replace function public.purge_expired_data(p_batch_limit int default 5000)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ai_logs int := 0;
  v_notifications int := 0;
  v_conversations int := 0;
begin
  with expired as (
    select al.id
    from public.ai_logs al
    join public.business_settings s on s.business_id = al.business_id
    where al.created_at < now() - (s.data_retention_days || ' days')::interval
    limit p_batch_limit
  )
  delete from public.ai_logs where id in (select id from expired);
  get diagnostics v_ai_logs = row_count;

  delete from public.notifications
  where status in ('sent', 'failed', 'suppressed')
    and created_at < now() - interval '90 days';
  get diagnostics v_notifications = row_count;

  with expired as (
    select c.id
    from public.conversations c
    join public.business_settings s on s.business_id = c.business_id
    where c.status in ('closed', 'resolved', 'archived')
      and c.last_message_at < now() - (s.data_retention_days || ' days')::interval
    limit p_batch_limit
  )
  delete from public.conversations where id in (select id from expired);
  get diagnostics v_conversations = row_count;

  return jsonb_build_object(
    'ai_logs_deleted', v_ai_logs,
    'notifications_deleted', v_notifications,
    'conversations_deleted', v_conversations,
    'ran_at', now()
  );
end;
$$;

-- =============================================================================
-- Lock the RPC surface to the service role. The dashboard must never reach these.
-- =============================================================================
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.resolve_inbound(text,text,comms_channel,text)',
    'public.append_message(uuid,message_direction,message_sender,text,comms_channel,text,text,message_status,jsonb,uuid,uuid,jsonb)',
    'public.record_missed_call(text,text,text,text,timestamptz,jsonb)',
    'public.upsert_lead(uuid,jsonb,int)',
    'public.request_handover(uuid,handover_reason,text)',
    'public.take_over_conversation(uuid,uuid)',
    'public.resume_ai(uuid)',
    'public.enqueue_notification(uuid,notification_event,text,text,jsonb,uuid,uuid,uuid,text)',
    'public.claim_notifications(int)',
    'public.rollup_analytics_daily(uuid,date)',
    'public.rollup_analytics_all(date)',
    'public.erase_contact(uuid,uuid,uuid)',
    'public.purge_expired_data(int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
