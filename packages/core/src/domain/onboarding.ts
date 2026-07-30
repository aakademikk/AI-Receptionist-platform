import { generateWithRetry } from '../ai/index.ts';
import {
  buildOnboardingSystemPrompt,
  buildOnboardingUserMessage,
  ONBOARDING_SCHEMA,
  ONBOARDING_SCHEMA_NAME,
} from '../prompts/onboarding.ts';
import { getCrawlStatus, startCrawl, type CrawledPage } from '../integrations/firecrawl.ts';
import { getAdminClient } from '../supabase/admin.ts';
import { badRequest, unprocessable } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { recordAiLog } from './reply.ts';

/**
 * Onboarding: website URL → draft business profile.
 *
 * Two phases, because a crawl takes 30–120 seconds and no serverless function
 * should hold a connection that long:
 *
 *   runOnboarding()   — advances the job one step. Called on create and then polled.
 *   applyOnboarding() — writes the owner-approved draft to the live tables.
 *
 * The draft is never written straight to the live profile. Everything lands in
 * `onboarding_jobs.extracted`, the owner reviews and edits it, and only then is it
 * applied — and knowledge items created this way carry `needs_review = true` until
 * approved, which keeps unreviewed scrape output out of `business_ai_context` and
 * therefore out of every prompt.
 */

export interface OnboardingStep {
  key: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'crawl', label: 'Reading your website' },
  { key: 'extract', label: 'Understanding your business' },
  { key: 'review', label: 'Ready for your review' },
];

