-- =============================================================================
-- functional.sql — exercises the hot path and proves tenant isolation.
--
-- Run after the migrations via supabase/tests/validate_local.sh (or against a
-- local `supabase start` stack). Every check raises on failure, so a clean run
-- means every assertion held.
-- =============================================================================
\set ON_ERROR_STOP on

begin;

-- -----------------------------------------------------------------------------
-- Fixtures: two tenants, so isolation failures are visible rather than theoretical.
-- -----------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@acme.test'),
  ('22222222-2222-2222-2222-222222222222', 'owner@rival.test'),
  ('33333333-3333-3333-3333-333333333333', 'viewer@acme.test');

insert into public.businesses (id, slug, name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'acme', 'Acme Block Management', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'rival-co', 'Rival Co', 'active');

insert into public.memberships (business_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'viewer'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner');

insert into public.phone_numbers (business_id, e164, is_primary) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '+441134960001', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', '+441134960002', true);

insert into public.services (business_id, name, price_text, is_bookable) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Block Management', 'from £45/unit/month', false),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Property Valuation', 'Free', true);

insert into public.notification_recipients (business_id, channel, destination) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'email', 'owner@acme.test'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'dashboard', 'in-app');

-- Defaults must have been provisioned by trigger.
do $$
begin
  if not exists (select 1 from public.business_profiles
                 where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'FAIL: business_profiles was not auto-provisioned';
  end if;
  if not exists (select 1 from public.business_settings
                 where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'FAIL: business_settings was not auto-provisioned';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. Missed call -> routed to the right tenant, conversation opened.
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
  r2 record;
  v_conv uuid;
begin
  select * into r from public.record_missed_call(
    '+441134960001', '+447700900123', 'CA_test_001', 'no-answer'
  );

  if r.business_id <> 'aaaaaaaa-0000-0000-0000-000000000001' then
    raise exception 'FAIL: missed call routed to wrong tenant (%)', r.business_id;
  end if;
  if not r.was_created then
    raise exception 'FAIL: first missed call should create a call row';
  end if;
  if not r.sms_enabled then
    raise exception 'FAIL: missed_call_sms_enabled should default true';
  end if;
  v_conv := r.conversation_id;

  -- Twilio retries the same webhook: must not duplicate the call or the thread.
  select * into r2 from public.record_missed_call(
    '+441134960001', '+447700900123', 'CA_test_001', 'no-answer'
  );
  if r2.was_created then
    raise exception 'FAIL: duplicate call SID created a second call row';
  end if;
  if r2.conversation_id <> v_conv then
    raise exception 'FAIL: retry opened a second conversation';
  end if;

  if (select count(*) from public.calls where provider_call_sid = 'CA_test_001') <> 1 then
    raise exception 'FAIL: call log is not idempotent on provider_call_sid';
  end if;
end;
$$;

-- Unknown number must be rejected loudly, not silently attributed to someone.
do $$
begin
  begin
    perform public.resolve_inbound('+449999999999', '+447700900123');
    raise exception 'FAIL: unprovisioned number should have raised';
  exception when no_data_found then
    null;  -- expected
  end;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1b. Thread reuse is channel-dependent (0014).
--
-- A text thread is continuous and is reused however old it is. A phone call is a
-- session: within `voice_session_minutes` a redial continues it, outside that
-- window the call opens a fresh conversation with a fresh AI turn budget. Nothing
-- covered this before, which is how a voice thread three days old carried its
-- turn count into a live call on 2026-09-16.
-- -----------------------------------------------------------------------------
do $$
declare
  v_sms1 uuid;
  v_sms2 uuid;
  v_voice1 uuid;
  v_voice2 uuid;
  v_voice3 uuid;
  r record;
begin
  -- SMS: two resolves in a row must land on one thread.
  select conversation_id into v_sms1 from public.resolve_inbound(
    '+441134960001', '+447700900801', 'sms', 'inbound_sms');
  select conversation_id into v_sms2 from public.resolve_inbound(
    '+441134960001', '+447700900801', 'sms', 'inbound_sms');
  if v_sms1 <> v_sms2 then
    raise exception 'FAIL: SMS opened a second thread for the same customer';
  end if;

  -- ...and must still be reused when it is ancient. Unbounded reuse is the
  -- documented SMS behaviour, so age must make no difference at all.
  update public.conversations set last_message_at = now() - interval '30 days'
  where id = v_sms1;

  select conversation_id into v_sms2 from public.resolve_inbound(
    '+441134960001', '+447700900801', 'sms', 'inbound_sms');
  if v_sms1 <> v_sms2 then
    raise exception 'FAIL: an old SMS thread was abandoned; SMS reuse must be unbounded';
  end if;

  -- Voice, inside the window: the same session.
  select conversation_id into v_voice1 from public.resolve_inbound(
    '+441134960001', '+447700900802', 'voice', 'inbound_call');
  update public.conversations set last_message_at = now() - interval '2 minutes'
  where id = v_voice1;

  select conversation_id into v_voice2 from public.resolve_inbound(
    '+441134960001', '+447700900802', 'voice', 'inbound_call');
  if v_voice1 <> v_voice2 then
    raise exception 'FAIL: a redial 2 minutes later should continue the session';
  end if;

  -- Voice, outside the window: a new session, and the old one is closed rather
  -- than left `active` forever.
  update public.conversations
  set last_message_at = now() - interval '2 hours', ai_turn_count = 19
  where id = v_voice1;

  select * into r from public.resolve_inbound(
    '+441134960001', '+447700900802', 'voice', 'inbound_call');
  v_voice3 := r.conversation_id;

  if v_voice3 = v_voice1 then
    raise exception 'FAIL: a call 2 hours later continued the previous session';
  end if;
  if not r.is_new_conversation then
    raise exception 'FAIL: is_new_conversation should be true for a fresh voice session';
  end if;
  if (select ai_turn_count from public.conversations where id = v_voice3) <> 0 then
    raise exception 'FAIL: a new voice session must start with a fresh turn budget';
  end if;
  if (select status from public.conversations where id = v_voice1) <> 'resolved' then
    raise exception 'FAIL: the superseded voice thread should have been closed';
  end if;

  -- A thread a human owns is never closed by this path: they still owe a callback.
  update public.conversations
  set status = 'waiting_for_human', last_message_at = now() - interval '2 hours'
  where id = v_voice3;

  perform public.resolve_inbound(
    '+441134960001', '+447700900802', 'voice', 'inbound_call');

  if (select status from public.conversations where id = v_voice3) <> 'waiting_for_human' then
    raise exception 'FAIL: a thread awaiting a human was closed out from under them';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Message append: idempotency, counters, first response time.
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv uuid;
  m1 record;
  m1_retry record;
  m2 record;
  c public.conversations;
begin
  select id into v_conv from public.conversations
  where business_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1;

  -- Branded outbound SMS (the missed-call follow-up).
  select * into m1 from public.append_message(
    v_conv, 'outbound', 'ai',
    'Hi, thanks for contacting Acme Block Management. Sorry we missed your call. How can we help?',
    'sms', 'twilio', 'SM_out_001', 'sent'
  );
  if not m1.was_created then raise exception 'FAIL: first outbound not created'; end if;

  -- Customer replies.
  select * into m2 from public.append_message(
    v_conv, 'inbound', 'customer',
    'Hi, I need a valuation for a flat in LS1. Fairly urgent.',
    'sms', 'twilio', 'SM_in_001', 'received'
  );
  if not m2.was_created then raise exception 'FAIL: inbound not created'; end if;

  -- Twilio replays the inbound webhook.
  select * into m1_retry from public.append_message(
    v_conv, 'inbound', 'customer',
    'Hi, I need a valuation for a flat in LS1. Fairly urgent.',
    'sms', 'twilio', 'SM_in_001', 'received'
  );
  if m1_retry.was_created then
    raise exception 'FAIL: duplicate provider_message_id created a second message';
  end if;
  if m1_retry.message_id <> m2.message_id then
    raise exception 'FAIL: idempotent append returned the wrong message id';
  end if;

  -- AI replies -> this is the first outbound *after* an inbound, so it sets FRT.
  perform public.append_message(
    v_conv, 'outbound', 'ai',
    'Happy to help with a valuation. Could I take your name and the full postcode?',
    'sms', 'twilio', 'SM_out_002', 'sent'
  );

  select * into c from public.conversations where id = v_conv;

  if c.message_count <> 3 then
    raise exception 'FAIL: message_count = % (expected 3)', c.message_count;
  end if;
  if c.inbound_count <> 1 then
    raise exception 'FAIL: inbound_count = % (expected 1)', c.inbound_count;
  end if;
  if c.outbound_count <> 2 then
    raise exception 'FAIL: outbound_count = % (expected 2)', c.outbound_count;
  end if;
  if c.ai_turn_count <> 2 then
    raise exception 'FAIL: ai_turn_count = % (expected 2)', c.ai_turn_count;
  end if;
  if c.first_response_seconds is null then
    raise exception 'FAIL: first_response_seconds was not computed';
  end if;
  if c.last_ai_response not like 'Happy to help%' then
    raise exception 'FAIL: last_ai_response not tracked (got %)', c.last_ai_response;
  end if;
end;
$$;

-- A message whose business_id contradicts its conversation must be rejected.
do $$
declare
  v_conv uuid;
begin
  select id into v_conv from public.conversations
  where business_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1;

  begin
    insert into public.messages (conversation_id, business_id, direction, sender, body)
    values (v_conv, 'bbbbbbbb-0000-0000-0000-000000000002', 'inbound', 'customer', 'cross-tenant');
    raise exception 'FAIL: cross-tenant message insert was allowed';
  exception when others then
    if sqlerrm not like '%does not match conversation%' then raise; end if;
  end;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Lead extraction: upsert merge semantics must never lose information.
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv uuid;
  v_lead public.leads;
begin
  select id into v_conv from public.conversations
  where business_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1;

  perform public.upsert_lead(v_conv, jsonb_build_object(
    'name', '', 'phone', '+447700900123', 'email', '',
    'postcode', 'ls1 4dy', 'service', 'Property Valuation',
    'summary', 'Wants a flat valuation in LS1',
    'urgency', 'high', 'lead_status', 'qualifying', 'callback_time', ''
  ));

  select * into v_lead from public.leads where conversation_id = v_conv;

  if v_lead.postcode <> 'LS1 4DY' then
    raise exception 'FAIL: postcode not upper-cased (got %)', v_lead.postcode;
  end if;
  if v_lead.service_id is null then
    raise exception 'FAIL: service_text did not match the catalogue';
  end if;
  if v_lead.name is not null then
    raise exception 'FAIL: empty string should normalise to NULL, got %', v_lead.name;
  end if;
  if v_lead.urgency <> 'high' then
    raise exception 'FAIL: urgency = %', v_lead.urgency;
  end if;

  -- Second run learns the name but forgets the postcode. Merge must keep both.
  perform public.upsert_lead(v_conv, jsonb_build_object(
    'name', 'Dan Whitfield', 'phone', '+447700900123',
    'service', 'Property Valuation', 'urgency', 'high', 'lead_status', 'qualified'
  ));

  select * into v_lead from public.leads where conversation_id = v_conv;

  if v_lead.name <> 'Dan Whitfield' then
    raise exception 'FAIL: name not learned on second pass';
  end if;
  if v_lead.postcode is distinct from 'LS1 4DY' then
    raise exception 'FAIL: merge erased a previously-known postcode';
  end if;
  if v_lead.status <> 'qualified' then
    raise exception 'FAIL: status did not advance to qualified';
  end if;
  if v_lead.completeness <= 0 then
    raise exception 'FAIL: completeness not computed';
  end if;

  -- The conversation's denormalised copy must track the lead.
  if (select lead_status from public.conversations where id = v_conv) <> 'qualified' then
    raise exception 'FAIL: conversation.lead_status did not sync';
  end if;
  if (select customer_name from public.conversations where id = v_conv) <> 'Dan Whitfield' then
    raise exception 'FAIL: conversation.customer_name did not sync';
  end if;

  -- A garbage enum from the model must degrade, not explode.
  perform public.upsert_lead(v_conv, jsonb_build_object(
    'name', 'Dan Whitfield', 'urgency', 'extremely urgent!!', 'lead_status', 'not-a-status'
  ));
  select * into v_lead from public.leads where conversation_id = v_conv;
  if v_lead.urgency <> 'normal' then
    raise exception 'FAIL: invalid urgency should fall back to normal, got %', v_lead.urgency;
  end if;

  -- Contact enrichment should have propagated.
  if (select full_name from public.contacts
      where business_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1) <> 'Dan Whitfield' then
    raise exception 'FAIL: contact was not enriched from the lead';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Handover + notification fan-out.
-- -----------------------------------------------------------------------------
do $$
declare
  v_conv uuid;
  h record;
  h2 record;
  v_sent int;
  v_acme_claimed int;
  v_acme_email_claimed int;
  v_dashboard_claimed int;
begin
  select id into v_conv from public.conversations
  where business_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1;

  select * into h from public.request_handover(v_conv, 'urgent', 'Customer said urgent twice');
  if not h.was_escalated then raise exception 'FAIL: handover did not escalate'; end if;

  if (select status from public.conversations where id = v_conv) <> 'waiting_for_human' then
    raise exception 'FAIL: status is not waiting_for_human';
  end if;
  if (select ai_enabled from public.conversations where id = v_conv) then
    raise exception 'FAIL: AI was not muted on handover';
  end if;

  -- Re-triggering must be a no-op, not a second escalation.
  select * into h2 from public.request_handover(v_conv, 'urgent', 'again');
  if h2.was_escalated then
    raise exception 'FAIL: handover is not idempotent';
  end if;

  -- Fan-out: email + dashboard recipients are both subscribed by default.
  v_sent := public.enqueue_notification(
    'aaaaaaaa-0000-0000-0000-000000000001', 'handover_required',
    'Conversation needs you', 'Customer said urgent twice',
    '{}'::jsonb, v_conv, null, null, 'handover:' || v_conv::text
  );
  if v_sent <> 2 then
    raise exception 'FAIL: expected 2 notifications, got %', v_sent;
  end if;

  -- Same dedupe key again -> nothing new.
  v_sent := public.enqueue_notification(
    'aaaaaaaa-0000-0000-0000-000000000001', 'handover_required',
    'Conversation needs you', 'Customer said urgent twice',
    '{}'::jsonb, v_conv, null, null, 'handover:' || v_conv::text
  );
  if v_sent <> 0 then
    raise exception 'FAIL: dedupe_key did not suppress the duplicate (got %)', v_sent;
  end if;

  -- An event the business is not subscribed to must be dropped.
  if public.enqueue_notification('aaaaaaaa-0000-0000-0000-000000000001', 'weekly_digest') <> 0 then
    raise exception 'FAIL: unsubscribed event was enqueued';
  end if;

  -- The worker claims only deliverable channels; dashboard stays for in-app read.
  --
  -- claim_notifications() is global by design (one worker drains every tenant),
  -- so on a populated database it also returns other tenants' due rows, and a
  -- small limit could fill with older ones before it reaches the fixture's. The
  -- limit is therefore the size of the whole table, so every due row is claimed
  -- in one call, and only the fixture tenant's share is judged. The enclosing
  -- transaction rolls back, so no other tenant's row is changed for good.
  select
    count(*) filter (where c.business_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
    count(*) filter (where c.business_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                       and c.channel = 'email'
                       and c.destination = 'owner@acme.test'
                       and c.dedupe_key like 'handover:' || v_conv::text || ':%'
                       and c.status = 'sending'
                       and c.attempts = 1),
    count(*) filter (where c.channel = 'dashboard')
  into v_acme_claimed, v_acme_email_claimed, v_dashboard_claimed
  from public.claim_notifications((select count(*)::int from public.notifications)) c;

  if v_acme_claimed <> 1 or v_acme_email_claimed <> 1 then
    raise exception 'FAIL: claim_notifications should return exactly the email row for the fixture tenant (got % row(s), % of them the email)',
      v_acme_claimed, v_acme_email_claimed;
  end if;
  if v_dashboard_claimed <> 0 then
    raise exception 'FAIL: claim_notifications handed out % dashboard row(s)', v_dashboard_claimed;
  end if;

  -- ...and the fixture's dashboard row is left exactly as it was.
  if not exists (
    select 1 from public.notifications
    where business_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      and channel = 'dashboard'
      and dedupe_key like 'handover:' || v_conv::text || ':%'
      and status = 'pending'
      and attempts = 0
  ) then
    raise exception 'FAIL: the dashboard notification was touched by the claim';
  end if;

  -- Handing back to the AI resets the escalation state.
  perform public.resume_ai(v_conv);
  if (select status from public.conversations where id = v_conv) <> 'active' then
    raise exception 'FAIL: resume_ai did not reactivate the thread';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Analytics rollup is idempotent and attributes to the right tenant.
-- -----------------------------------------------------------------------------
do $$
declare
  v_row public.analytics_daily;
begin
  perform public.rollup_analytics_daily(
    'aaaaaaaa-0000-0000-0000-000000000001', (now() at time zone 'Europe/London')::date
  );
  perform public.rollup_analytics_daily(
    'aaaaaaaa-0000-0000-0000-000000000001', (now() at time zone 'Europe/London')::date
  );

  select * into v_row from public.analytics_daily
  where business_id = 'aaaaaaaa-0000-0000-0000-000000000001';

  if (select count(*) from public.analytics_daily
      where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FAIL: rollup is not idempotent';
  end if;
  if v_row.messages_outbound <> 2 then
    raise exception 'FAIL: rollup outbound = % (expected 2)', v_row.messages_outbound;
  end if;
  if v_row.ai_handled_pct <> 100.00 then
    raise exception 'FAIL: ai_handled_pct = % (expected 100)', v_row.ai_handled_pct;
  end if;
  if v_row.calls_missed <> 1 then
    raise exception 'FAIL: calls_missed = % (expected 1)', v_row.calls_missed;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Tenant isolation under RLS. This is the assertion that matters most.
-- -----------------------------------------------------------------------------
set local role authenticated;

-- Tenant A's owner sees their own data.
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

do $$
begin
  if (select count(*) from public.businesses) <> 1 then
    raise exception 'FAIL: owner A sees % businesses (expected 1)',
      (select count(*) from public.businesses);
  end if;
  if (select count(*) from public.conversations) < 1 then
    raise exception 'FAIL: owner A cannot see their own conversations';
  end if;
  if (select count(*) from public.leads) <> 1 then
    raise exception 'FAIL: owner A cannot see their own lead';
  end if;
  if (select count(*) from public.business_ai_context) <> 1 then
    raise exception 'FAIL: business_ai_context leaked or is empty for owner A';
  end if;
end;
$$;

-- Tenant B's owner must see none of it.
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

do $$
begin
  if (select count(*) from public.conversations) <> 0 then
    raise exception 'ISOLATION FAILURE: tenant B sees % of tenant A''s conversations',
      (select count(*) from public.conversations);
  end if;
  if (select count(*) from public.messages) <> 0 then
    raise exception 'ISOLATION FAILURE: tenant B sees tenant A''s messages';
  end if;
  if (select count(*) from public.leads) <> 0 then
    raise exception 'ISOLATION FAILURE: tenant B sees tenant A''s leads';
  end if;
  if (select count(*) from public.contacts) <> 0 then
    raise exception 'ISOLATION FAILURE: tenant B sees tenant A''s contacts';
  end if;
  if (select count(*) from public.calls) <> 0 then
    raise exception 'ISOLATION FAILURE: tenant B sees tenant A''s call log';
  end if;
  if (select count(*) from public.services) <> 0 then
    raise exception 'ISOLATION FAILURE: tenant B sees tenant A''s services';
  end if;
  if (select count(*) from public.analytics_daily) <> 0 then
    raise exception 'ISOLATION FAILURE: tenant B sees tenant A''s analytics';
  end if;

  -- The views are tenant-scoped, not empty: tenant B must see exactly its own
  -- row and none of tenant A's. Asserting "zero rows" here would be wrong and
  -- would pass even if the view were broken open in the other direction.
  if (select count(*) from public.business_ai_context) <> 1 then
    raise exception 'FAIL: tenant B should see exactly its own AI context, saw %',
      (select count(*) from public.business_ai_context);
  end if;
  if exists (select 1 from public.business_ai_context
             where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'ISOLATION FAILURE: business_ai_context leaked tenant A';
  end if;

  if exists (select 1 from public.dashboard_today
             where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'ISOLATION FAILURE: dashboard_today leaked tenant A';
  end if;
  if (select coalesce(sum(calls_missed), 0) from public.dashboard_today) <> 0 then
    raise exception 'ISOLATION FAILURE: dashboard_today leaked tenant A''s call counts';
  end if;

  if exists (select 1 from public.handover_queue
             where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'ISOLATION FAILURE: handover_queue leaked tenant A';
  end if;

  if exists (select 1 from public.business_theme
             where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') then
    raise exception 'ISOLATION FAILURE: business_theme leaked tenant A';
  end if;
end;
$$;

-- The service-role RPC surface must be unreachable from a tenant session.
do $$
begin
  begin
    perform public.resolve_inbound('+441134960001', '+447700900999');
    raise exception 'PRIVILEGE FAILURE: authenticated could call resolve_inbound';
  exception when insufficient_privilege then
    null;  -- expected
  end;
end;
$$;

-- A viewer must not be able to write, and must not be able to forge a message.
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';

do $$
declare
  v_conv uuid;
begin
  select id into v_conv from public.conversations limit 1;
  if v_conv is null then
    raise exception 'FAIL: viewer cannot read conversations they should see';
  end if;

  begin
    insert into public.messages (conversation_id, business_id, direction, sender, body, sent_by_user_id)
    values (v_conv, 'aaaaaaaa-0000-0000-0000-000000000001', 'outbound', 'human',
            'viewer should not be able to send', '33333333-3333-3333-3333-333333333333');
    raise exception 'PRIVILEGE FAILURE: viewer inserted a message';
  exception when insufficient_privilege then
    null;  -- expected: RLS WITH CHECK rejected it
  end;

  begin
    update public.services set name = 'tampered'
    where business_id = 'aaaaaaaa-0000-0000-0000-000000000001';
    -- An UPDATE filtered out by RLS affects 0 rows rather than raising.
    if found then
      raise exception 'PRIVILEGE FAILURE: viewer updated a service';
    end if;
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- -----------------------------------------------------------------------------
-- 7. GDPR erasure removes every identifier but keeps the aggregate history.
-- -----------------------------------------------------------------------------
do $$
declare
  v_contact uuid;
  v_result jsonb;
  v_calls_before int;
begin
  -- The missed-call caller from section 1, whose thread section 2 wrote to.
  -- Chosen by number: section 1 also creates contacts with no messages, so an
  -- unordered `limit 1` could pick one of those and the test would prove nothing.
  select id into strict v_contact from public.contacts
  where business_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    and phone = '+447700900123';

  select count(*) into v_calls_before from public.calls
  where business_id = 'aaaaaaaa-0000-0000-0000-000000000001';

  v_result := public.erase_contact('aaaaaaaa-0000-0000-0000-000000000001', v_contact);

  if (v_result ->> 'messages_redacted')::int < 3 then
    raise exception 'FAIL: expected >=3 messages redacted, got %', v_result ->> 'messages_redacted';
  end if;

  if exists (
    select 1 from public.messages m
    join public.conversations c on c.id = m.conversation_id
    where c.contact_id = v_contact and m.body <> '[erased at data subject request]'
  ) then
    raise exception 'FAIL: message bodies survived erasure';
  end if;

  if exists (select 1 from public.contacts where id = v_contact and phone is not null) then
    raise exception 'FAIL: contact phone survived erasure';
  end if;

  if exists (select 1 from public.leads where contact_id = v_contact and name is not null) then
    raise exception 'FAIL: lead name survived erasure';
  end if;

  -- Aggregate history is a legitimate interest and must be preserved.
  if (select count(*) from public.calls
      where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') <> v_calls_before then
    raise exception 'FAIL: erasure destroyed the call count';
  end if;
  if (select count(*) from public.analytics_daily
      where business_id = 'aaaaaaaa-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FAIL: erasure destroyed the analytics rollup';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Audit trail captured the configuration changes.
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.audit_logs
      where business_id = 'aaaaaaaa-0000-0000-0000-000000000001'
        and entity_type = 'services') < 2 then
    raise exception 'FAIL: service inserts were not audited';
  end if;

  if not exists (
    select 1 from public.audit_logs
    where entity_type = 'contacts' and action = 'erase'
  ) then
    raise exception 'FAIL: erasure was not audited';
  end if;
end;
$$;

rollback;

\echo 'functional tests passed'
