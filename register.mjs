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
  .map((s) => ({ ...s, url: (s.url || '').trim() }))
  .filter((s) => s.url && !s.url.startsWith('PASTE_'));

if (subjects.length === 0) {
  console.error('No usable register URLs in subjects.json (all still placeholders).');
  process.exit(1);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

// Fill the first VISIBLE field matching any candidate locator (skips hidden inputs).
async function fillFirst(page, value, candidates, label) {
  for (const make of candidates) {
    const loc = make(page).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 8000 });
      await loc.fill(value);
      return;
    } catch { /* try the next candidate */ }
  }
  throw new Error('No visible field matched for ' + label);
}

async function registerOnPage(page, subject) {
  await page.goto(subject.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Form is ready once the VISIBLE First Name field appears (not the hidden inputs).
  const firstName = page.getByPlaceholder(/first name/i).or(page.getByLabel(/first name/i));
  await firstName.first().waitFor({ state: 'visible', timeout: 45000 });
  await firstName.first().fill(FIRST);

  await fillFirst(page, LAST, [
    (p) => p.getByPlaceholder(/last name|surname/i),
    (p) => p.getByLabel(/last name|surname/i)
  ], 'last name');

  await fillFirst(page, EMAIL, [
    (p) => p.getByPlaceholder(/@|e-?mail/i),
    (p) => p.getByLabel(/e-?mail/i),
    (p) => p.locator('input[type="email"]')
  ], 'email');

  // Let React commit the field values before submitting.
  await page.waitForTimeout(300);

  const urlBefore = page.url();
  // Button reads "Register" or "Register and Join" (when the meeting has started).
  await page.getByRole('button', { name: /register/i }).first().click();

  // Success = confirmation text, a join link, "already registered", or navigation.
  try {
    await Promise.race([
      page.waitForURL((u) => u.toString() !== urlBefore, { timeout: 20000 }),
      page.waitForFunction(() => {
        const t = (document.body.innerText || '').toLowerCase();
        return (
          t.includes('approved') ||
          t.includes('has been received') ||
          t.includes('thank you for registering') ||
          t.includes('already registered') ||
          !!document.querySelector('a[href*="/w/"]')
        );
      }, { timeout: 20000 })
    ]);
  } catch { /* fall through to text inspection */ }

  const text = (await page.innerText('body').catch(() => '')).toLowerCase();
  if (text.includes('already registered')) return 'already-registered';
  if (
    page.url() !== urlBefore ||
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
