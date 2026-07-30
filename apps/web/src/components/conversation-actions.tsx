'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from './ui';

/**
 * Take over, reply, hand back.
 *
 * The only client island in the dashboard. It posts to `/api/dashboard/*` rather
 * than to the internal API: those routes authenticate with the user's session cookie
 * and re-check membership, whereas the internal API authenticates with a shared
 * secret that must never reach a browser.
 *
 * Sending a reply implicitly takes the conversation over, server-side — a colleague
 * who has started typing should not have the assistant answer over the top of them.
 */
export function ConversationActions({
  conversationId,
  aiEnabled,
  status,
}: {
  conversationId: string;
  aiEnabled: boolean;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(path: string, payload?: unknown) {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/dashboard/conversations/${conversationId}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });

      if (!response.ok) {
        const payloadBody = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(payloadBody?.error?.message ?? `Request failed (${response.status})`);
      }

      setBody('');
      // Re-render the server component so the new message and status appear.
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;

  return (
    <div className="w-full max-w-md space-y-2">
      <div className="flex flex-wrap gap-2">
        {status !== 'human_handling' ? (
          <Button variant="secondary" disabled={disabled} onClick={() => void call('takeover')}>
            Take over
          </Button>
        ) : null}
        {!aiEnabled ? (
          <Button variant="secondary" disabled={disabled} onClick={() => void call('resume')}>
            Hand back to the assistant
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => void call('handover', { reason: 'manual', note: 'Paused from the dashboard' })}
          >
            Pause the assistant
          </Button>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim()) void call('reply', { body: body.trim() });
        }}
        className="space-y-2"
      >
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          placeholder="Reply as your team…"
          className="w-full rounded-lg border px-3 py-2 text-[13px]"
          style={{
            background: 'var(--surface-2)',
            borderColor: 'var(--border-strong)',
            color: 'var(--text-primary)',
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {body.length > 0 ? `${body.length} characters` : 'Sending pauses the assistant'}
          </span>
          <Button type="submit" disabled={disabled || body.trim() === ''}>
            {disabled ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </form>

      {error ? (
        <p className="text-[12px]" style={{ color: 'var(--status-critical)' }} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
