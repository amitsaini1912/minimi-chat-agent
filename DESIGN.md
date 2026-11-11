# DESIGN

## How it works

```
browser ──POST /api/chat (message, IANA time zone)──▶ server ──SSE──▶ browser
                                                       │
  1. recall (deterministic, ~1 ms)                      │
     - chrono + rules resolve "last Tuesday", "on 3 November", "since Monday" → local-day ranges
     - pull every exchange on those days + BM25 keyword matches from older conversations
     - render a <memory> block: resolved dates, what the user asked, what I answered, which URLs I cited
  2. one streaming Claude call with the server-side web_search tool
     - model decides whether to search; can run several searches (one per item) inside one request
     - search queries, result counts, text deltas and citations are streamed to the UI as they happen
     - pause_turn → hand the partial turn back and continue (long research turns)
  3. persist the turn: text + searches + cited sources + UTC time + user's local date
```

Code: `src/memory/temporal.ts` (date resolution), `src/memory/recall.ts` (retrieval + formatting),
`src/agent.ts` (model loop + streaming), `src/server.ts` (HTTP/SSE), `public/` (UI). `npm test` covers the date
logic, retrieval and the agent loop against a fake stream.

## Why this shape

**The hard part of the test set is time, not search.** "What did I ask you on 3 November? Is it still correct?"
needs three things the model is bad at alone: knowing today's date in the user's zone, calendar arithmetic, and an
exact record of what it said. So code does those; the model does judgement.
- *Dates are resolved in code.* "Last Tuesday" said on a Wednesday is genuinely ambiguous (yesterday, or a week
  ago). The resolver returns both readings and retrieval keeps whichever has a matching conversation; the model is
  told which it is. Day boundaries use the user's IANA time zone, not the server's UTC.
- *Memory is context, not a tool.* The brief allows one tool, and a `recall` tool would cost an extra model
  round-trip on exactly the questions that need it. Retrieval is cheap and deterministic, so it runs before the
  call and the model starts with the facts.
- *"No record" is stated explicitly.* If a referenced date has no conversation, the memory block says so. That is
  the single biggest guard against the worst failure here: confidently inventing what "we discussed on Monday".
- *Answers are stored with their sources and searches,* so "is that still correct?" re-checks the specific claims
  and URLs, and "has pricing changed since then?" has a concrete baseline date and list of items.

**Speed.** One streaming request per turn (server-side search, no client tool loop); no routing/classifier or
query-rewriter LLM call in front; no search for stable knowledge; the static system prompt and prior turns are
prompt-cached (memory goes into the *new* user message so the cached prefix stays byte-identical); prior turns are
replayed as final text only, not as bulky search-result blocks. The UI streams tokens and shows each search live,
so even a 15-second research turn feels responsive.

**Correctness.** Prompt pushes: search anything that can have changed; one search per named item; primary sources;
"as of" dates for volatile facts; per-item verdicts (unchanged / changed old→new / unverified) for re-checks.
Citations come from the API's own citation objects, not from the model typing URLs.

## Considered and rejected

- **Own search API (Tavily/Exa/Brave) + client-side tool loop.** More control over result shaping, but every search
  becomes an extra model round-trip and another key. Anthropic's server tool does multi-search in one request with
  grounded citations. Swapping is a contained change in `agent.ts`.
- **Vector DB / embeddings for memory.** The queries in scope are anchored by dates and named entities; date filter +
  BM25 is exact, explainable and has no extra dependency or latency. Embeddings would help paraphrased recall at scale.
- **Letting the model call a `recall` tool / do date maths.** Extra latency and a common failure source (off-by-
  one weekdays, wrong year). Rejected for deterministic pre-retrieval.
- **Planner → parallel workers → synthesiser multi-agent pipeline.** Slower and costlier for most chat turns; the
  model already fans out searches inside a single turn.
- **SQLite.** Native builds can break `npm install` on a reviewer's machine; a single-user JSON file with atomic
  writes is enough here and readable. It sits behind a small `Store` class.
- **Summarising old conversations into "memories".** Lossy exactly where it matters (exact prices, exact list of
  5 tools). Raw exchanges are stored and clipped at read time.

## With another week

- Eval harness: a scripted set of multi-session conversations with a fake clock (the `now` parameter already exists),
  graded for date resolution, "no record" honesty, citation correctness and latency, run on every prompt change.
- Claim extraction at write time (entity, attribute, value, source, date) so "what changed since" diffs structured
  claims instead of re-reading prose; also enables proactive "this has changed since I told you" notes.
- Hybrid recall (BM25 + embeddings) and entity linking ("the CRM thing" → the shortlist conversation).
- Fast-path model routing (small model for chit-chat, larger for research), measured, not guessed.
- Multi-user auth and SQLite/Postgres store; cancel button; result-page fetching for pages the index summarises poorly.