export interface RunOnboardingResult {
  jobId: string;
  status: 'pending' | 'scraping' | 'extracting' | 'awaiting_review' | 'completed' | 'failed';
  steps: OnboardingStep[];
  pagesCrawled: number;
  extracted: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Advance an onboarding job by one step.
 *
 * Written as a state machine over the stored status rather than as a long-running
 * async function: each call is short, idempotent, and safe to retry, so polling from
 * the browser or from an n8n schedule both work with the same code.
 */
export async function runOnboarding(jobId: string): Promise<RunOnboardingResult> {
  const supabase = getAdminClient();

  const { data: jobData, error: jobError } = await supabase
    .from('onboarding_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (jobError || !jobData) throw badRequest(`Onboarding job ${jobId} not found`);

  const job = jobData as {
    id: string;
    business_id: string;
    website_url: string;
    status: RunOnboardingResult['status'];
    provider_job_id: string | null;
    raw_pages: CrawledPage[] | null;
    extracted: Record<string, unknown> | null;
    pages_crawled: number;
  };

  const log = logger.child({ businessId: job.business_id, onboardingJobId: job.id });

  try {
    // --- Kick off the crawl -------------------------------------------------
    if (job.status === 'pending') {
      const providerJobId = await startCrawl(job.website_url);

      await supabase
        .from('onboarding_jobs')
        .update({
          status: 'scraping',
          provider_job_id: providerJobId,
          started_at: new Date().toISOString(),
          steps: buildSteps('crawl', 'running'),
        })
        .eq('id', job.id);

      return {
        jobId: job.id,
        status: 'scraping',
        steps: buildSteps('crawl', 'running'),
        pagesCrawled: 0,
        extracted: null,
        error: null,
      };
    }

    // --- Poll the crawl -----------------------------------------------------
    if (job.status === 'scraping') {
      if (!job.provider_job_id) throw unprocessable('Crawl job id is missing');

      const crawl = await getCrawlStatus(job.provider_job_id);

      if (crawl.status === 'failed') {
        return await failJob(job.id, crawl.error ?? 'The crawl failed', 'crawl');
      }

      if (crawl.status === 'scraping') {
        await supabase
          .from('onboarding_jobs')
          .update({
            pages_crawled: crawl.completed,
            steps: buildSteps('crawl', 'running', `${crawl.completed} of ${crawl.total} pages`),
          })
          .eq('id', job.id);

        return {
          jobId: job.id,
          status: 'scraping',
          steps: buildSteps('crawl', 'running', `${crawl.completed} of ${crawl.total} pages`),
          pagesCrawled: crawl.completed,
          extracted: null,
          error: null,
        };
      }

      // A crawl that succeeded but found nothing readable is a failure from the
      // owner's point of view, and saying so is more useful than an empty form.
      if (crawl.pages.length === 0) {
        return await failJob(
          job.id,
          'We could not read any content from that website. It may be blocking automated access, or it may be built entirely in JavaScript.',
          'crawl',
        );
      }

      // Store the raw markdown so re-extraction (a prompt change, a retry) costs no
      // further crawl credits.
      await supabase
        .from('onboarding_jobs')
        .update({
          status: 'extracting',
          raw_pages: crawl.pages,
          pages_crawled: crawl.pages.length,
          steps: buildSteps('extract', 'running'),
        })
        .eq('id', job.id);

      return await runOnboarding(job.id); // fall straight through to extraction
    }

    // --- Extract ------------------------------------------------------------
    if (job.status === 'extracting') {
      const pages = job.raw_pages ?? [];
      if (pages.length === 0) return await failJob(job.id, 'No crawled pages to extract from', 'extract');

      const settings = await loadExtractionSettings(job.business_id);

      const system = buildOnboardingSystemPrompt();
      const user = buildOnboardingUserMessage(pages);

      const result = await generateWithRetry(settings.provider, {
        model: settings.model,
        system,
        messages: [{ role: 'user', content: user }],
        // Onboarding output is large (every service, every FAQ) and this is the one
        // call in the system that is not latency-sensitive, so the budget is generous.
        maxOutputTokens: 16_000,
        // ...and worth spending on: a good draft saves the owner an hour of typing.
        effort: 'high',
        jsonSchema: { name: ONBOARDING_SCHEMA_NAME, schema: ONBOARDING_SCHEMA },
        timeoutMs: 180_000,
      });

      await recordAiLog({
        businessId: job.business_id,
        purpose: 'onboarding_extract',
        provider: settings.provider,
        model: result.model,
        status: result.refusal ? 'refused' : 'ok',
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        response: result.json ?? null,
      });

      if (result.refusal || !result.json || typeof result.json !== 'object') {
        return await failJob(job.id, 'We could not build a profile from that website', 'extract');
      }

      const extracted = result.json as Record<string, unknown>;

      await supabase
        .from('onboarding_jobs')
        .update({
          status: 'awaiting_review',
          extracted,
          completed_at: new Date().toISOString(),
          steps: buildSteps('review', 'running'),
        })
        .eq('id', job.id);

      log.info('Onboarding extraction complete', { pages: pages.length });

      return {
        jobId: job.id,
        status: 'awaiting_review',
        steps: buildSteps('review', 'running'),
        pagesCrawled: pages.length,
        extracted,
        error: null,
      };
    }

    // Terminal states: report as-is.
    return {
      jobId: job.id,
      status: job.status,
      steps: buildSteps(job.status === 'completed' ? 'review' : 'crawl', 'done'),
      pagesCrawled: job.pages_crawled,
      extracted: job.extracted,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Onboarding step failed', { error: message });
    return await failJob(job.id, message, job.status === 'extracting' ? 'extract' : 'crawl');
  }
}

/**
 * Apply an approved draft to the live tables.
 *
 * `profile` is what the owner submits from the review form — which may differ from
 * what was extracted, and that diff is worth keeping: it is the clearest available
 * signal for improving the extraction prompt, so both are stored.
 *
 * Services, areas, hours and knowledge are replaced rather than merged. Applying a
 * review is a deliberate "this is my business" statement, and merging would leave
 * behind rows the owner had just deleted.
 */
export async function applyOnboarding(input: {
  jobId: string;
  businessId: string;
  profile: OnboardingDraft;
  appliedBy?: string | null;
}): Promise<{ services: number; areas: number; hours: number; knowledge: number }> {
  const supabase = getAdminClient();
  const { businessId, profile } = input;

  // --- Profile -------------------------------------------------------------
  const profileUpdate: Record<string, unknown> = {
    trading_name: profile.business_name || null,
    legal_name: profile.legal_name || null,
    tagline: profile.tagline || null,
    description: profile.description || null,
    industry: profile.industry || null,
    founded_year: parseYear(profile.founded_year),
    email: profile.email || null,
    phone: profile.phone || null,
    address_line1: profile.address_line1 || null,
    address_line2: profile.address_line2 || null,
    city: profile.city || null,
    region: profile.region || null,
    postcode: profile.postcode || null,
    country: profile.country || null,
  };

  if (profile.tone_of_voice) profileUpdate['tone_of_voice'] = profile.tone_of_voice;

  if (profile.social_links?.length) {
    profileUpdate['social_links'] = Object.fromEntries(
      profile.social_links.filter((link) => link.platform && link.url).map((link) => [link.platform, link.url]),
    );
  }

  const { error: profileError } = await supabase
    .from('business_profiles')
    .update(profileUpdate)
    .eq('business_id', businessId);

  if (profileError) throw unprocessable(`Could not save the profile: ${profileError.message}`);

  // Keep the businesses row's display name in step with the reviewed profile.
  if (profile.business_name) {
    await supabase.from('businesses').update({ name: profile.business_name }).eq('id', businessId);
  }

  // --- Child collections: replace ------------------------------------------
  const counts = { services: 0, areas: 0, hours: 0, knowledge: 0 };

  const services = (profile.services ?? []).filter((service) => service.name?.trim());
  if (services.length > 0) {
    await supabase.from('services').delete().eq('business_id', businessId);
    const { error } = await supabase.from('services').insert(
      services.map((service, index) => ({
        business_id: businessId,
        name: service.name.trim(),
        description: service.description || null,
        category: service.category || null,
        price_text: service.price_text || null,
        duration_minutes: parseInteger(service.duration_minutes),
        sort_order: index,
        source_url: null,
      })),
    );
    if (error) throw unprocessable(`Could not save services: ${error.message}`);
    counts.services = services.length;
  }

  const areas = (profile.service_areas ?? []).filter((area) => area.name?.trim());
  if (areas.length > 0) {
    await supabase.from('service_areas').delete().eq('business_id', businessId);
    const { error } = await supabase.from('service_areas').insert(
      areas.map((area, index) => ({
        business_id: businessId,
        name: area.name.trim(),
        postcode_prefixes: (area.postcode_prefixes ?? []).map((prefix) =>
          prefix.toUpperCase().replace(/\s+/g, ''),
        ),
        notes: area.notes || null,
        sort_order: index,
      })),
    );
    if (error) throw unprocessable(`Could not save service areas: ${error.message}`);
    counts.areas = areas.length;
  }

  const hours = (profile.opening_hours ?? [])
    .map((entry) => ({
      day: parseInteger(entry.day_of_week),
      opens: entry.opens_at || null,
      closes: entry.closes_at || null,
      closed: entry.is_closed === 'true' || entry.is_closed === true,
    }))
    .filter((entry) => entry.day !== null && entry.day >= 0 && entry.day <= 6);

  if (hours.length > 0) {
    await supabase.from('opening_hours').delete().eq('business_id', businessId);
    const { error } = await supabase.from('opening_hours').insert(
      hours.map((entry) => ({
        business_id: businessId,
        day_of_week: entry.day!,
        // The CHECK constraint requires both times unless is_closed, so a partial
        // entry is normalised to closed rather than rejected.
        opens_at: entry.closed ? null : entry.opens,
        closes_at: entry.closed ? null : entry.closes,
        is_closed: entry.closed || !entry.opens || !entry.closes,
      })),
    );
    if (error) throw unprocessable(`Could not save opening hours: ${error.message}`);
    counts.hours = hours.length;
  }

  // --- Knowledge -----------------------------------------------------------
  const knowledge: Array<{ kind: string; title: string | null; content: string }> = [];

  for (const faq of profile.faqs ?? []) {
    if (faq.question?.trim() && faq.answer?.trim()) {
      knowledge.push({ kind: 'faq', title: faq.question.trim(), content: faq.answer.trim() });
    }
  }
  for (const policy of profile.policies ?? []) {
    if (policy.content?.trim()) {
      knowledge.push({
        kind: 'policy',
        title: policy.title?.trim() || null,
        content: policy.content.trim(),
      });
    }
  }
  if (profile.description?.trim()) {
    knowledge.push({ kind: 'about', title: 'About us', content: profile.description.trim() });
  }

  if (knowledge.length > 0) {
    await supabase.from('knowledge_items').delete().eq('business_id', businessId);
    const { error } = await supabase.from('knowledge_items').insert(
      knowledge.map((item, index) => ({
        business_id: businessId,
        kind: item.kind,
        title: item.title,
        content: item.content,
        // The owner has reviewed this form, so it is publishable immediately.
        needs_review: false,
        is_published: true,
        sort_order: index,
      })),
    );
    if (error) throw unprocessable(`Could not save knowledge: ${error.message}`);
    counts.knowledge = knowledge.length;
  }

  await supabase
    .from('onboarding_jobs')
    .update({
      status: 'completed',
      applied: profile as unknown as Record<string, unknown>,
      applied_at: new Date().toISOString(),
      steps: buildSteps('review', 'done'),
    })
    .eq('id', input.jobId);

  logger.info('Onboarding applied', { businessId, ...counts });
  return counts;
}

// -----------------------------------------------------------------------------

export interface OnboardingDraft {
  business_name?: string;
  legal_name?: string;
  tagline?: string;
  description?: string;
  industry?: string;
  founded_year?: string;
  email?: string;
  phone?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  region?: string;
  postcode?: string;
  country?: string;
  tone_of_voice?: string;
  services?: Array<{
    name: string;
    description?: string;
    category?: string;
    price_text?: string;
    duration_minutes?: string;
  }>;
  service_areas?: Array<{ name: string; postcode_prefixes?: string[]; notes?: string }>;
  opening_hours?: Array<{
    day_of_week: string;
    opens_at?: string;
    closes_at?: string;
    is_closed?: string | boolean;
  }>;
  faqs?: Array<{ question: string; answer: string }>;
  policies?: Array<{ title?: string; content: string }>;
  social_links?: Array<{ platform: string; url: string }>;
  confidence_notes?: string;
}

async function loadExtractionSettings(
  businessId: string,
): Promise<{ provider: 'anthropic' | 'openai' | 'google'; model: string }> {
  const { data } = await getAdminClient()
    .from('business_settings')
    .select('extraction_provider, extraction_model')
    .eq('business_id', businessId)
    .single();

  const settings = data as { extraction_provider: string; extraction_model: string } | null;

  return {
    provider: (settings?.extraction_provider ?? 'anthropic') as 'anthropic' | 'openai' | 'google',
    model: settings?.extraction_model ?? 'claude-opus-5',
  };
}

function buildSteps(currentKey: string, state: OnboardingStep['status'], detail?: string): OnboardingStep[] {
  const currentIndex = STEPS.findIndex((step) => step.key === currentKey);

  return STEPS.map((step, index) => {
    if (index < currentIndex) return { ...step, status: 'done' as const };
    if (index === currentIndex) return { ...step, status: state, ...(detail ? { detail } : {}) };
    return { ...step, status: 'pending' as const };
  });
}

async function failJob(
  jobId: string,
  message: string,
  atStep: string,
): Promise<RunOnboardingResult> {
  const steps = buildSteps(atStep, 'failed', message);

  await getAdminClient()
    .from('onboarding_jobs')
    .update({ status: 'failed', error_message: message, steps })
    .eq('id', jobId);

  return { jobId, status: 'failed', steps, pagesCrawled: 0, extracted: null, error: message };
}

function parseYear(value: string | undefined): number | null {
  if (!value) return null;
  const year = Number.parseInt(value, 10);
  // Reject implausible years rather than writing 12 or 20250 into the column.
  if (Number.isNaN(year) || year < 1700 || year > new Date().getFullYear()) return null;
  return year;
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
