/**
 * Zoom auto-register — real-browser registration for recurring classes.
 *
 * Runs a genuine Chromium (via Playwright) so the Zoom registration page's
 * own JavaScript executes and satisfies Cloudflare's checks the intended way.
 * For each subject in subjects.json it fills First/Last/Email and clicks
 * "Register". Zoom then emails the confirmation, which the Apps Script
 * (Stage 2) turns into a Google Calendar event.
 *
 * Personal details come from env vars (GitHub Secrets):
 *   ZOOM_FIRST, ZOOM_LAST, ZOOM_EMAIL
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const FIRST = process.env.ZOOM_FIRST;
const LAST = process.env.ZOOM_LAST;
const EMAIL = process.env.ZOOM_EMAIL;

if (!FIRST || !LAST || !EMAIL) {
  console.error('Missing ZOOM_FIRST / ZOOM_LAST / ZOOM_EMAIL environment variables.');
  process.exit(1);
}

const subjects = JSON.parse(readFileSync(new URL('./subjects.json', import.meta.url), 'utf8'))
  .filter((s) => s.url && !s.url.startsWith('PASTE_'));

if (subjects.length === 0) {
  console.error('No usable register URLs in subjects.json (all still placeholders).');
  process.exit(1);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

// Find the input whose label/name/placeholder matches `pattern`, then fill it.
async function fillField(page, pattern, value) {
  const handle = await page.evaluateHandle((p) => {
    const rx = new RegExp(p, 'i');
    const hint = (e) => {
      const b = [e.id, e.name, e.placeholder, e.getAttribute('aria-label') || ''];
      if (e.id) {
        const l = document.querySelector('label[for="' + e.id + '"]');
        if (l) b.push(l.textContent);
      }
      const w = e.closest('label');
      if (w) b.push(w.textContent);
      return b.join(' ');
    };
    const inputs = Array.from(document.querySelectorAll('input'));
    return inputs.find((e) => rx.test(hint(e))) || null;
  }, pattern);

  const el = handle.asElement();
  if (!el) throw new Error('Field not found for /' + pattern + '/');
  await el.fill(value);
}

async function registerOnPage(page, subject) {
  await page.goto(subject.url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('input', { timeout: 30000 });

  await fillField(page, 'first', FIRST);
  await fillField(page, 'last|surname', LAST);
  await fillField(page, 'e-?mail', EMAIL);

  await page.getByRole('button', { name: /register/i }).first().click();

  // Wait for a success signal (approval text, join link, or "already registered").
  await page
    .waitForFunction(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return (
        t.includes('approved') ||
        t.includes('has been received') ||
        t.includes('thank you for registering') ||
        t.includes('already registered') ||
        !!document.querySelector('a[href*="/w/"]')
      );
    }, { timeout: 30000 })
    .catch(() => { /* fall through; we log page text below */ });

  const text = (await page.innerText('body')).toLowerCase();
  if (text.includes('already registered')) return 'already-registered';
  if (
    text.includes('approved') ||
    text.includes('thank you for registering') ||
    text.includes('has been received') ||
    (await page.$('a[href*="/w/"]'))
  ) {
    return 'registered';
  }
  return 'uncertain';
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'Asia/Kolkata',
  viewport: { width: 1280, height: 900 }
});

let failures = 0;
for (const subject of subjects) {
  const page = await context.newPage();
  try {
    console.log(`\n=== ${subject.name} ===`);
    const result = await registerOnPage(page, subject);
    console.log(`Result: ${result}`);
    if (result === 'uncertain') {
      failures++;
      await page
        .screenshot({ path: `fail-${slug(subject.name)}.png`, fullPage: true })
        .catch(() => {});
    }
  } catch (e) {
    failures++;
    console.error(`FAILED ${subject.name}: ${e.message}`);
    await page
      .screenshot({ path: `fail-${slug(subject.name)}.png`, fullPage: true })
      .catch(() => {});
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(`\nDone. ${subjects.length - failures}/${subjects.length} succeeded.`);
process.exit(failures ? 1 : 0);
