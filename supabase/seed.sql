-- =============================================================================
-- seed.sql — local development fixture
-- =============================================================================
-- One fully-configured demo tenant so the dashboard has something to render and
-- the n8n workflows have something to route to. Runs automatically on
-- `supabase db reset`.
--
-- The tenant is Parkfords Property Management, matching the example in the brief.
-- Numbers are in Ofcom's reserved-for-drama range (+4411349600xx) so nothing here
-- can dial a real person.
-- =============================================================================

-- A dev login: dev@atwood.systems. Sign in at /login — the app is magic-link only,
-- so there is no password here; the link is caught by Inbucket on :54324 locally.
-- email_confirmed_at is set so GoTrue treats the address as already verified.
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
values (
  '00000000-0000-4000-8000-000000000001',
  'dev@atwood.systems',
  '{"full_name": "Dev Owner"}'::jsonb,
  now()
)
on conflict (id) do nothing;

insert into public.businesses (id, slug, name, status, plan, timezone, default_region)
values (
  '10000000-0000-4000-8000-000000000001',
  'parkfords',
  'Parkfords Property Management',
  'active',
  'growth',
  'Europe/London',
  'GB'
)
on conflict (id) do nothing;

insert into public.memberships (business_id, user_id, role, accepted_at)
values (
  '10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'owner',
  now()
)
on conflict (business_id, user_id) do nothing;

-- The profile row was auto-created by trigger; fill it in.
update public.business_profiles set
  legal_name = 'Parkfords Property Management Ltd',
  trading_name = 'Parkfords Property Management',
  tagline = 'Block and estate management across West Yorkshire',
  description = 'Parkfords is an independent property management firm looking after residential blocks, estates and lettings across Leeds and the surrounding area. Established 2009.',
  industry = 'Property Management',
  founded_year = 2009,
  website_url = 'https://parkfords.example.com',
  email = 'hello@parkfords.example.com',
  phone = '+441134960001',
  address_line1 = '14 Wellington Place',
  city = 'Leeds',
  region = 'West Yorkshire',
  postcode = 'LS1 4AP',
  country = 'United Kingdom',
  brand_primary = '#12324A',
  brand_accent = '#C9873D',
  tone_of_voice = 'warm, professional, plain-spoken; no jargon; never pushy',
  ai_assistant_name = 'Robin',
  greeting_template = 'Hi, thanks for contacting {{business_name}}. We''re sorry we missed your call. How can we help today?',
  signature = '— {{assistant_name}} at {{business_name}}',
  custom_instructions = 'If a caller mentions a leak, flood, fire, gas smell or anything that sounds like it could damage property or hurt someone, treat it as an emergency and escalate immediately. Do not attempt to triage it yourself.'
where business_id = '10000000-0000-4000-8000-000000000001';

update public.business_settings set
  ai_provider = 'anthropic',
  ai_model = 'claude-opus-5',
  ai_effort = 'low',
  missed_call_template = 'Hi, thanks for contacting {{business_name}}. We''re sorry we missed your call. How can we help today?',
  after_hours_template = 'Thanks for contacting {{business_name}}. Our office is closed right now, but tell me what you need and I''ll make sure someone picks it up first thing.',
  booking_enabled = true,
  booking_provider = 'google_calendar',
  booking_slot_minutes = 30,
  notify_events = array['missed_call','lead_captured','lead_qualified','handover_required','appointment_booked']::notification_event[],
  notify_channels = array['email','dashboard']::notification_channel[]
where business_id = '10000000-0000-4000-8000-000000000001';

insert into public.phone_numbers (business_id, e164, friendly_name, channels, is_primary, forward_to)
values
  ('10000000-0000-4000-8000-000000000001', '+441134960001', 'Main line',
   array['sms','voice']::comms_channel[], true, '+441134960099'),
  ('10000000-0000-4000-8000-000000000001', '+441134960011', 'WhatsApp',
   array['whatsapp']::comms_channel[], false, null)
on conflict (e164) do nothing;

