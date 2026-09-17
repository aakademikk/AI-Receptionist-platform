-- =============================================================================
-- seed.sql — local development fixture
-- =============================================================================
-- One fully-configured demo tenant so the dashboard has something to render and
-- the n8n workflows have something to route to. Runs automatically on
-- `supabase db reset`.
--
-- The tenant is VOLTA, a fictional electrical contractor — the same firm as the 3D
-- demo site at /home/col/Atwood_demos/volta-electric (live at
-- volta-electric-demo.vercel.app). The services, prices, coverage list and contact
-- details below are transcribed from that site's src/config.ts rather than invented
-- here, so the receptionist demo and the website demo cannot drift on anything a
-- caller might be told.
--
-- It used to be a property manager named after a real client. That is a bad
-- fixture: a demo gets shown to strangers, and the strangers are often in the same
-- trade as the name on it.
--
-- Numbers are in Ofcom's reserved-for-drama range (+4411349600xx) so nothing here
-- can dial a real person, and the email uses `.example`, which can never resolve.
-- =============================================================================

-- A dev login: dev@atwood.systems. Sign in at /login — the app is magic-link only,
-- so there is no password here; local mail is caught, not sent — read it on :54324.
--
-- `instance_id` and `aud` are load-bearing, not decoration. GoTrue finds an account
-- with roughly
--     instance_id = '00000000-…' and lower(email) = ? and aud = 'authenticated'
-- so a row missing either column is invisible to sign-in — and because
-- signInWithOtp creates a user when it finds none, the magic link silently produces a
-- *second* account with a different id. That one owns no membership, so the sign-in
-- appears to succeed and lands on "You are not a member of any business yet".
--
-- `email_confirmed_at` marks the address already verified.
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'dev@atwood.systems',
  now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  '{"full_name": "Dev Owner"}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

/*
 * GoTrue reads several of auth.users' token columns into non-nullable Go strings, so a
 * NULL in any of them fails to scan — the request errors out with something opaque
 * rather than anything mentioning the column. Postgres defaults cover this for rows
 * GoTrue creates itself; a row inserted by hand has to do it deliberately.
 *
 * This is the failure mode that replaces the invisible-user one: once the account can
 * be found, it gets read, and then the NULLs matter. Symptom is a sign-in that errors
 * for this address only, while any other address works fine.
 *
 * Driven off information_schema because the column set differs across GoTrue versions
 * and naming a column that does not exist would fail the whole seed.
 */
do $$
declare
  v_col text;
begin
  for v_col in
    select column_name
    from information_schema.columns
    where table_schema = 'auth'
      and table_name = 'users'
      and is_nullable = 'YES'
      and data_type in ('character varying', 'text')
      and column_name in (
        'confirmation_token',
        'recovery_token',
        'email_change',
        'email_change_token_new',
        'email_change_token_current',
        'phone_change',
        'phone_change_token',
        'reauthentication_token'
      )
  loop
    execute format(
      'update auth.users set %1$I = %2$L where id = %3$L and %1$I is null',
      v_col, '', '00000000-0000-4000-8000-000000000001'
    );
  end loop;
end $$;

/*
 * The matching identity row. A bare `auth.users` row is enough to be found, but an
 * email-provider account is expected to have an identity, and its absence shows up
 * later in account linking and in the `identities` claim.
 *
 * The table's shape has changed across GoTrue versions — older releases keyed it by
 * `id text` holding the provider id, newer ones added a `provider_id` column and made
 * `id` a defaulted uuid — so this adapts instead of pinning one version's columns and
 * breaking on the other.
 */
do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000001';
  v_identity jsonb := jsonb_build_object(
    'sub', '00000000-0000-4000-8000-000000000001',
    'email', 'dev@atwood.systems',
    'email_verified', true
  );
begin
  if to_regclass('auth.identities') is null then
    return;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id'
  ) then
    insert into auth.identities (
      provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    )
    values (v_user::text, v_user, v_identity, 'email', now(), now(), now())
    on conflict do nothing;
  else
    insert into auth.identities (
      id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    )
    values (v_user::text, v_user, v_identity, 'email', now(), now(), now())
    on conflict do nothing;
  end if;
