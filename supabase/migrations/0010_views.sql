-- =============================================================================
-- 0010 — Views
-- =============================================================================
-- Two kinds live here:
--
--   * Dashboard views — "today" metrics that must be live, so they read the hot
--     tables directly. Everything historical comes from analytics_daily instead,
--     which is why these views only ever scan one tenant-day of data.
--   * The AI context view — one row containing everything the prompt builder
--     needs, so loading a business profile is a single round trip instead of six.
--
-- All views are security_invoker: the caller's RLS applies, so a view can never
-- become an accidental way around tenant isolation.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Today, per tenant. Powers the dashboard stat row.
-- -----------------------------------------------------------------------------
create view public.dashboard_today
with (security_invoker = true) as
select
  b.id as business_id,
  (now() at time zone b.timezone)::date as local_day,

  (select count(*) from public.calls c
    where c.business_id = b.id
      and c.started_at >= date_trunc('day', now() at time zone b.timezone) at time zone b.timezone
  ) as calls_total,

  (select count(*) from public.calls c
    where c.business_id = b.id and c.is_missed
      and c.started_at >= date_trunc('day', now() at time zone b.timezone) at time zone b.timezone
  ) as calls_missed,

  (select count(*) from public.conversations cv
    where cv.business_id = b.id
      and cv.opened_at >= date_trunc('day', now() at time zone b.timezone) at time zone b.timezone
  ) as conversations_today,

  (select count(*) from public.conversations cv
    where cv.business_id = b.id and cv.status = 'waiting_for_human'
  ) as awaiting_human,

  (select count(*) from public.conversations cv
    where cv.business_id = b.id
      and cv.status in ('active', 'human_handling')
  ) as open_conversations,

  (select count(*) from public.leads l
    where l.business_id = b.id
      and l.created_at >= date_trunc('day', now() at time zone b.timezone) at time zone b.timezone
  ) as leads_today,

  (select count(*) from public.leads l
    where l.business_id = b.id
      and l.status in ('qualified', 'booked', 'won')
      and l.created_at >= date_trunc('day', now() at time zone b.timezone) at time zone b.timezone
  ) as qualified_today,

  (select count(*) from public.appointments a
    where a.business_id = b.id
      and a.starts_at >= now()
      and a.starts_at < now() + interval '7 days'
      and a.status in ('pending', 'confirmed')
  ) as appointments_next_7d,

  (select round(avg(cv.first_response_seconds)::numeric, 1)
    from public.conversations cv
    where cv.business_id = b.id
      and cv.first_response_seconds is not null
      and cv.opened_at >= date_trunc('day', now() at time zone b.timezone) at time zone b.timezone
  ) as avg_first_response_seconds,

  (select count(*) from public.notifications n
    where n.business_id = b.id and n.channel = 'dashboard' and n.read_at is null
  ) as unread_notifications
from public.businesses b
where b.deleted_at is null;

comment on view public.dashboard_today is
  'Live today-metrics per tenant. Historical trends come from analytics_daily.';

grant select on public.dashboard_today to authenticated;

-- -----------------------------------------------------------------------------
-- AI-vs-human split over a trailing window. The "is the AI earning its keep?"
-- number, read straight from the sealed rollups.
-- -----------------------------------------------------------------------------
create view public.handling_split_30d
with (security_invoker = true) as
select
  ad.business_id,
  sum(ad.messages_outbound) as outbound_total,
  sum(ad.messages_ai) as ai_total,
  sum(ad.messages_human) as human_total,
  case when sum(ad.messages_outbound) = 0 then null
       else round(100.0 * sum(ad.messages_ai) / sum(ad.messages_outbound), 2) end as ai_handled_pct,
  case when sum(ad.messages_outbound) = 0 then null
       else round(100.0 * sum(ad.messages_human) / sum(ad.messages_outbound), 2) end as human_handled_pct,
  sum(ad.handovers) as handovers,
  sum(ad.leads_captured) as leads_captured,
  sum(ad.leads_qualified) as leads_qualified,
  sum(ad.ai_cost_usd) as ai_cost_usd,
  sum(ad.messaging_cost_usd) as messaging_cost_usd
from public.analytics_daily ad
where ad.day >= current_date - 30
group by ad.business_id;

grant select on public.handling_split_30d to authenticated;

-- -----------------------------------------------------------------------------
-- Lead source attribution — where the pipeline actually comes from.
-- -----------------------------------------------------------------------------
create view public.lead_sources_30d
with (security_invoker = true) as
select
  l.business_id,
  coalesce(l.source, 'unknown') as source,
  count(*) as leads,
  count(*) filter (where l.status in ('qualified', 'booked', 'won')) as qualified,
  round(avg(l.completeness)::numeric, 3) as avg_completeness
from public.leads l
where l.created_at >= now() - interval '30 days'
group by l.business_id, coalesce(l.source, 'unknown');

grant select on public.lead_sources_30d to authenticated;

