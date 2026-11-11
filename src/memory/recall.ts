import type { Conversation, Turn } from './store.js';
import { resolveTimeReferences, prettyDay, RECALL_CUE, type DayRange } from './temporal.js';

const STOP = new Set(('a an the and or but of to in on at for with from by is are was were be been it this that these those ' +
  'i you we my me our your us what which who how when did do does has have had any since still today now then ' +
  'ask asked tell told said say about there their them they can could would should will just also more most last ' +
  'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august ' +
  'september october november december yesterday week month day days ago earlier previous previously answer correct').split(' '));

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9+#.]+/).map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d{1,2}$/.test(t));
}

interface Doc { conv: Conversation; idx: number; tokens: string[] }

/** Small BM25 over exchanges (user turn + following assistant turn). Rebuilt per query: data is tiny. */
function bm25(query: string[], docs: Doc[]): Map<Doc, number> {
  const scores = new Map<Doc, number>();
  if (!query.length || !docs.length) return scores;
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  for (const d of docs) {
    let s = 0;
    for (const q of new Set(query)) {
      const f = d.tokens.filter((t) => t === q).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(q)! + 0.5) / (df.get(q)! + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.tokens.length / avg));
    }
    if (s > 0) scores.set(d, s);
  }
  return scores;
}

export interface Exchange { conv: Conversation; user: Turn; assistant?: Turn; score: number }

export interface RecallResult {
  ranges: DayRange[];
  /** Exchanges from the referenced dates, keyed by range phrase. */
  byDate: { range: DayRange; exchanges: Exchange[] }[];
  /** Keyword matches outside the referenced dates. */
  related: Exchange[];
  recent: Omit<Conversation, 'turns'>[];
}

/**
 * Deterministic retrieval that runs before the model sees the message. Memory is context,
 * not a tool: the model gets the right past exchanges up front instead of spending a
 * round-trip deciding to look them up.
 */
export function recall(opts: {
  message: string; conversations: Conversation[]; currentId?: string; excludeTurnsFrom?: number;
  now: Date; timeZone: string;
}): RecallResult {
  const { message, conversations, currentId, now, timeZone } = opts;
  const ranges = resolveTimeReferences(message, now, timeZone);
  const q = tokenize(message);

  const docs: Doc[] = [];
  for (const conv of conversations) {
    conv.turns.forEach((t, idx) => {
      if (t.role !== 'user') return;
      // Turns of the current conversation that are already in the model's window are skipped.
      if (conv.id === currentId && idx >= (opts.excludeTurnsFrom ?? 0)) return;
      const a = conv.turns[idx + 1]?.role === 'assistant' ? conv.turns[idx + 1] : undefined;
      docs.push({ conv, idx, tokens: tokenize(conv.title + ' ' + t.text + ' ' + (a?.text ?? '').slice(0, 2000)) });
    });
  }
  const scores = bm25(q, docs);
  const toEx = (d: Doc): Exchange => {
    const a = d.conv.turns[d.idx + 1];
    return { conv: d.conv, user: d.conv.turns[d.idx], assistant: a?.role === 'assistant' ? a : undefined, score: scores.get(d) ?? 0 };
  };

  const inDates = new Set<Doc>();
  const byDate = ranges.map((range) => {
    const windows = range.alternatives ?? [range];
    const hits = docs.filter((d) => windows.some((w) => d.conv.turns[d.idx].localDate >= w.from && d.conv.turns[d.idx].localDate <= w.to));
    hits.forEach((h) => inDates.add(h));
    // Within a date, rank by topical match, then keep chronological order for readability.
    const ranked = hits.map(toEx).sort((a, b) => b.score - a.score).slice(0, 8)
      .sort((a, b) => a.user.ts.localeCompare(b.user.ts));
    return { range, exchanges: ranked };
  });

  const cue = RECALL_CUE.test(message) || ranges.length > 0;
  const top = [...scores.entries()].filter(([d]) => !inDates.has(d)).sort((a, b) => b[1] - a[1]);
  const best = top[0]?.[1] ?? 0;
  // Without an explicit recall cue, only surface strong matches so unrelated history doesn't leak in.
  const threshold = cue ? best * 0.35 : Math.max(3, best * 0.6);
  const related = top.filter(([, s]) => s >= threshold).slice(0, cue ? 5 : 2).map(([d]) => toEx(d));

  const recent = conversations.filter((c) => c.id !== currentId && c.turns.length)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12)
    .map(({ turns, ...rest }) => rest);

  return { ranges, byDate, related, recent };
}

function clip(s: string, n: number) { return s.length > n ? s.slice(0, n) + ' …[truncated]' : s; }

function time(ts: string, timeZone: string) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
}

function formatExchange(e: Exchange, timeZone: string): string {
  const lines = [`- [${prettyDay(e.user.localDate)} ${time(e.user.ts, timeZone)}] in "${e.conv.title}"`,
    `  User asked: ${clip(e.user.text, 600)}`];
  if (e.assistant) {
    lines.push(`  You answered: ${clip(e.assistant.text, 1800).replace(/\n/g, '\n  ')}`);
    if (e.assistant.sources?.length) lines.push(`  Sources you cited then: ${e.assistant.sources.slice(0, 8).map((s) => s.url).join(' , ')}`);
  } else lines.push('  (no answer was recorded)');
  return lines.join('\n');
}

/** Render recall as a compact block for the system prompt. */
export function formatRecall(r: RecallResult, timeZone: string): string {
  const out: string[] = [];
  if (r.ranges.length) {
    out.push('Date references in the latest message, resolved by code (trust these, do not recompute):');
    for (const { range, exchanges } of r.byDate) {
      const span = range.from === range.to ? prettyDay(range.from) : `${prettyDay(range.from)} to ${prettyDay(range.to)}`;
      if (range.alternatives) {
        out.push(`- "${range.phrase}" is ambiguous: ${range.alternatives.map((a) => `${a.label} = ${prettyDay(a.from)}`).join(' OR ')}. ` +
          'Use whichever has a matching conversation; if both or neither, say which you assumed.');
      } else out.push(`- "${range.phrase}" = ${span}`);
      if (exchanges.length) {
        out.push('  Your conversations from that time:');
        exchanges.forEach((e) => out.push('  ' + formatExchange(e, timeZone).replace(/\n/g, '\n  ')));
      } else {
        out.push('  NO recorded conversations on that date. You have no record of what was said then.');
      }
    }
  }
  if (r.related.length) {
    out.push('Possibly related earlier exchanges (keyword match; may or may not be what the user means):');
    r.related.forEach((e) => out.push(formatExchange(e, timeZone)));
  }
  if (r.recent.length) {
    out.push('Index of recent conversations (title, last active): ' +
      r.recent.map((c) => `"${c.title}" (${c.updatedAt.slice(0, 10)})`).join('; '));
  } else out.push('There are no earlier conversations with this user in memory.');
  return out.join('\n');
}
