/**
 * Optional demo data: writes a few past conversations dated relative to today, so the
 * memory features ("last Tuesday…", "on Monday we shortlisted…") can be tried immediately.
 * Answers are illustrative fixtures, not verified facts; the agent is expected to re-check them.
 *   npm run seed            (uses your system time zone)
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/memory/store.js';
import { addDays, localDate } from '../src/memory/temporal.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new Store(process.env.DATA_FILE || path.join(root, 'data', 'memory.json'));
const timeZone = process.env.SEED_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = localDate(new Date(), timeZone);
const dow = new Date(today + 'T00:00:00Z').getUTCDay();
const thisMonday = addDays(today, -((dow + 6) % 7));

function at(day: string, hhmm: string): string {
  // Interpret hh:mm on `day` in the user's zone.
  const guess = new Date(`${day}T${hhmm}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString();
}

async function add(day: string, title: string, q: string, a: string, sources: { url: string; title: string }[]) {
  const c = store.create(title, at(day, '10:00'));
  await store.append(c.id,
    { role: 'user', text: q, ts: at(day, '10:00'), localDate: day, timeZone },
    { role: 'assistant', text: a, ts: at(day, '10:01'), localDate: day, timeZone, searches: [title], sources });
}

const lastWeekTue = addDays(thisMonday, -6);
const monday = today === thisMonday ? addDays(thisMonday, -7) : thisMonday;

await add(lastWeekTue, 'Postgres hosting for a side project',
  'What are the cheapest managed Postgres hosting options for a small side project?',
  'For a small project the main options are **Neon** (serverless, generous free tier, usage-based paid plans), ' +
  '**Supabase** (free tier, Pro plan around $25/month), **Render** (low-cost starter Postgres instances) and ' +
  '**AWS RDS** (most flexible, but more expensive once the free tier ends). For a side project I suggested starting on Neon or Supabase free tiers.',
  [{ url: 'https://neon.tech/pricing', title: 'Neon pricing' }, { url: 'https://supabase.com/pricing', title: 'Supabase pricing' }, { url: 'https://render.com/pricing', title: 'Render pricing' }]);

await add(monday, 'CRM shortlist for 20-person sales team',
  'We need a CRM for a 20-person sales team. Help me shortlist 5.',
  'Shortlist: **HubSpot Sales Hub**, **Salesforce Sales Cloud**, **Pipedrive**, **Zoho CRM**, **Close**. ' +
  'HubSpot and Salesforce are the most complete but priciest per seat; Pipedrive is the simplest pipeline tool; Zoho is the best value; Close suits call-heavy inside sales.',
  [{ url: 'https://www.hubspot.com/pricing/sales', title: 'HubSpot Sales pricing' }, { url: 'https://www.pipedrive.com/en/pricing', title: 'Pipedrive pricing' }]);

console.log(`Seeded demo conversations on ${lastWeekTue} and ${monday} (${timeZone}) into ${path.relative(root, (store as any).file)}`);
