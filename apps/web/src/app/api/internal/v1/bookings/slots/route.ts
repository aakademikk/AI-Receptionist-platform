import { NextResponse } from 'next/server';

import {
  findAvailableSlots,
  loadBusinessContext,
  renderSlotsForPrompt,
} from '@atwood/core';

import {
  assertBusinessScope,
  readJson,
  requireString,
  withInternalAuth,
} from '@/lib/internal-auth';

/**
 * POST /api/internal/v1/bookings/slots
 *
 * Real availability, computed from the tenant's calendar, opening hours, minimum
 * notice and buffer.
 *
 * Returns both the machine-readable slots and `prompt_block` — the exact text to
 * paste into the system prompt. That is not a convenience: the prompt wording is
 * what stops the model inventing a time, so it belongs next to the logic that
 * produced the slots rather than being re-written in a workflow where it can drift.
 */
export const POST = withInternalAuth(async (request, auth) => {
  const body = await readJson<{
    business_id?: unknown;
    service_id?: unknown;
    from?: unknown;
    max_slots?: unknown;
  }>(request);

  const businessId = requireString(body.business_id, 'business_id');
  assertBusinessScope(auth, businessId);

  const context = await loadBusinessContext(businessId);

  const slots = await findAvailableSlots({
    context,
    serviceId: typeof body.service_id === 'string' ? body.service_id : null,
    from: typeof body.from === 'string' ? new Date(body.from) : undefined,
    maxSlots: typeof body.max_slots === 'number' ? body.max_slots : undefined,
  });

  return NextResponse.json({
    trace_id: auth.traceId,
    business_id: businessId,
    timezone: context.timezone,
    slots,
    prompt_block: renderSlotsForPrompt(slots),
  });
});
