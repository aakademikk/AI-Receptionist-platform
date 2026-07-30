# Frontend architecture

Next.js App Router, TypeScript, Tailwind v4. Server components by default.

## Routing

```
/                              → redirect (signed in ? /app : /login)
/login                         → magic link
/auth/callback                 → code → session, then forward
/app                           → one business: redirect; several: picker
/app/[slug]                    → overview
/app/[slug]/conversations      → list, search, status filter
/app/[slug]/conversations/[id] → transcript + reply
/app/[slug]/leads              → leads, best first
/app/[slug]/appointments       → bookings
/app/[slug]/analytics          → rollup metrics
/app/[slug]/knowledge          → what the assistant has been told
/app/[slug]/settings           → model, escalation, numbers, brand
```

Slug rather than business id in the URL, because an owner reading
`/app/parkfords/leads` knows where they are. `requireTenant(slug)` resolves it on
every page.

## Data fetching

**Server components query Supabase directly with the user's JWT.** No API layer
between the dashboard and Postgres, and no client-side fetching for initial data.

The reason is RLS. A page asks for a business by slug with *no tenancy predicate*:

```ts
await supabase.from('businesses').select('…').eq('slug', slug).maybeSingle()
```

and gets a row only if the caller is a member. Adding `.eq('business_id', …)`
everywhere would be a second, weaker copy of a rule the database already enforces —
and the kind of duplication that drifts until one query forgets.

A non-member gets a **404, not a 403**, which is also the right answer for a slug
that does not exist. Both must be indistinguishable or the dashboard becomes a
tenant-enumeration oracle.

`getUser()`, never `getSession()`. `getSession()` reads the cookie without
verifying it and will report a user from a forged or expired token.

### The one client island

`components/conversation-actions.tsx` — take over, reply, hand back. It posts to
`/api/dashboard/*` rather than the internal API, because the internal API's shared
secret is platform-wide and can never be in a browser bundle.

Everything else is server-rendered: fast first paint, no loading spinners, no
client-side data layer to keep in sync.

## Search and filtering

Server-side, against the trigram GIN indexes. The obvious alternative — fetch and
filter in the browser — works for a tenant with fifty conversations and falls over
for one with fifty thousand, which is the whole point of building for thousands of
businesses.

PostgREST `or` metacharacters are stripped from user input. An unescaped comma
breaks out of the filter list — filter injection, not just a bad result.

## White-labelling

One place: inline CSS custom properties on the tenant shell in
`app/app/[slug]/layout.tsx`. Descendants read them by role; no component takes a
`brandColor` prop or knows a tenant exists.

**Two colour systems that never mix:**

| | |
|---|---|
| `--brand-*` | Tenant's colours. Chrome only — nav, buttons, links, focus, email header. Runtime value, unvalidatable. |
| `--series-*` | Data marks. Fixed palette, same for every tenant, validated for CVD separation and contrast in light and dark. |

A tenant's brand colour as a data encoding would mean accessibility depending on
what a customer typed into a colour picker: one tenant's pale accent unreadable
against the surface, or a two-series chart with two indistinguishable hues. Chrome
absorbs an eccentric brand colour; an encoding cannot.

The two-series values are slots 1 and 2 of a validated categorical palette
(`#2a78d6`/`#eb6834` light, `#3987e5`/`#d95926` dark). All-pairs CVD ΔE 24.7 light
and 26.8 dark against an ≥8 target; normal-vision 33.6 / 31.8 against a ≥15 floor;
both ≥3:1 contrast on their surface. Dark values are re-stepped for the dark
surface, not an automatic flip.

## Dark mode

Both modes are selected, not derived. `prefers-color-scheme` for the OS setting
plus a `[data-theme]` scope that wins both ways, so a theme toggle beats OS dark
and OS light.

## Visualisation

Deliberately restrained. Headline numbers are **stat tiles**, because a one-value
bar chart communicates nothing a large numeral does not and costs a legend and an
axis to say it. The AI-vs-human split is a stacked proportion bar — a part-to-whole
comparison of two categories, answered in one line — with a legend *and* direct
labels, so identity never rests on colour alone.

Analytics is tiles plus a day table. A trend chart of these metrics is genuinely
useful and is Phase 5 (`docs/08`); it is not half-built here, because a trend line
over a handful of seeded days looks like a feature while telling the owner nothing.

## Components

`components/ui.tsx` — Card, StatTile, SplitBar, Badge, Button, EmptyState,
TableShell. A handful of primitives rather than a component library: the dashboard
is a dozen screens of tables, tiles and forms, and a design-system dependency
would be more surface area than the whole UI.

Tables scroll horizontally inside their own container, so the page body never does.

Status is always colour **plus text**. `Badge tone="critical"` renders a red pill
with a word in it, never a bare red dot.

## Forms

Server actions, so forms work without JavaScript and the Supabase call happens
server-side.

Settings writes go through the **RLS-scoped** client, not the service role. The
`business_settings_write` policy already restricts them to owners and admins, and
the column grants already prevent a tenant touching `status` or `plan`. Using the
user's own client means the database enforces all of that on every save, rather
than the page being the only thing standing between an agent and the billing plan.

`canWrite()` / `canAdminister()` hide or disable controls a role cannot use — a
courtesy, not the enforcement.

## Not built yet

- Realtime subscription on the conversation viewer (the schema and client support
  it; the page currently renders on request).
- Knowledge and service editing (read-only for now — seeing exactly what the
  assistant was told matters more first).
- The onboarding review form (the API and prompt are complete; `docs/08`).
