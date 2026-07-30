import { serverEnv } from '../env.ts';
import { AppError, badRequest } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';

/**
 * Firecrawl integration for onboarding.
 *
 * A tenant types their website URL and gets a populated profile back. Firecrawl
 * does the crawling and the markdown conversion; we choose *which* pages to ask
 * for, which turns out to matter more than anything else here.
 *
 * The crawl is deliberately narrow (see `ONBOARDING_PATHS`). A blanket crawl of a
 * business site returns mostly blog posts and case studies, which dilute the
 * extraction — the model starts inferring services from an article about a job they
 * did in 2019. Restricting to the pages that describe the business is the single
 * biggest quality lever in onboarding.
 */

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v2';

/**
 * Path patterns worth crawling. Ordered by usefulness, because the page budget is
 * finite and the extractor is told to note anything it could not find.
 */
const ONBOARDING_PATHS = [
  '',
  'about*',
  'services*',
  'what-we-do*',
  'our-services*',
  'treatments*',
  'pricing*',
  'prices*',
  'fees*',
  'contact*',
  'contact-us*',
  'faq*',
  'faqs*',
  'terms*',
  'policies*',
  'areas*',
  'locations*',
  'coverage*',
];

export interface CrawledPage {
  url: string;
  title: string | null;
  markdown: string;
}

export interface CrawlResult {
  jobId: string | null;
  pages: CrawledPage[];
  creditsUsed: number | null;
}

function requireApiKey(): string {
  const key = serverEnv.firecrawlApiKey;
  if (!key) {
    throw new AppError('not_configured', 422, 'FIRECRAWL_API_KEY is not configured', {
      publicMessage: 'Website scraping is not configured on this deployment.',
    });
  }
  return key;
}

/**
 * Start a crawl.
 *
 * Asynchronous by design: a crawl takes 30–120 seconds, which is far longer than a
 * serverless function should hold a connection, and the owner must be able to close
 * the tab. The job id is stored on `onboarding_jobs` and polled.
 */
export async function startCrawl(websiteUrl: string, options: { maxPages?: number } = {}): Promise<string> {
  const apiKey = requireApiKey();
  const normalised = normaliseUrl(websiteUrl);

  const response = await fetch(`${FIRECRAWL_BASE}/crawl`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      url: normalised,
      limit: options.maxPages ?? 25,
      includePaths: ONBOARDING_PATHS,
      // Blogs and news are noise for profile extraction, and they dominate the
      // page count on most business sites.
      excludePaths: ['blog*', 'news*', 'articles*', 'case-studies*', 'careers*', 'jobs*'],
      // One level deep. Business facts live on top-level pages; depth mostly buys
      // pagination.
      maxDiscoveryDepth: 2,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
        // Navigation and cookie banners repeated on 20 pages waste both crawl
        // credits and prompt budget.
        excludeTags: ['nav', 'footer', 'script', 'style', 'noscript', 'iframe'],
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const message = typeof payload['error'] === 'string' ? payload['error'] : response.statusText;
    throw new AppError(
      response.status >= 500 ? 'provider_error' : 'unprocessable',
      response.status >= 500 ? 502 : 422,
      `Firecrawl rejected the crawl request: ${message}`,
      { publicMessage: 'We could not start scraping that website.' },
    );
  }

  const jobId = typeof payload['id'] === 'string' ? payload['id'] : null;
  if (!jobId) throw new AppError('provider_error', 502, 'Firecrawl did not return a job id');

  logger.info('Firecrawl crawl started', { jobId, url: normalised });
  return jobId;
}

export type CrawlStatus = 'scraping' | 'completed' | 'failed';

export interface CrawlStatusResult {
  status: CrawlStatus;
  completed: number;
  total: number;
  pages: CrawledPage[];
  creditsUsed: number | null;
  error: string | null;
}

