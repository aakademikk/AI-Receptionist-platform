-- =============================================================================
-- Rebrand the demo tenant: Parkfords Property Management → VOLTA
-- =============================================================================
-- NOT A MIGRATION. This is tenant *data*, not schema, and it belongs to one
-- disposable demo tenant. It lives in `one-off/` rather than `migrations/` so
-- that no tool ever replays it against a fresh database — a new environment
-- gets its tenant from `supabase/seed.sql`, which carries the same copy.
--
-- Why: the demo number borrowed the Parkfords name so the receptionist had
-- something to be. Parkfords do not use this service and nothing of theirs
-- depends on the tenant. Colin wants it on an electrician "so we have something
-- to show", and VOLTA is already ours — a fictional electrician built as a 3D
-- demo site (`/home/col/Atwood_demos/volta-electric`, live at
-- https://volta-electric-demo.vercel.app), with its own tagline, services,
-- prices, coverage list and a reserved `01632` drama-range phone number. So the
-- receptionist demo and the website demo show the same firm rather than two
-- unrelated fictions.
--
-- Everything below is transcribed from that site's `src/config.ts` rather than
-- invented here, so the two cannot drift on the facts a caller might be told.
--
-- Safe to run once, and only once. The whole thing is in a transaction: if any
-- statement fails, nothing is applied. Run it in the Supabase SQL editor.
--
-- What it does NOT touch: `business_settings` (the tenant reads
-- google/gemini-3.8-flash on both column pairs in the live database and that is
-- a deliberate choice, not Parkfords drift), `phone_numbers` (the number, its
-- webhooks and its `answer_mode` are all unchanged — this is a rename, not a
-- re-point), and `answer_mode`, which stays `conversational`.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Identity.
--
-- The slug changes from `parkfords` to `volta`, which changes the dashboard URL
-- (/app/volta/...). Nothing else resolves by slug, so this is a bookmark break
-- and not a routing one.
-- -----------------------------------------------------------------------------
update public.businesses set
  name = 'VOLTA Electrical Contractors',
  slug = 'volta'
where id = '10000000-0000-4000-8000-000000000001';

-- -----------------------------------------------------------------------------
-- Profile.
--
-- `voice_greeting_template` requires migration `0013` to have been applied
-- first. Without it this statement errors and the transaction rolls back — which
-- is the intended failure, not a surprise.
-- -----------------------------------------------------------------------------
update public.business_profiles set
  legal_name   = 'Volta Electrical Contractors Ltd (demo)',
  trading_name = 'VOLTA',
  tagline      = 'Electrical, wired properly.',
  description  = 'Certified electricians for rewires, EV chargers, lighting and consumer units. We wire it once, we wire it right — and we leave the place cleaner than we found it.',
  industry     = 'Electrical services',
  founded_year = null,
  website_url  = 'https://volta-electric-demo.vercel.app',
  email        = 'hello@volta.example',
  phone        = '+441632960489',
  address_line1 = null,
  city         = 'Southend-on-Sea',
  region       = 'Essex',
  postcode     = null,
  country      = 'United Kingdom',

  -- VOLTA's own palette, light-mode values from the demo site's index.css.
  -- The four columns are hex-only with a check constraint, so the dark-mode
  -- teal (#2de2c0) is not usable as a background-adjacent value; these are the
  -- light-mode pair, which is what a dashboard surface wants.
  brand_primary    = '#0d9a83',
  brand_accent     = '#0ab3a0',
  brand_background = '#faf7f0',
  brand_foreground = '#191a17',

  tone_of_voice = 'warm, professional, plain-spoken; no jargon; never pushy',

  -- The assistant's name. Set here rather than inherited, because this script is the
  -- full definition of the demo tenant: it replaced Parkfords' row wholesale, and
  -- Parkfords' assistant was not called Amy. The first apply (18:44 on 2026-09-16)
  -- shipped the name the old row carried — `Robin` — and the rename to Amy was made
  -- the same evening. Recorded rather than quietly corrected: the greeting below is
  -- unchanged by the rename because it reads the placeholder, not the name.
  ai_assistant_name = 'Amy',

  -- The greeting. {business_name} resolves to trading_name, so this is heard as
  -- "Hello, you've reached VOLTA."
  voice_greeting_template = 'Hello, you''ve reached {{business_name}}. I''m {{assistant_name}}, the automated assistant. How can I help today?',

  -- The SMS missed-call line stays as it is: it is brand-neutral, it uses the
  -- placeholders, and it is the one place where apologising for a missed call is
  -- the right thing to say.

  custom_instructions =
    'Electrical emergencies first. If a caller mentions a burning smell, smoke, exposed or damaged wiring, a shock, water near electrics, or a total loss of power, treat it as an emergency, take their details and escalate immediately — do not attempt to triage it yourself.'
    || E'\n\n'
    || 'Never quote a price as final. Published "from" prices and the estimate bands are fine to repeat, and you must always say a fixed price follows a survey and is agreed in writing before any work starts. Never give a price for a job that is not on the published list — take the details and say someone will come back with a figure.'
    || E'\n\n'
    || 'We cover Southend, Rayleigh, Basildon, Wickford, Chelmsford, Brentwood, Billericay, Rochford, Benfleet, Canvey, Maldon and Braintree. For anywhere else, take the details rather than turning the job down — bigger jobs travel.'
where business_id = '10000000-0000-4000-8000-000000000001';

-- -----------------------------------------------------------------------------
-- Services.
--
-- Verbatim from the demo site's `services.items`. `on delete set null` on
-- `appointments.service_id` means any demo appointment survives without a
-- service link rather than blocking this.
-- -----------------------------------------------------------------------------
delete from public.services where business_id = '10000000-0000-4000-8000-000000000001';

insert into public.services
  (business_id, name, description, category, price_text, duration_minutes, is_bookable, sort_order)
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
   'Commercial', 'on survey', null, false, 6);

-- -----------------------------------------------------------------------------
-- Coverage — the demo site's twelve towns.
-- -----------------------------------------------------------------------------
delete from public.service_areas where business_id = '10000000-0000-4000-8000-000000000001';

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
  ('10000000-0000-4000-8000-000000000001', 'Braintree',  array['CM7','CM77'], 25, 12);

-- -----------------------------------------------------------------------------
-- Opening hours — a trade's week, not an office's. 0 = Sunday.
-- -----------------------------------------------------------------------------
delete from public.opening_hours where business_id = '10000000-0000-4000-8000-000000000001';

insert into public.opening_hours (business_id, day_of_week, opens_at, closes_at, is_closed)
values
  ('10000000-0000-4000-8000-000000000001', 0, null,    null,    true),
  ('10000000-0000-4000-8000-000000000001', 1, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 2, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 3, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 4, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 5, '08:00', '17:00', false),
  ('10000000-0000-4000-8000-000000000001', 6, '09:00', '13:00', false);

-- -----------------------------------------------------------------------------
-- Knowledge.
--
-- Only `kind in ('faq','policy','about','hours_note','pricing_note')` reaches the
-- prompt, and only when published and not flagged for review. The price bands are
-- the demo site's own estimate ranges and are labelled as estimates here for the
-- same reason they are on the site: they are not a quote.
-- -----------------------------------------------------------------------------
delete from public.knowledge_items where business_id = '10000000-0000-4000-8000-000000000001';

insert into public.knowledge_items (business_id, kind, title, content, sort_order)
values
  ('10000000-0000-4000-8000-000000000001', 'about', 'About VOLTA',
   'VOLTA is an electrical contractor working across Essex. We do domestic and commercial work — from an extra socket to a full commercial fit-out — and every job is tested and certified, whatever its size. NICEIC-approved, 18th Edition, public liability insured.',
   1),
  ('10000000-0000-4000-8000-000000000001', 'faq', 'Are you certified?',
   'Yes. We are NICEIC-approved and work to the 18th Edition wiring regulations, with public liability insurance. Every job is tested and you get the certificate.',
   2),
  ('10000000-0000-4000-8000-000000000001', 'policy', 'Is there a call-out fee?',
   'No call-out fee. We agree a fixed price in writing before any work starts, and it does not move unless you change the job.',
   3),
  ('10000000-0000-4000-8000-000000000001', 'pricing_note', 'What does a job cost?',
   'Ballpark estimates: a full rewire £2,200–£5,400; a consumer unit swap £850–£1,400; a 7kW EV charger installed £900–£1,500; lighting £220–£1,800 depending on the scheme; an EICR £150–£380 per property; small works typically £90–£600. These are estimates, not quotes — the fixed price is agreed after a survey. Anything bigger than a socket gets a free visit.',
   4),
  ('10000000-0000-4000-8000-000000000001', 'faq', 'How quickly can you come out?',
   'Standard booking is usually the next few weeks. If you need it within the week we hold priority slots, and genuine emergencies are same or next day.',
   5),
  ('10000000-0000-4000-8000-000000000001', 'faq', 'What counts as an emergency?',
   'A burning smell or smoke, exposed or damaged wiring, an electric shock, water near electrics, or a total loss of power. Ring immediately rather than booking online.',
   6),
  ('10000000-0000-4000-8000-000000000001', 'hours_note', 'When are you open?',
   'Monday to Friday, 8am to 5pm, and Saturday 9am to 1pm. Emergency cover runs same or next day.',
   7),
  ('10000000-0000-4000-8000-000000000001', 'policy', 'Where do you work?',
   'Southend, Rayleigh, Basildon, Wickford, Chelmsford, Brentwood, Billericay, Rochford, Benfleet, Canvey, Maldon and Braintree. If you are outside that list, still get in touch — we travel for bigger jobs and we will tell you straight if it does not make sense.',
   8);

commit;
