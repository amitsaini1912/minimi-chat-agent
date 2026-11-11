import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/memory/store.js';
import { runTurn, type AgentEvent, type StreamingClient } from '../src/agent.js';

/** Fake Anthropic client: replays scripted raw stream events, records the requests it got. */
function fakeClient(scripts: { events: any[]; stop: string; content?: any[] }[]) {
  const calls: any[] = [];
  const client = {
    messages: {
      stream(params: any) {
        calls.push(structuredClone(params));
        const s = scripts[calls.length - 1];
        return {
          async *[Symbol.asyncIterator]() { for (const e of s.events) yield e; },
          finalMessage: async () => ({ stop_reason: s.stop, content: s.content ?? [], usage: { input_tokens: 10, output_tokens: 5 } }),
        };
      },
    },
  } as unknown as StreamingClient;
  return { client, calls };
}

const searchEvents = (i: number, id: string, query: string) => [
  { type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } },
  { type: 'content_block_stop', index: i },
  { type: 'content_block_start', index: i + 1, content_block: { type: 'web_search_tool_result', tool_use_id: id, content: [{ type: 'web_search_result', url: 'https://neon.tech/pricing', title: 'Neon pricing' }] } },
  { type: 'content_block_stop', index: i + 1 },
];
const citedText = (i: number, text: string) => [
  { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://neon.tech/pricing', title: 'Neon pricing', cited_text: 'x' } } },
  { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: i },
];

test('streams searches + cited text, continues after pause_turn, persists the turn', async () => {
  const store = new Store(path.join(os.tmpdir(), `agent-test-${Date.now()}.json`));
  const { client, calls } = fakeClient([
    { events: searchEvents(0, 's1', 'Neon pricing change'), stop: 'pause_turn', content: [{ type: 'text', text: 'partial' }] },
    { events: citedText(0, 'Neon cut storage prices.'), stop: 'end_turn' },
  ]);
  const events: AgentEvent[] = [];
  await runTurn({ store, message: 'Has Neon pricing changed?', timeZone: 'UTC', emit: (e) => events.push(e), signal: new AbortController().signal, client, now: new Date('2026-11-11T10:00:00Z') });

  assert.deepEqual(events.filter((e) => e.type === 'search').map((e: any) => e.query), ['Neon pricing change']);
  assert.equal(calls.length, 2, 'pause_turn triggers a continuation');
  assert.equal(calls[1].messages.at(-1).role, 'assistant');
  const text = events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');
  assert.equal(text, 'Neon cut storage prices.[[1]](https://neon.tech/pricing)');

  const conv = store.all()[0];
  assert.equal(conv.turns.length, 2);
  assert.equal(conv.turns[1].sources?.[0].url, 'https://neon.tech/pricing');
  assert.deepEqual(conv.turns[1].searches, ['Neon pricing change']);
});

test('second turn sends prior turns as cached history and memory only in the new message', async () => {
  const store = new Store(path.join(os.tmpdir(), `agent-test2-${Date.now()}.json`));
  const run = async (message: string, convId?: string) => {
    const { client, calls } = fakeClient([{ events: citedText(0, 'ok'), stop: 'end_turn' }]);
    let id = convId;
    await runTurn({ store, conversationId: convId, message, timeZone: 'UTC', emit: (e) => { if (e.type === 'meta') id = e.conversationId; }, signal: new AbortController().signal, client });
    return { calls, id: id! };
  };
  const first = await run('hello');
  const { calls } = await run('and now?', first.id);
  const msgs = calls[0].messages;
  assert.equal(msgs.length, 3);
  assert.ok(msgs[1].content[0].cache_control, 'cache breakpoint on last history message');
  assert.match(msgs[2].content[0].text, /<memory>/);
  assert.equal(calls[0].system[0].cache_control.type, 'ephemeral');
});