/** Poll a crawl. Returns the pages collected so far as well as the status. */
export async function getCrawlStatus(jobId: string): Promise<CrawlStatusResult> {
  const apiKey = requireApiKey();

  const response = await fetch(`${FIRECRAWL_BASE}/crawl/${encodeURIComponent(jobId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new AppError('provider_error', 502, `Firecrawl status check failed (${response.status})`);
  }

  const rawStatus = String(payload['status'] ?? 'scraping');
  const status: CrawlStatus =
    rawStatus === 'completed' ? 'completed' : rawStatus === 'failed' ? 'failed' : 'scraping';

  const data = Array.isArray(payload['data']) ? payload['data'] : [];

  const pages: CrawledPage[] = data
    .map((item) => {
      const entry = item as Record<string, unknown>;
      const metadata = (entry['metadata'] ?? {}) as Record<string, unknown>;
      const markdown = typeof entry['markdown'] === 'string' ? entry['markdown'] : '';
      return {
        url: typeof metadata['sourceURL'] === 'string' ? metadata['sourceURL'] : '',
        title: typeof metadata['title'] === 'string' ? metadata['title'] : null,
        markdown,
      };
    })
    // A page that yielded no text is noise the extractor does not need to see.
    .filter((page) => page.markdown.trim().length > 50);

  return {
    status,
    completed: toNumber(payload['completed']) ?? pages.length,
    total: toNumber(payload['total']) ?? pages.length,
    pages: prioritisePages(pages),
    creditsUsed: toNumber(payload['creditsUsed']),
    error: typeof payload['error'] === 'string' ? payload['error'] : null,
  };
}

/**
 * Scrape one page synchronously.
 *
 * Used for the onboarding preview: the owner types a URL and sees the business name
 * appear within a couple of seconds, which makes the wait for the full crawl feel
 * like progress rather than a hang.
 */
export async function scrapeSinglePage(url: string): Promise<CrawledPage> {
  const apiKey = requireApiKey();

  const response = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      url: normaliseUrl(url),
      formats: ['markdown'],
      onlyMainContent: true,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new AppError('unprocessable', 422, `Could not scrape ${url}`, {
      publicMessage: 'We could not read that page.',
    });
  }

  const data = (payload['data'] ?? {}) as Record<string, unknown>;
  const metadata = (data['metadata'] ?? {}) as Record<string, unknown>;

  return {
    url: typeof metadata['sourceURL'] === 'string' ? metadata['sourceURL'] : url,
    title: typeof metadata['title'] === 'string' ? metadata['title'] : null,
    markdown: typeof data['markdown'] === 'string' ? data['markdown'] : '',
  };
}

/**
 * Order pages by how much profile signal they carry.
 *
 * The extractor's content budget is finite, so when a crawl returns 25 pages the
 * ones that survive truncation should be the services page and the contact page,
 * not whichever the crawler happened to finish first.
 */
function prioritisePages(pages: CrawledPage[]): CrawledPage[] {
  const weight = (url: string): number => {
    const path = url.toLowerCase();
    if (/\/(services|what-we-do|our-services|treatments)/.test(path)) return 0;
    if (/\/(pricing|prices|fees)/.test(path)) return 1;
    if (/\/(about)/.test(path)) return 2;
    if (/\/(faq)/.test(path)) return 3;
    if (/\/(contact)/.test(path)) return 4;
    if (/\/(areas|locations|coverage)/.test(path)) return 5;
    // The homepage is valuable but verbose; let the specific pages go first.
    try {
      if (new URL(url).pathname.replace(/\/$/, '') === '') return 6;
    } catch {
      /* ignore unparseable urls */
    }
    return 7;
  };

  return pages.slice().sort((a, b) => weight(a.url) - weight(b.url));
}

/**
 * Normalise user input into a URL.
 *
 * Owners type "parkfords.co.uk". Also rejects anything that is not http(s) — this
 * value goes into a server-side fetch, so `file://` or a raw IP would be an SSRF
 * vector rather than a typo.
 */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw badRequest('A website URL is required');

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw badRequest(`"${input}" is not a valid website address`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('Only http and https addresses can be scraped');
  }

  // Block the obvious SSRF targets. Firecrawl runs the fetch, not us, but a tenant
  // should not be able to aim it at a metadata endpoint either.
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '169.254.169.254' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (blocked) throw badRequest('That address cannot be scraped');

  return parsed.toString();
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}
