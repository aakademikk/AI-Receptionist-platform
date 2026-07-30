import { revalidatePath } from 'next/cache';

import { Badge, Button, Card, CardHeader } from '@/components/ui';
import { createClient } from '@/lib/supabase/server';
import { canAdminister, requireTenant } from '@/lib/tenant';

/**
 * Settings.
 *
 * Writes go through the RLS-scoped client, not the service role. That is deliberate:
 * the `business_settings_write` policy already restricts these updates to owners and
 * admins, and the column grants already prevent a tenant touching `status`, `plan`
 * or `platform_role`. Using the user's own client means the database enforces all of
 * that on every save, rather than this page being the only thing standing between an
 * agent and the billing plan.
 *
 * Model selection is the interesting field. Providers differ in which parameters they
 * accept — current Claude models reject `temperature` outright — and the adapter
 * layer absorbs that, so switching provider here is genuinely a one-field change.
 */
export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await requireTenant(slug);
  const supabase = await createClient();

  const [settingsResult, profileResult, numbersResult, integrationsResult] = await Promise.all([
    supabase.from('business_settings').select('*').eq('business_id', tenant.businessId).single(),
    supabase.from('business_profiles').select('*').eq('business_id', tenant.businessId).single(),
    supabase
      .from('phone_numbers')
      .select('id, e164, friendly_name, channels, is_primary, forward_to, missed_call_enabled')
      .eq('business_id', tenant.businessId)
      .order('is_primary', { ascending: false }),
    supabase.from('integration_status').select('provider, label, last_used_at, expires_at'),
  ]);

  const settings = settingsResult.data as Record<string, unknown> | null;
  const profile = profileResult.data as Record<string, unknown> | null;
  const numbers = (numbersResult.data ?? []) as Array<{
    id: string;
    e164: string;
    friendly_name: string | null;
    channels: string[];
    is_primary: boolean;
    forward_to: string | null;
    missed_call_enabled: boolean;
  }>;
  const integrations = (integrationsResult.data ?? []) as Array<{
    provider: string;
    label: string | null;
    last_used_at: string | null;
  }>;

  const editable = canAdminister(tenant.role);

  async function saveAi(formData: FormData) {
    'use server';

    const client = await createClient();
    const businessId = String(formData.get('business_id'));

    const temperatureRaw = String(formData.get('ai_temperature') ?? '').trim();

    // RLS decides whether this is allowed; there is no service-role escape hatch here.
    await client
      .from('business_settings')
      .update({
        ai_provider: String(formData.get('ai_provider')),
        ai_model: String(formData.get('ai_model')).trim(),
        ai_effort: String(formData.get('ai_effort')),
        extraction_provider: String(formData.get('extraction_provider')),
        extraction_model: String(formData.get('extraction_model')).trim(),
        ai_enabled: formData.get('ai_enabled') === 'on',
        // Left null for providers that reject sampling parameters; the adapter drops
        // it in that case anyway, but storing null keeps the intent honest.
        ai_temperature: temperatureRaw === '' ? null : Number(temperatureRaw),
        max_sms_segments: Number(formData.get('max_sms_segments') ?? 3),
        ai_max_turns: Number(formData.get('ai_max_turns') ?? 20),
      })
      .eq('business_id', businessId);

    revalidatePath(`/app/${String(formData.get('slug'))}/settings`);
  }

  async function saveEscalation(formData: FormData) {
    'use server';

    const client = await createClient();

    await client
      .from('business_settings')
      .update({
        handover_enabled: formData.get('handover_enabled') === 'on',
        handover_on_emergency: formData.get('handover_on_emergency') === 'on',
        handover_on_complaint: formData.get('handover_on_complaint') === 'on',
        handover_confusion_threshold: Number(formData.get('handover_confusion_threshold') ?? 3),
        handover_sla_minutes: Number(formData.get('handover_sla_minutes') ?? 15),
        handover_keywords: String(formData.get('handover_keywords') ?? '')
          .split('\n')
          .map((keyword) => keyword.trim())
          .filter(Boolean),
      })
      .eq('business_id', String(formData.get('business_id')));

    revalidatePath(`/app/${String(formData.get('slug'))}/settings`);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {editable
            ? 'Changes take effect on the next incoming message.'
            : 'Your role can view these but not change them.'}
        </p>
      </div>

      <Card>
        <CardHeader
          title="Assistant"
          description="Which model answers, and how much room it has."
        />
        <form action={saveAi} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="business_id" value={tenant.businessId} />
          <input type="hidden" name="slug" value={slug} />

          <Field label="Reply provider">
            <Select
              name="ai_provider"
              defaultValue={String(settings?.['ai_provider'] ?? 'anthropic')}
              disabled={!editable}
              options={[
                ['anthropic', 'Claude (Anthropic)'],
                ['openai', 'GPT (OpenAI)'],
                ['google', 'Gemini (Google)'],
              ]}
            />
          </Field>

          <Field label="Reply model" hint="Exact model id, e.g. claude-opus-5">
            <Input name="ai_model" defaultValue={String(settings?.['ai_model'] ?? '')} disabled={!editable} />
          </Field>

          <Field label="Extraction provider">
            <Select
              name="extraction_provider"
              defaultValue={String(settings?.['extraction_provider'] ?? 'anthropic')}
              disabled={!editable}
              options={[
                ['anthropic', 'Claude (Anthropic)'],
                ['openai', 'GPT (OpenAI)'],
                ['google', 'Gemini (Google)'],
              ]}
            />
          </Field>

          <Field label="Extraction model">
            <Input
              name="extraction_model"
              defaultValue={String(settings?.['extraction_model'] ?? '')}
              disabled={!editable}
            />
          </Field>

          <Field label="Effort" hint="Higher costs more and thinks longer.">
            <Select
              name="ai_effort"
              defaultValue={String(settings?.['ai_effort'] ?? 'low')}
              disabled={!editable}
              options={[
                ['low', 'Low — fastest, cheapest'],
                ['medium', 'Medium'],
                ['high', 'High'],
                ['xhigh', 'Very high'],
                ['max', 'Maximum'],
              ]}
            />
          </Field>

          <Field
            label="Temperature"
            hint="Leave blank for Claude models — they reject it."
          >
            <Input
              name="ai_temperature"
              type="number"
              step="0.1"
              min="0"
              max="1"
              defaultValue={settings?.['ai_temperature'] === null ? '' : String(settings?.['ai_temperature'] ?? '')}
              disabled={!editable}
            />
          </Field>

          <Field label="Maximum SMS segments" hint="Replies longer than this are trimmed.">
            <Input
              name="max_sms_segments"
              type="number"
              min="1"
              max="10"
              defaultValue={String(settings?.['max_sms_segments'] ?? 3)}
              disabled={!editable}
            />
          </Field>

          <Field label="Maximum AI turns" hint="After this, a person takes over.">
            <Input
              name="ai_max_turns"
              type="number"
              min="1"
              max="200"
              defaultValue={String(settings?.['ai_max_turns'] ?? 20)}
              disabled={!editable}
            />
          </Field>

          <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
            <input
              type="checkbox"
              name="ai_enabled"
              defaultChecked={Boolean(settings?.['ai_enabled'])}
              disabled={!editable}
            />
            Let the assistant reply automatically
          </label>

          {editable ? (
            <div className="sm:col-span-2">
              <Button type="submit">Save assistant settings</Button>
            </div>
          ) : null}
        </form>
      </Card>

      <Card>
        <CardHeader
          title="When to fetch a person"
          description="Emergencies and explicit requests always escalate. These add to that."
        />
        <form action={saveEscalation} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="business_id" value={tenant.businessId} />
          <input type="hidden" name="slug" value={slug} />

          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              name="handover_enabled"
              defaultChecked={Boolean(settings?.['handover_enabled'])}
              disabled={!editable}
            />
            Escalate to a person automatically
          </label>

          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              name="handover_on_emergency"
              defaultChecked={Boolean(settings?.['handover_on_emergency'])}
              disabled={!editable}
            />
            On anything that sounds like an emergency
          </label>

          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              name="handover_on_complaint"
              defaultChecked={Boolean(settings?.['handover_on_complaint'])}
              disabled={!editable}
            />
            On complaints and legal threats
          </label>

          <Field label="Escalate after this many confusions">
            <Input
              name="handover_confusion_threshold"
              type="number"
              min="1"
              max="10"
              defaultValue={String(settings?.['handover_confusion_threshold'] ?? 3)}
              disabled={!editable}
            />
          </Field>

          <Field label="Response target (minutes)" hint="Overdue threads are flagged red.">
            <Input
              name="handover_sla_minutes"
              type="number"
              min="1"
              defaultValue={String(settings?.['handover_sla_minutes'] ?? 15)}
              disabled={!editable}
            />
          </Field>

          <Field label="Your own escalation keywords" hint="One per line. Matched as whole words.">
            <textarea
              name="handover_keywords"
              rows={5}
              defaultValue={((settings?.['handover_keywords'] as string[] | null) ?? []).join('\n')}
              disabled={!editable}
              className="w-full rounded-lg border px-3 py-2 text-[13px]"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
            />
          </Field>

          {editable ? (
            <div className="sm:col-span-2">
              <Button type="submit">Save escalation rules</Button>
            </div>
          ) : null}
        </form>
      </Card>

      <Card>
        <CardHeader title="Numbers" description="Inbound routing is keyed on these." />
        {numbers.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            No numbers provisioned yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {numbers.map((number) => (
              <li key={number.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="tnum font-medium">{number.e164}</span>
                {number.is_primary ? <Badge tone="info">Primary</Badge> : null}
                {number.channels.map((channel) => (
                  <Badge key={channel}>{channel}</Badge>
                ))}
                {number.forward_to ? (
                  <span style={{ color: 'var(--text-muted)' }}>→ {number.forward_to}</span>
                ) : (
                  <Badge tone="warning">No forwarding — every call is treated as missed</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Connected services"
          description="Credentials are encrypted; only their metadata is shown here."
        />
        {integrations.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            Nothing connected yet.
          </p>
        ) : (
          <ul className="space-y-1.5 text-[13px]">
            {integrations.map((integration) => (
              <li key={`${integration.provider}:${integration.label ?? ''}`} className="flex items-center gap-2">
                <Badge tone="good">{integration.provider}</Badge>
                <span style={{ color: 'var(--text-muted)' }}>
                  {integration.last_used_at
                    ? `last used ${new Date(integration.last_used_at).toLocaleDateString('en-GB')}`
                    : 'never used'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Brand" description="Applied across the dashboard and outbound email." />
        <div className="flex flex-wrap items-center gap-4 text-[13px]">
          <Swatch label="Primary" value={String(profile?.['brand_primary'] ?? '')} />
          <Swatch label="Accent" value={String(profile?.['brand_accent'] ?? '')} />
          <span style={{ color: 'var(--text-muted)' }}>
            Assistant name: {String(profile?.['ai_assistant_name'] ?? '—')}
          </span>
        </div>
      </Card>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-lg border px-3 py-2 text-[13px] disabled:opacity-60"
      style={{
        background: 'var(--surface-2)',
        borderColor: 'var(--border-strong)',
        color: 'var(--text-primary)',
      }}
    />
  );
}

function Select({
  options,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { options: Array<[string, string]> }) {
  return (
    <select
      {...props}
      className="w-full rounded-lg border px-3 py-2 text-[13px] disabled:opacity-60"
      style={{
        background: 'var(--surface-2)',
        borderColor: 'var(--border-strong)',
        color: 'var(--text-primary)',
      }}
    >
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

function Swatch({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className="inline-block size-5 rounded border"
        style={{ background: value, borderColor: 'var(--border-strong)' }}
      />
      <span style={{ color: 'var(--text-muted)' }}>
        {label} {value}
      </span>
    </span>
  );
}