insert into public.services (business_id, name, description, category, price_text, duration_minutes, is_bookable, sort_order)
values
  ('10000000-0000-4000-8000-000000000001', 'Block Management',
   'Full management of residential blocks: service charge collection, contractor management, statutory compliance and Section 20 consultation.',
   'Management', 'from £45 per unit per month', null, false, 1),
  ('10000000-0000-4000-8000-000000000001', 'Estate Management',
   'Grounds, communal areas and shared infrastructure for freehold estates.',
   'Management', 'from £28 per unit per month', null, false, 2),
  ('10000000-0000-4000-8000-000000000001', 'Property Valuation',
   'Market appraisal for sale or lettings, carried out in person by a MRICS surveyor.',
   'Advisory', 'Free, no obligation', 45, true, 3),
  ('10000000-0000-4000-8000-000000000001', 'Lettings Management',
   'Tenant find, referencing, rent collection and periodic inspections.',
   'Lettings', '9% of monthly rent (+VAT)', null, false, 4),
  ('10000000-0000-4000-8000-000000000001', 'Compliance Audit',
   'Fire risk, asbestos, legionella and EICR review with a prioritised action plan.',
   'Compliance', 'POA', 90, true, 5)
on conflict (business_id, name) do nothing;

insert into public.service_areas (business_id, name, postcode_prefixes, radius_miles, sort_order)
values
  ('10000000-0000-4000-8000-000000000001', 'Leeds',
   array['LS1','LS2','LS3','LS4','LS5','LS6','LS7','LS8','LS11','LS12'], 12, 1),
  ('10000000-0000-4000-8000-000000000001', 'Wakefield',
   array['WF1','WF2','WF3','WF4'], 10, 2),
  ('10000000-0000-4000-8000-000000000001', 'Bradford',
   array['BD1','BD2','BD3','BD4','BD5'], 10, 3)
on conflict (business_id, name) do nothing;

-- Mon–Fri 9–5:30, Sat morning, closed Sunday.
insert into public.opening_hours (business_id, day_of_week, opens_at, closes_at, is_closed)
values
  ('10000000-0000-4000-8000-000000000001', 0, null, null, true),
  ('10000000-0000-4000-8000-000000000001', 1, '09:00', '17:30', false),
  ('10000000-0000-4000-8000-000000000001', 2, '09:00', '17:30', false),
  ('10000000-0000-4000-8000-000000000001', 3, '09:00', '17:30', false),
  ('10000000-0000-4000-8000-000000000001', 4, '09:00', '17:30', false),
  ('10000000-0000-4000-8000-000000000001', 5, '09:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 6, '09:30', '12:30', false)
on conflict (business_id, day_of_week) do nothing;

insert into public.knowledge_items (business_id, kind, title, content, sort_order)
values
  ('10000000-0000-4000-8000-000000000001', 'faq',
   'How quickly do you respond to maintenance issues?',
   'Emergencies (leaks, loss of power, anything unsafe) are attended within 4 hours, 24/7. Urgent non-emergency issues are attended within 2 working days. Routine issues are scheduled within 10 working days.', 1),
  ('10000000-0000-4000-8000-000000000001', 'faq',
   'Do you handle service charge disputes?',
   'Yes. We prepare the statutory documentation, handle correspondence with leaseholders, and can represent the freeholder at First-tier Tribunal if it gets that far.', 2),
  ('10000000-0000-4000-8000-000000000001', 'faq',
   'Can you take over management from another agent?',
   'Yes, and it is a large part of what we do. We handle the handover paperwork and the transfer of funds and records. Typical changeover takes 4 to 6 weeks.', 3),
  ('10000000-0000-4000-8000-000000000001', 'faq',
   'What is your notice period?',
   'Three months, with no exit fee. We do not lock clients into long contracts.', 4),
  ('10000000-0000-4000-8000-000000000001', 'policy',
   'Out of hours emergencies',
   'The emergency line is staffed 24/7 for genuine emergencies only: uncontrolled water, gas smell, fire damage, total power loss to communal areas, or anything presenting a risk to safety. Everything else is handled the next working day.', 5),
  ('10000000-0000-4000-8000-000000000001', 'about',
   'About Parkfords',
   'Founded in 2009 by two chartered surveyors, Parkfords manages just over 4,000 units across West Yorkshire. We are deliberately independent and deliberately mid-sized: large enough to have in-house compliance and accounts teams, small enough that clients speak to the same manager every time. RICS regulated and TPI member.', 6)
on conflict do nothing;

insert into public.notification_recipients (business_id, user_id, channel, destination, label)
values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'email', 'dev@atwood.systems', 'Owner email'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'dashboard', 'in-app', 'In-app')
on conflict (business_id, channel, destination) do nothing;

