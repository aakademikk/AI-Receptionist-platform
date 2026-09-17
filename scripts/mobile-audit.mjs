/**
 * Screenshot the dashboard at phone-portrait size and report what escapes the
 * viewport.
 *
 * Written because "the mobile layout isn't formatted properly" is not a bug report
 * you can act on, and reading the CSS and imagining a phone is how a round of
 * responsive classes came to be silently doing nothing for weeks. This renders the
 * real thing at 390x844 with an iPhone UA and lists, per page, every element whose
 * box leaves the viewport — separating the ones inside a deliberate horizontal
 * scroller from the ones that are simply clipped.
 *
 * Signs in the way a human does — magic link, read out of the local Mailpit on
 * :54324 — because there is no password to script and no auth bypass worth adding
 * for a screenshot.
 *
 * TWO THINGS THAT WILL WASTE AN HOUR IF YOU CHANGE THEM:
 *
 *  1. `APP` must be the public origin, not `127.0.0.1:3001`. The magic link's PKCE
 *     verifier is bound to the origin that began the sign-in, so starting locally
 *     and then following a link that redirects to `site_url` fails with "PKCE code
 *     verifier not found". The failure is quiet: you get seven screenshots of the
 *     login page and a perfect overflow score. If the run does not print a landing
 *     URL under /app/, it measured nothing.
 *  2. Playwright is not a dependency of this repo. It is borrowed from another
 *     project on this machine rather than added here, because a browser binary in
 *     the install graph of a service that never renders one is not worth it for a
 *     script run by hand a few times a year. Edit PLAYWRIGHT_ENTRY if that copy
 *     moves.
 *
 * Usage:  node scripts/mobile-audit.mjs      (writes to /tmp/shots)
 */
const PLAYWRIGHT_ENTRY = '/home/col/Pokemon_sniper/node_modules/playwright/index.mjs';

const { chromium } = await import(PLAYWRIGHT_ENTRY);

/*
 * STALE IN ONE RESPECT, and it will not tell you -- read this before trusting a run.
 *
 * This scrapes the local Mailpit API (`MAIL` below) for the sign-in link. Auth mail has
 * gone out through Resend since 2026-09-16, so nothing lands in Mailpit any more and the
 * sign-in step cannot succeed. It will fail looking like an app fault. Rewrite the mail
 * leg against Resend, or drive a token through the admin `generate_link` API the way the
 * ad-hoc audit scripts do, before using this for anything.
 *
 * The hostname below was updated to the live host on 2026-09-17 when the old one was
 * retired; that alone does not make the script work.
 */
const APP = 'https://receptionist.atwoodsystems.co.uk';
const MAIL = 'http://127.0.0.1:54324';
const EMAIL = 'dev@atwood.systems';
const OUT = '/tmp/shots';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newestMessageId(since) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAIL}/api/v1/messages?limit=5`);
    const json = await res.json();
    const hit = (json.messages ?? []).find((m) => new Date(m.Created).getTime() > since);
    if (hit) return hit.ID;
    await sleep(500);
  }
  throw new Error('no magic-link email arrived within 20s');
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // iPhone 12/13/14 portrait
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();

const t0 = Date.now() - 2000;

await page.goto(`${APP}/login`, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/00-login.png`, fullPage: true });

await page.fill('input[name="email"]', EMAIL);
await page.click('button[type="submit"]');
await page.waitForTimeout(1500);

const id = await newestMessageId(t0);
const body = await (await fetch(`${MAIL}/api/v1/message/${id}`)).json();
const text = `${body.Text ?? ''}\n${body.HTML ?? ''}`;
const link = text.match(/https?:\/\/[^\s"'<>]*(?:verify|confirm)[^\s"'<>]*/i)?.[0];
if (!link) throw new Error('no confirmation link found in the email');

await page.goto(link, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
console.log('landed on', page.url());
if (!page.url().includes('/app/')) {
  throw new Error('sign-in did not land in the dashboard — everything below would be the login page');
}

const slug = 'volta';
const pages = [
  ['01-overview', `${APP}/app/${slug}`],
  ['02-conversations', `${APP}/app/${slug}/conversations`],
  ['03-leads', `${APP}/app/${slug}/leads`],
  ['04-appointments', `${APP}/app/${slug}/appointments`],
  ['05-analytics', `${APP}/app/${slug}/analytics`],
  ['06-knowledge', `${APP}/app/${slug}/knowledge`],
  ['07-settings', `${APP}/app/${slug}/settings`],
];

const report = [];
for (const [name, url] of pages) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

    // The objective measure of "not formatted for portrait": anything wider than
    // the viewport, and every element that individually overflows it.
    const metrics = await page.evaluate(() => {
      const docWidth = document.documentElement.scrollWidth;
      const vw = window.innerWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > vw + 1 || r.left < -1) {
          const cs = getComputedStyle(el);
          // Ignore anything inside a deliberate horizontal scroller.
          let p = el.parentElement,
            scrolled = false;
          while (p) {
            const pcs = getComputedStyle(p);
            if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') {
              scrolled = true;
              break;
            }
            p = p.parentElement;
          }
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className?.toString?.() ?? '').slice(0, 90),
            text: (el.textContent ?? '').trim().slice(0, 40),
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width),
            inScroller: scrolled,
            minWidth: cs.minWidth,
          });
        }
      }
      return { docWidth, vw, offenders };
    });
    report.push({ name, url, ...metrics });
  } catch (e) {
    report.push({ name, url, error: String(e).slice(0, 200) });
  }
}

const fs = await import('node:fs');
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

for (const r of report) {
  if (r.error) {
    console.log(`${r.name}: ERROR ${r.error}`);
    continue;
  }
  const real = (r.offenders ?? []).filter((o) => !o.inScroller);
  console.log(
    `${r.name}: doc ${r.docWidth}px vs viewport ${r.vw}px | clipped: ${real.length} (plus ${r.offenders.length - real.length} inside scrollers)`,
  );
  for (const o of real.slice(0, 6)) {
    console.log(`    <${o.tag}> w=${o.width} right=${o.right} minW=${o.minWidth} "${o.text}" .${o.cls}`);
  }
}

await browser.close();