end $$;

insert into public.businesses (id, slug, name, status, plan, timezone, default_region)
values (
  '10000000-0000-4000-8000-000000000001',
  'volta',
  'VOLTA Electrical Contractors',
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
  legal_name = 'Volta Electrical Contractors Ltd (demo)',
  trading_name = 'VOLTA',
  tagline = 'Electrical, wired properly.',
  description = 'Certified electricians for rewires, EV chargers, lighting and consumer units. We wire it once, we wire it right — and we leave the place cleaner than we found it.',
  industry = 'Electrical services',
  founded_year = null,
  website_url = 'https://volta-electric-demo.vercel.app',
  email = 'hello@volta.example',
  phone = '+441632960489',
  address_line1 = null,
  city = 'Southend-on-Sea',
  region = 'Essex',
  postcode = null,
  country = 'United Kingdom',
  -- The demo site's own palette, light-mode values from its index.css.
  brand_primary = '#0d9a83',
  brand_accent = '#0ab3a0',
  brand_background = '#faf7f0',
  brand_foreground = '#191a17',
  tone_of_voice = 'warm, professional, plain-spoken; no jargon; never pushy',
  ai_assistant_name = 'Amy',
  -- The SMS missed-call line, and the one place apologising for a missed call is right.
  greeting_template = 'Hi, thanks for contacting {{business_name}}. We''re sorry we missed your call. How can we help today?',
  -- Spoken on an answered call, so it must not apologise for a missed one. Set explicitly
  -- rather than left NULL so the demo tenant carries the line an owner would edit.
  voice_greeting_template = 'Hello, you''ve reached {{business_name}}. I''m {{assistant_name}}, the automated assistant. How can I help today?',
  signature = '— {{assistant_name}} at {{business_name}}',
  custom_instructions = 'Electrical emergencies first. If a caller mentions a burning smell, smoke, exposed or damaged wiring, a shock, water near electrics, or a total loss of power, treat it as an emergency, take their details and escalate immediately — do not attempt to triage it yourself.'
    || E'\n\n'
    || 'Never quote a price as final. Published "from" prices and the estimate bands are fine to repeat, and you must always say a fixed price follows a survey and is agreed in writing before any work starts. Never give a price for a job that is not on the published list — take the details and say someone will come back with a figure.'
    || E'\n\n'
    || 'We cover Southend, Rayleigh, Basildon, Wickford, Chelmsford, Brentwood, Billericay, Rochford, Benfleet, Canvey, Maldon and Braintree. For anywhere else, take the details rather than turning the job down — bigger jobs travel.'
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
  ('10000000-0000-4000-8000-000000000001', 'Rewires & fuseboards',
   'Full and partial rewires, consumer unit upgrades to current 18th Edition regs.',
   'Rewires', 'from £850', null, false, 1),
  ('10000000-0000-4000-8000-000000000001', 'EV chargers',
   'Home and workplace charge points — supply checked and sized before we quote.',
   'EV', 'from £900', null, true, 2),
  ('10000000-0000-4000-8000-000000000001', 'Lighting design',
   'Downlights, garden, emergency and feature lighting, designed then installed.',
   'Lighting', 'from £220', null, true, 3),
  ('10000000-0000-4000-8000-000000000001', 'Testing & certificates',
   'EICRs, landlord certificates, periodic inspections and fault finding.',
   'Testing', 'from £150', 60, true, 4),
  ('10000000-0000-4000-8000-000000000001', 'Sockets & repairs',
   'Extra sockets, faulty circuits, tripping breakers — usually a same-week visit.',
   'Repairs', 'from £90', null, true, 5),
  ('10000000-0000-4000-8000-000000000001', 'Commercial fit-out',
   'Offices, workshops and retail units — three-phase, distribution and emergency systems.',
   'Commercial', 'on survey', null, false, 6)
on conflict (business_id, name) do nothing;

insert into public.service_areas (business_id, name, postcode_prefixes, radius_miles, sort_order)
values
  ('10000000-0000-4000-8000-000000000001', 'Southend',   array['SS0','SS1','SS2','SS3'], 15, 1),
  ('10000000-0000-4000-8000-000000000001', 'Rayleigh',   array['SS6'], 15, 2),
  ('10000000-0000-4000-8000-000000000001', 'Basildon',   array['SS13','SS14','SS15','SS16'], 15, 3),
  ('10000000-0000-4000-8000-000000000001', 'Wickford',   array['SS11','SS12'], 15, 4),
  ('10000000-0000-4000-8000-000000000001', 'Chelmsford', array['CM1','CM2','CM3'], 20, 5),
  ('10000000-0000-4000-8000-000000000001', 'Brentwood',  array['CM13','CM14','CM15'], 20, 6),
  ('10000000-0000-4000-8000-000000000001', 'Billericay', array['CM11','CM12'], 15, 7),
  ('10000000-0000-4000-8000-000000000001', 'Rochford',   array['SS4'], 15, 8),
  ('10000000-0000-4000-8000-000000000001', 'Benfleet',   array['SS7'], 15, 9),
  ('10000000-0000-4000-8000-000000000001', 'Canvey',     array['SS8'], 15, 10),
  ('10000000-0000-4000-8000-000000000001', 'Maldon',     array['CM9'], 20, 11),
  ('10000000-0000-4000-8000-000000000001', 'Braintree',  array['CM7','CM77'], 25, 12)
on conflict (business_id, name) do nothing;

-- A trade's week, not an office's: Mon–Fri 8–5, Saturday morning, closed Sunday.
insert into public.opening_hours (business_id, day_of_week, opens_at, closes_at, is_closed)
values
  ('10000000-0000-4000-8000-000000000001', 0, null, null, true),
  ('10000000-0000-4000-8000-000000000001', 1, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 2, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 3, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 4, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 5, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 6, '09:00', '13:00', false)
on conflict (business_id, day_of_week) do nothing;

insert into public.knowledge_items (business_id, kind, title, content, sort_order)
values
  ('10000000-0000-4000-8000-000000000001', 'about',
   'About VOLTA',
   'VOLTA is an electrical contractor working across Essex. We do domestic and commercial work — from an extra socket to a full commercial fit-out — and every job is tested and certified, whatever its size. NICEIC-approved, 18th Edition, public liability insured.', 1),
  ('10000000-0000-4000-8000-000000000001', 'faq',
   'Are you certified?',
   'Yes. We are NICEIC-approved and work to the 18th Edition wiring regulations, with public liability insurance. Every job is tested and you get the certificate.', 2),
  ('10000000-0000-4000-8000-000000000001', 'policy',
   'Is there a call-out fee?',
   'No call-out fee. We agree a fixed price in writing before any work starts, and it does not move unless you change the job.', 3),
  ('10000000-0000-4000-8000-000000000001', 'pricing_note',
   'What does a job cost?',
   'Ballpark estimates: a full rewire £2,200–£5,400; a consumer unit swap £850–£1,400; a 7kW EV charger installed £900–£1,500; lighting £220–£1,800 depending on the scheme; an EICR £150–£380 per property; small works typically £90–£600. These are estimates, not quotes — the fixed price is agreed after a survey. Anything bigger than a socket gets a free visit.', 4),
  ('10000000-0000-4000-8000-000000000001', 'faq',
   'How quickly can you come out?',
   'Standard booking is usually the next few weeks. If you need it within the week we hold priority slots, and genuine emergencies are same or next day.', 5),
  ('10000000-0000-4000-8000-000000000001', 'faq',
   'What counts as an emergency?',
   'A burning smell or smoke, exposed or damaged wiring, an electric shock, water near electrics, or a total loss of power. Ring immediately rather than booking online.', 6),
  ('10000000-0000-4000-8000-000000000001', 'hours_note',
   'When are you open?',
   'Monday to Friday, 8am to 5pm, and Saturday 9am to 1pm. Emergency cover runs same or next day.', 7),
  ('10000000-0000-4000-8000-000000000001', 'policy',
   'Where do you work?',
   'Southend, Rayleigh, Basildon, Wickford, Chelmsford, Brentwood, Billericay, Rochford, Benfleet, Canvey, Maldon and Braintree. If you are outside that list, still get in touch — we travel for bigger jobs and we will tell you straight if it does not make sense.', 8)
on conflict do nothing;

insert into public.notification_recipients (business_id, user_id, channel, destination, label)
values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'email', 'colin@atwoodsystems.co.uk', 'Owner email'),
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
    'Hi, thanks for contacting VOLTA. We''re sorry we missed your call. How can we help today?',
    'sms', 'twilio', 'SMseed001', 'delivered'
  );

  perform public.append_message(
    v_conv, 'inbound', 'customer',
    'Hi, we''ve just bought a 1930s semi in SS2 and the survey flagged the wiring — it''s still on the old fuse board. What would a rewire cost?',
    'sms', 'twilio', 'SMseed002', 'received'
  );

  -- The reply the prompt is written to produce: a published band, an explicit "that is not a
  -- quote", and a question. It never lands on a single figure, because the fixed price is
  -- agreed after a survey and the tenant's custom instructions say so.
  perform public.append_message(
    v_conv, 'outbound', 'ai',
    'A full rewire usually comes in between £2,200 and £5,400 depending on the size of the house and how much access there is, and a consumer unit swap on its own runs £850 to £1,400. Those are estimates rather than a quote — the fixed price comes after a free survey and is agreed in writing before we start. Could I take your name, and is the house empty while the work happens or are you living in it?',
    'sms', 'twilio', 'SMseed003', 'delivered'
  );

  perform public.append_message(
    v_conv, 'inbound', 'customer',
    'It''s Dan Whitfield. We''re living in it — moving in next month. Postcode is SS2 5BX. Best to ring me after 6pm.',
    'sms', 'twilio', 'SMseed004', 'received'
  );

  perform public.upsert_lead(v_conv, jsonb_build_object(
    'name', 'Dan Whitfield',
    'phone', '+447700900123',
    'email', '',
    'postcode', 'SS2 5BX',
    'service', 'Rewires & fuseboards',
    'enquiry', 'Bought a 1930s semi in SS2, survey flagged the wiring and it is still on an old fuse board. Wants a rewire quote and a survey.',
    'summary', 'New homeowner in SS2 with a 1930s semi on an old fuse board, wants a rewire quote. Family will be living in the property during the work. Prefers a callback after 6pm.',
    'urgency', 'normal',
    'lead_status', 'qualified',
    'callback_time', 'after 6pm'
  ));

  update public.conversations
  set summary = 'New homeowner in SS2 wants a rewire quote on a 1930s semi. Survey requested; callback after 6pm.',
      current_topic = 'rewire quote / consumer unit'
  where id = v_conv;

  -- A second thread, escalated, so the handover queue has a row.
  select * into v_missed from public.record_missed_call(
    '+441134960001', '+447700900456', 'CAseed0000000002', 'busy', now() - interval '12 minutes'
  );

  perform public.append_message(
    v_missed.conversation_id, 'outbound', 'ai',
    'Hi, thanks for contacting VOLTA. We''re sorry we missed your call. How can we help today?',
    'sms', 'twilio', 'SMseed005', 'delivered'
  );

  perform public.append_message(
    v_missed.conversation_id, 'inbound', 'customer',
    'There''s a burning smell coming from the fuse board and the lights keep flickering. I''ve got two young kids in the house. I need someone NOW.',
    'sms', 'twilio', 'SMseed006', 'received'
  );

  perform public.request_handover(
    v_missed.conversation_id, 'emergency',
    'Burning smell from the consumer unit with flickering lights, children in the property — matched the electrical emergency rule in the tenant''s custom instructions.'
  );

  perform public.enqueue_notification(
    '10000000-0000-4000-8000-000000000001', 'handover_required',
    'Emergency: burning smell from the consumer unit',
    'A caller reports a burning smell from the fuse board with flickering lights, and young children in the property. The AI has stepped back and the thread is waiting for a human.',
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
