# Authentication and authorisation

## Users

Supabase Auth, magic link only — no passwords.

For a product whose users are small-business owners checking a dashboard from a
phone, that removes the entire password surface: reset flows, reuse, storage,
breach exposure. The cost is one email round trip per sign-in, which is the right
trade for this audience. Adding OAuth later is a Supabase config change plus a
button.

`public.users` mirrors `auth.users`, auto-provisioned by an `after insert` trigger.
Separate so the app never writes to the auth schema and profile reads need no
elevated privilege.

### Session handling

Middleware refreshes the session cookie on every request — access tokens are
short-lived and without a refresh the user is logged out mid-session. It also
redirects unauthenticated traffic away from `/app`, preserving the intended
destination in `?next=`.

It deliberately does **not** check whether the user belongs to the business in the
URL. That is RLS's job, which enforces it on every query rather than only on
navigation. A membership check in middleware would be a second, weaker copy of a
rule the database already applies.

The API is excluded from middleware entirely: webhooks and internal routes
authenticate with a signature or a shared secret, not a cookie, and running cookie
middleware over them would add a pointless auth round trip to the hot path.

### Open redirect

`/auth/callback` validates `next` rather than trusting it. It arrives from a URL
the user clicked in an email; forwarding to an arbitrary value would make this an
open redirect — a phishing primitive that borrows the domain's credibility. Only
same-origin absolute paths pass, and `//host` is rejected because it is
protocol-relative and would leave the origin.

## Roles

`memberships (business_id, user_id, role)`. A user may belong to several
businesses, which is what lets an agency manage multiple clients.

| Role | Can |
|---|---|
| `viewer` | Read everything. Cannot write. |
| `agent` | Reply, take over, edit contacts, leads, appointments. |
| `admin` | Agent, plus profile, settings, knowledge, numbers, members, credentials. |
| `owner` | Admin, plus the business record itself. |

`users.platform_role` marks Atwood staff. Deliberately **not** a tenant role, and
deliberately **not** in the column grant list — so nobody can promote themselves.

## The three layers

Isolation is enforced three times, and each layer catches what the others cannot.

### 1. Row Level Security

Every policy is one indexed predicate:

```sql
using (public.is_business_member(business_id))
```

`is_business_member` is `STABLE SECURITY DEFINER`. `STABLE` so the planner calls
it once per query rather than per row; `SECURITY DEFINER` so it reads `memberships`
without triggering that table's own policy — which is what avoids the "policy on A
queries B whose policy queries A" recursion trap.

Write policies use `has_business_role(business_id, roles[])`.

`FORCE ROW LEVEL SECURITY` on `conversations`, `messages`, `leads` and `contacts`,
so a stray `set role postgres` in a migration cannot silently cross tenants.

### 2. Column grants

This layer exists because of a Postgres detail that is easy to get wrong:

> **A table-level grant cannot be narrowed afterwards.** `REVOKE UPDATE (col)`
> against a table-level `UPDATE` grant emits a warning and changes nothing.

Supabase's default setup grants `ALL` on public tables to `authenticated` and
relies on RLS for rows. Accepting that default would leave
`users.platform_role` self-assignable and `api_keys.key_hash` readable — RLS
filters rows, not columns.

So `0008` revokes everything from `authenticated` and grants back deliberately:

- `SELECT` on the tables a tenant may read — but **column lists** on
  `integration_credentials` (no `ciphertext`) and `api_keys` (no `key_hash`).
- `INSERT/UPDATE/DELETE` only on tables a tenant legitimately mutates.
- Narrow `UPDATE` column lists where it matters: `businesses` excludes `status`,
  `plan`, `slug` and billing; `users` excludes `platform_role`; `notifications`
  allows only `read_at`; `api_keys` only `revoked_at`.
- `messages` gets `INSERT` and nothing else — the transcript is append-only.

The result is that least privilege is a list you can read at the top of `0008`,
not an inference from policy names.

### 3. Role gating in policies

`messages_insert_human` is the clearest example:

```sql
with check (
  public.has_business_role(business_id, array['owner','admin','agent']::member_role[])
  and sender = 'human'
  and direction = 'outbound'
  and sent_by_user_id = auth.uid()
)
```

A user cannot forge a message as the AI, as a colleague, or as inbound.

## Machine credentials

| Credential | Scope | Used by |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS entirely | Internal API, webhooks, n8n |
| `INTERNAL_API_SECRET` | Platform-wide | n8n → internal API |
| `api_keys` row | One tenant | Customer integrations |
| Twilio auth token | Signature verification | Inbound webhooks |

The service role's call sites are the one place isolation lives in code rather
than in the database — on purpose, because routing an inbound number to *whichever*
tenant owns it is a cross-tenant read RLS cannot express. Those sites take
`business_id` from a trusted source (the resolved phone number, or a verified
session), never from request input.

Both shared secrets are compared with `timingSafeEqual` after hashing both sides,
so the comparison length is fixed regardless of what was presented.

## Tested

`supabase/tests/functional.sql` asserts, under a real `authenticated` session:

- tenant B sees **zero** of tenant A's conversations, messages, leads, contacts,
  calls, services and analytics;
- every view is tenant-scoped — asserted as "sees exactly its own row and not
  tenant A's", because asserting "zero rows" would pass even if a view were broken
  open in the other direction;
- `authenticated` calling `resolve_inbound` gets `insufficient_privilege`;
- a `viewer` inserting a message is rejected, and a `viewer` updating a service
  affects zero rows.