-- -----------------------------------------------------------------------------
-- The AI context view.
--
-- The Business Loader workflow reads exactly one row from here per conversation.
-- Aggregating the child tables into JSON in the database — rather than issuing
-- six queries and stitching them in TypeScript — keeps the hot path to a single
-- round trip, which matters when a customer is waiting for an SMS reply.
--
-- Only published rows are included, so unapproved scrape output can never reach
-- a prompt.
-- -----------------------------------------------------------------------------
create view public.business_ai_context
with (security_invoker = true) as
select
  b.id as business_id,
  b.slug,
  b.name,
  b.status,
  b.timezone,
  b.locale,
  b.default_region,
  b.currency,

  to_jsonb(p) - 'business_id' - 'created_at' - 'updated_at' as profile,
  to_jsonb(s) - 'business_id' - 'created_at' - 'updated_at' as settings,

  coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', sv.id, 'name', sv.name, 'description', sv.description,
      'category', sv.category, 'price_text', sv.price_text,
      'duration_minutes', sv.duration_minutes, 'is_bookable', sv.is_bookable
    ) order by sv.sort_order, sv.name)
    from public.services sv
    where sv.business_id = b.id and sv.is_published
  ), '[]'::jsonb) as services,

  coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', sa.name, 'postcode_prefixes', sa.postcode_prefixes,
      'radius_miles', sa.radius_miles, 'notes', sa.notes
    ) order by sa.sort_order, sa.name)
    from public.service_areas sa
    where sa.business_id = b.id and sa.is_published
  ), '[]'::jsonb) as service_areas,

  coalesce((
    select jsonb_agg(jsonb_build_object(
      'day_of_week', oh.day_of_week, 'opens_at', oh.opens_at,
      'closes_at', oh.closes_at, 'is_closed', oh.is_closed
    ) order by oh.day_of_week)
    from public.opening_hours oh
    where oh.business_id = b.id
  ), '[]'::jsonb) as opening_hours,

  coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', ki.id, 'kind', ki.kind, 'title', ki.title, 'content', ki.content
    ) order by ki.sort_order, ki.created_at)
    from public.knowledge_items ki
    where ki.business_id = b.id
      and ki.is_published
      and not ki.needs_review
      and ki.kind in ('faq', 'policy', 'about', 'hours_note', 'pricing_note')
  ), '[]'::jsonb) as knowledge,

  coalesce((
    select jsonb_agg(jsonb_build_object(
      'e164', pn.e164, 'channels', pn.channels, 'is_primary', pn.is_primary
    ) order by pn.is_primary desc, pn.e164)
    from public.phone_numbers pn
    where pn.business_id = b.id and pn.released_at is null
  ), '[]'::jsonb) as phone_numbers
from public.businesses b
join public.business_profiles p on p.business_id = b.id
join public.business_settings s on s.business_id = b.id
where b.deleted_at is null;

comment on view public.business_ai_context is
  'Single-row-per-tenant prompt context. Only published, reviewed content is exposed.';

grant select on public.business_ai_context to authenticated;

-- -----------------------------------------------------------------------------
-- White-label theme lookup — resolvable by slug or custom domain, and containing
-- nothing sensitive, so the app shell can render branded chrome before auth
-- resolves.
-- -----------------------------------------------------------------------------
create view public.business_theme
with (security_invoker = true) as
select
  b.id as business_id,
  b.slug,
  b.name,
  p.trading_name,
  p.custom_domain,
  p.logo_url,
  p.logo_dark_url,
  p.favicon_url,
  p.brand_primary,
  p.brand_accent,
  p.brand_background,
  p.brand_foreground,
  p.brand_font
from public.businesses b
join public.business_profiles p on p.business_id = b.id
where b.deleted_at is null;

grant select on public.business_theme to authenticated;

-- -----------------------------------------------------------------------------
-- The human queue, ordered by how overdue it is against the tenant's SLA.
-- -----------------------------------------------------------------------------
create view public.handover_queue
with (security_invoker = true) as
select
  c.id as conversation_id,
  c.business_id,
  c.customer_phone,
  c.customer_name,
  c.channel,
  c.handover_reason_code,
  c.handover_note,
  c.handover_at,
  c.summary,
  c.current_topic,
  c.message_count,
  l.urgency,
  l.status as lead_status,
  extract(epoch from (now() - c.handover_at))::int / 60 as waiting_minutes,
  s.handover_sla_minutes,
  (extract(epoch from (now() - c.handover_at))::int / 60) > s.handover_sla_minutes as sla_breached
from public.conversations c
join public.business_settings s on s.business_id = c.business_id
left join public.leads l on l.conversation_id = c.id
where c.status = 'waiting_for_human';

comment on view public.handover_queue is
  'Conversations awaiting a human, with SLA breach flag. Drives the dashboard queue and escalation nudges.';

grant select on public.handover_queue to authenticated;
