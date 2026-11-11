# Chat agent with web search and date-aware memory

A chat agent with one tool, web search, that also remembers past conversations by date, so it can answer things like:

- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?"

## Run

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY
npm install
npm run dev               # http://localhost:3000
```

Needs Node 20+ and an Anthropic API key with web search enabled for your organization in the Anthropic Console.

Optional:

```bash
npm run seed   # adds two demo past conversations (last week's Tuesday: Postgres hosting, this Monday: CRM shortlist)
npm test       # date resolution, retrieval, and the agent loop against a fake stream
```

Conversations are stored in `data/memory.json`.

See [DESIGN.md](DESIGN.md) for how it works and why.