-- -----------------------------------------------------------------------------
-- A worked example conversation, so the dashboard is not empty on first run.
-- -----------------------------------------------------------------------------
do $$
declare
  v_missed record;
  v_conv uuid;
begin
  select * into v_missed from public.record_missed_call(
    '+441134960001', '+447700900123', 'CAseed0000000001', 'no-answer', now() - interval '38 minutes'
  );
  v_conv := v_missed.conversation_id;

  perform public.append_message(
    v_conv, 'outbound', 'ai',
    'Hi, thanks for contacting Parkfords Property Management. We''re sorry we missed your call. How can we help today?',
    'sms', 'twilio', 'SMseed001', 'delivered'
  );

  perform public.append_message(
    v_conv, 'inbound', 'customer',
    'Hi — we''re the RMC for a 24-flat block in LS6 and we''re unhappy with our current managing agent. Wanted to see what you''d charge.',
    'sms', 'twilio', 'SMseed002', 'received'
  );

  perform public.append_message(
    v_conv, 'outbound', 'ai',
    'Happy to help — taking over from another agent is a big part of what we do. Block management starts from £45 per unit per month, so I can get you a proper figure once we know the scope. Could I take your name, and is the block LS6 something you''d want us to look at in person?',
    'sms', 'twilio', 'SMseed003', 'delivered'
  );

  perform public.append_message(
    v_conv, 'inbound', 'customer',
    'It''s Marcus Reed, chair of the RMC. Yes please — postcode is LS6 2AH. Best to call me after 5pm.',
    'sms', 'twilio', 'SMseed004', 'received'
  );

  perform public.upsert_lead(v_conv, jsonb_build_object(
    'name', 'Marcus Reed',
    'phone', '+447700900123',
    'email', '',
    'postcode', 'LS6 2AH',
    'service', 'Block Management',
    'enquiry', 'RMC for a 24-flat block in LS6, unhappy with current managing agent, wants a quote and a site visit.',
    'summary', 'RMC chair for 24-flat block in LS6 looking to switch managing agent. Wants a quote; prefers a callback after 5pm.',
    'urgency', 'normal',
    'lead_status', 'qualified',
    'callback_time', 'after 5pm'
  ));

  update public.conversations
  set summary = 'RMC chair for a 24-flat LS6 block wants to switch managing agent. Quote requested; callback after 5pm.',
      current_topic = 'block management quote / agent switch'
  where id = v_conv;

  -- A second thread, escalated, so the handover queue has a row.
  select * into v_missed from public.record_missed_call(
    '+441134960001', '+447700900456', 'CAseed0000000002', 'busy', now() - interval '12 minutes'
  );

  perform public.append_message(
    v_missed.conversation_id, 'outbound', 'ai',
    'Hi, thanks for contacting Parkfords Property Management. We''re sorry we missed your call. How can we help today?',
    'sms', 'twilio', 'SMseed005', 'delivered'
  );

  perform public.append_message(
    v_missed.conversation_id, 'inbound', 'customer',
    'There is water coming through the ceiling of the communal stairwell and it''s getting worse. I need someone NOW.',
    'sms', 'twilio', 'SMseed006', 'received'
  );

  perform public.request_handover(
    v_missed.conversation_id, 'emergency',
    'Active water ingress reported in a communal area — matched the emergency rule in the tenant''s custom instructions.'
  );

  perform public.enqueue_notification(
    '10000000-0000-4000-8000-000000000001', 'handover_required',
    'Emergency: water ingress in communal stairwell',
    'A caller reports active water ingress getting worse. The AI has stepped back and the thread is waiting for a human.',
    '{}'::jsonb, v_missed.conversation_id, null, null,
    'seed-handover:' || v_missed.conversation_id::text
  );
end;
$$;

-- Seal today's rollup so the analytics page has a data point.
select public.rollup_analytics_daily(
  '10000000-0000-4000-8000-000000000001',
  (now() at time zone 'Europe/London')::date
);
