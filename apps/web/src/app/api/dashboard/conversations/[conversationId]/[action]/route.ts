import { NextResponse } from 'next/server';

import { serverEnv, toAppError } from '@atwood/core';

import { createClient, getCurrentUser } from '@/lib/supabase/server';

/**
 * POST /api/dashboard/conversations/:conversationId/:action
 *
 * The browser's bridge to the internal API. Actions: `reply`, `takeover`, `resume`,
 * `handover`.
 *
 * This exists because of a boundary that must not be crossed: the internal API
 * authenticates with a platform-wide shared secret, and that secret can never be in
 * a browser bundle. So the browser talks to this route with its session cookie, this
 * route verifies membership, and only then does it present the secret server-side.
 *
 * The membership check here is not decoration. The internal API's shared secret is
 * platform-scoped — it can act on *any* tenant — so this route is the only thing
 * standing between a signed-in user and another business's conversations. It uses the
 * RLS-scoped client to confirm the conversation is visible to *this* user before
 * forwarding anything.
 */

const ACTIONS = new Set(['reply', 'takeover', 'resume', 'handover']);

// Roles allowed to act. A viewer may read a conversation but not speak for the
// business in it.
const WRITE_ROLES = new Set(['owner', 'admin', 'agent']);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string; action: string }> },
): Promise<Response> {
  try {
    const { conversationId, action } = await params;

    if (!ACTIONS.has(action)) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Unknown action' } },
        { status: 404 },
      );
    }

    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: 'Sign in to continue' } },
        { status: 401 },
      );
    }

    const supabase = await createClient();

    // RLS scopes this: a conversation in another tenant simply is not returned.
    const { data: conversationRow } = await supabase
      .from('conversations')
      .select('id, business_id')
      .eq('id', conversationId)
      .maybeSingle();

    if (!conversationRow) {
      // Deliberately a 404 rather than a 403 — telling a user that a conversation
      // exists but is not theirs is an information leak.
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Conversation not found' } },
        { status: 404 },
      );
    }

    const conversation = conversationRow as { id: string; business_id: string };

    const { data: membershipRow } = await supabase
      .from('memberships')
      .select('role')
      .eq('business_id', conversation.business_id)
      .eq('user_id', user.id)
      .maybeSingle();

    const role = (membershipRow as { role: string } | null)?.role;

    if (!role || !WRITE_ROLES.has(role)) {
      return NextResponse.json(
        { error: { code: 'forbidden', message: 'Your role cannot do that' } },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      body?: unknown;
      reason?: unknown;
      note?: unknown;
    };

    const origin = new URL(request.url).origin;
    const headers = {
      'content-type': 'application/json',
      'x-atwood-secret': serverEnv.internalApiSecret,
    };

    let target: string;
    let payload: unknown;

    switch (action) {
      case 'reply': {
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        if (text === '') {
          return NextResponse.json(
            { error: { code: 'bad_request', message: 'A message body is required' } },
            { status: 400 },
          );
        }
        target = `${origin}/api/internal/v1/messages/send`;
        payload = {
          conversation_id: conversationId,
          body: text,
          sender: 'human',
          // Attribution comes from the verified session, never from the request body.
          sent_by_user_id: user.id,
          take_over: true,
        };
        break;
      }

      case 'takeover':
        target = `${origin}/api/internal/v1/conversations/${conversationId}/takeover`;
        payload = { user_id: user.id };
        break;

      case 'resume':
        target = `${origin}/api/internal/v1/conversations/${conversationId}/resume`;
        payload = {};
        break;

      default:
        target = `${origin}/api/internal/v1/conversations/${conversationId}/handover`;
        payload = {
          reason: typeof body.reason === 'string' ? body.reason : 'manual',
          note: typeof body.note === 'string' ? body.note : null,
          // A dashboard user pausing the assistant already knows about it; do not
          // email them to tell them what they just did.
          notify: false,
        };
    }

    const response = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    const result = await response.json().catch(() => ({}));
    return NextResponse.json(result, { status: response.status });
  } catch (error) {
    const appError = toAppError(error);
    return NextResponse.json(appError.toResponseBody(), { status: appError.status });
  }
}
