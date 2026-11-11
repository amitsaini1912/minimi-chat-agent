import Anthropic from '@anthropic-ai/sdk';
import type { Store, Turn, Source } from './memory/store.js';
import { recall, formatRecall } from './memory/recall.js';
import { localDate, prettyDay } from './memory/temporal.js';
import { SYSTEM_STATIC, systemDynamic } from './prompt.js';

export type AgentEvent =
  | { type: 'meta'; conversationId: string; title: string }
  | { type: 'recall'; dates: { phrase: string; resolved: string; matches: number }[]; related: number }
  | { type: 'search'; id: string; query: string }
  | { type: 'results'; id: string; count: number; error?: string; top: { title: string; url: string }[] }
  | { type: 'text'; delta: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'done'; ms: number; searches: number; usage: Record<string, number> }
  | { type: 'error'; message: string };

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES_PER_TURN || 8);
const HISTORY_TURNS = 24;
const MAX_CONTINUATIONS = 4;

let defaultClient: Anthropic | undefined;
/** Minimal surface used here, so tests can inject a fake stream. */
export type StreamingClient = Pick<Anthropic, 'messages'>;

function stamp(ts: string | Date, timeZone: string) {
  return new Date(ts).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone,
  });
}

export async function runTurn(opts: {
  store: Store; conversationId?: string; message: string; timeZone: string;
  emit: (e: AgentEvent) => void; signal: AbortSignal; now?: Date; client?: StreamingClient;
}): Promise<void> {
  const client = opts.client ?? (defaultClient ??= new Anthropic());
  const { store, message, timeZone, emit, signal } = opts;
  const started = Date.now();
  const now = opts.now ?? new Date();

  const conv = (opts.conversationId && store.get(opts.conversationId)) ||
    store.create(message.replace(/\s+/g, ' ').slice(0, 60), now.toISOString());
  emit({ type: 'meta', conversationId: conv.id, title: conv.title });

  // 1. Context: recent window of this conversation as real messages, everything else via recall.
  let window = conv.turns.slice(-HISTORY_TURNS);
  while (window.length && window[0].role !== 'user') window = window.slice(1);
  const windowStart = conv.turns.length - window.length;

  const r = recall({ message, conversations: store.all(), currentId: conv.id, excludeTurnsFrom: windowStart, now, timeZone });
  emit({
    type: 'recall',
    dates: r.byDate.map(({ range, exchanges }) => ({
      phrase: range.phrase,
      resolved: (range.alternatives ?? [range]).map((w) => w.from === w.to ? prettyDay(w.from) : `${prettyDay(w.from)} – ${prettyDay(w.to)}`).join(' or '),
      matches: exchanges.length,
    })),
    related: r.related.length,
  });

  const messages: Anthropic.MessageParam[] = window.map((t) => ({
    role: t.role,
    content: t.role === 'user' ? `[${stamp(t.ts, t.timeZone)}] ${t.text}` : t.text || '(no answer)',
  }));
  // Cache breakpoint at the end of the stable prefix (system + prior turns), so follow-ups are cheaper and faster.
  if (messages.length) {
    const last = messages[messages.length - 1];
    last.content = [{ type: 'text', text: last.content as string, cache_control: { type: 'ephemeral' } }];
  }
  // Memory goes in the new user message, not the system prompt, so the cached prefix stays byte-identical.
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: systemDynamic(stamp(now, timeZone), timeZone, formatRecall(r, timeZone)) },
      { type: 'text', text: `[${stamp(now, timeZone)}] ${message}` },
    ],
  });

  // 2. Model loop. Web search is a server-side tool: one streaming request can contain several searches.
  let text = '';
  const searches: string[] = [];
  const sources: Source[] = [];
  const sourceIndex = new Map<string, number>();
  const usage: Record<string, number> = {};

  for (let i = 0; i < MAX_CONTINUATIONS; i++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_STATIC, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES } as Anthropic.WebSearchTool20250305],
      messages,
    }, { signal });

    const blocks = new Map<number, { type: string; id?: string; json: string; cites: number[] }>();
    for await (const ev of stream) {
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        blocks.set(ev.index, { type: b.type, id: (b as { id?: string }).id, json: '', cites: [] });
        if (b.type === 'web_search_tool_result') {
          const c = b.content;
          if (Array.isArray(c)) {
            emit({ type: 'results', id: b.tool_use_id, count: c.length, top: c.slice(0, 4).map((x) => ({ title: x.title, url: x.url })) });
          } else emit({ type: 'results', id: b.tool_use_id, count: 0, error: c.error_code, top: [] });
        }
      } else if (ev.type === 'content_block_delta') {
        const blk = blocks.get(ev.index)!;
        const d = ev.delta;
        if (d.type === 'text_delta') { text += d.text; emit({ type: 'text', delta: d.text }); }
        else if (d.type === 'input_json_delta') blk.json += d.partial_json;
        else if (d.type === 'citations_delta' && d.citation.type === 'web_search_result_location') {
          const { url, title } = d.citation;
          if (!sourceIndex.has(url)) { sources.push({ url, title: title || url }); sourceIndex.set(url, sources.length); }
          const n = sourceIndex.get(url)!;
          if (!blk.cites.includes(n)) blk.cites.push(n);
        }
      } else if (ev.type === 'content_block_stop') {
        const blk = blocks.get(ev.index)!;
        if (blk.type === 'server_tool_use') {
          let query = '';
          try { query = JSON.parse(blk.json || '{}').query ?? ''; } catch { /* partial input */ }
          searches.push(query);
          emit({ type: 'search', id: blk.id!, query });
        } else if (blk.type === 'text' && blk.cites.length) {
          // Inline citation markers right after the sentence they support.
          const marks = blk.cites.map((n) => `[[${n}]](${sources[n - 1].url})`).join('');
          text += marks; emit({ type: 'text', delta: marks });
        }
      }
    }
    const final = await stream.finalMessage();
    for (const [k, v] of Object.entries(final.usage ?? {})) if (typeof v === 'number') usage[k] = (usage[k] ?? 0) + v;
    if (final.stop_reason !== 'pause_turn') break;
    // Long research turns get paused server-side; hand the partial turn back to continue it.
    messages.push({ role: 'assistant', content: final.content });
  }

  emit({ type: 'sources', sources });

  // 3. Persist. The answer is stored with its searches and sources so a later
  // "is that still correct?" can re-verify the exact claims.
  const ld = localDate(now, timeZone);
  const userTurn: Turn = { role: 'user', text: message, ts: now.toISOString(), localDate: ld, timeZone };
  const done = new Date();
  const asstTurn: Turn = { role: 'assistant', text: text.trim(), ts: done.toISOString(), localDate: localDate(done, timeZone), timeZone, searches, sources };
  await store.append(conv.id, userTurn, asstTurn);

  emit({ type: 'done', ms: Date.now() - started, searches: searches.length, usage });
}
