import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimeReferences } from '../src/memory/temporal.js';
import { recall, formatRecall } from '../src/memory/recall.js';
import type { Conversation } from '../src/memory/store.js';

// Wednesday 11 Nov 2026, 15:30 in India.
const now = new Date('2026-11-11T10:00:00Z');
const tz = 'Asia/Kolkata';

test('absolute date without year resolves to the past', () => {
  const [r] = resolveTimeReferences('What did I ask you on 3 November?', now, tz);
  assert.equal(r.from, '2026-11-03');
});

test('a date later in the year means last year', () => {
  const [r] = resolveTimeReferences('what did we discuss on 20 December', now, tz);
  assert.equal(r.from, '2025-12-20');
});

test('bare weekday resolves to the most recent one', () => {
  const [r] = resolveTimeReferences('On Monday we shortlisted 5 CRM tools', now, tz);
  assert.equal(r.from, '2026-11-09');
});

test('"last Tuesday" on a Wednesday is ambiguous', () => {
  const [r] = resolveTimeReferences('Last Tuesday I asked you about Postgres hosting', now, tz);
  assert.deepEqual(r.alternatives?.map((a) => a.from), ['2026-11-10', '2026-11-03']);
});

test('"last week" is the previous Mon-Sun', () => {
  const [r] = resolveTimeReferences('anything from last week?', now, tz);
  assert.deepEqual([r.from, r.to], ['2026-11-02', '2026-11-08']);
});

test('local day boundary uses the user time zone, not UTC', () => {
  // 20:00 UTC on 10 Nov is already 11 Nov in Kolkata, still 10 Nov in New York.
  const late = new Date('2026-11-10T20:00:00Z');
  assert.equal(resolveTimeReferences('today', late, tz)[0].from, '2026-11-11');
  assert.equal(resolveTimeReferences('today', late, 'America/New_York')[0].from, '2026-11-10');
});

const conv = (id: string, title: string, day: string, q: string, a: string): Conversation => ({
  id, title, createdAt: day + 'T05:00:00Z', updatedAt: day + 'T05:01:00Z',
  turns: [
    { role: 'user', text: q, ts: day + 'T05:00:00Z', localDate: day, timeZone: tz },
    { role: 'assistant', text: a, ts: day + 'T05:01:00Z', localDate: day, timeZone: tz, sources: [{ url: 'https://neon.tech/pricing', title: 'Neon' }] },
  ],
});
const convs = [
  conv('a', 'Postgres hosting', '2026-11-03', 'Cheapest managed Postgres hosting?', 'Neon, Supabase, Render.'),
  conv('b', 'Pasta recipe', '2026-11-10', 'Quick pasta recipe?', 'Aglio e olio.'),
  conv('c', 'Kafka vs RabbitMQ', '2026-10-20', 'Kafka or RabbitMQ for events?', 'Kafka for replay.'),
];

test('ambiguous weekday picks the date whose conversation matches', () => {
  const r = recall({ message: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed?', conversations: convs, now, timeZone: tz });
  const ex = r.byDate[0].exchanges;
  assert.ok(ex.some((e) => e.conv.id === 'a'));
  assert.match(formatRecall(r, tz), /neon\.tech\/pricing/);
});

test('missing date is reported as no record', () => {
  const r = recall({ message: 'What did I ask you on 5 November?', conversations: convs, now, timeZone: tz });
  assert.equal(r.byDate[0].exchanges.length, 0);
  assert.match(formatRecall(r, tz), /NO recorded conversations/);
});

test('unrelated history does not leak into a fresh question', () => {
  const r = recall({ message: 'What is the population of Japan?', conversations: convs, now, timeZone: tz });
  assert.equal(r.related.length, 0);
});

test('topic recall without a date finds the earlier exchange', () => {
  const r = recall({ message: 'You recommended something for message queues earlier, Kafka right?', conversations: convs, now, timeZone: tz });
  assert.equal(r.related[0]?.conv.id, 'c');
});
