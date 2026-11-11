import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Source { url: string; title: string }

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  /** UTC ISO timestamp. */
  ts: string;
  /** User's local calendar day when the turn happened (YYYY-MM-DD). Indexed for date recall. */
  localDate: string;
  timeZone: string;
  /** Assistant only: what was searched and what was cited, so later turns can re-verify. */
  searches?: string[];
  sources?: Source[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
}

/**
 * Append-mostly JSON store. One user, one process, tiny data: a file is the simplest thing
 * that survives restarts and that a reviewer can open and read. Writes are atomic
 * (tmp + rename) and serialised through a promise chain.
 */
export class Store {
  private data: { conversations: Conversation[] } = { conversations: [] };
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string) {
    if (existsSync(file)) this.data = JSON.parse(readFileSync(file, 'utf8'));
  }

  list(): Omit<Conversation, 'turns'>[] {
    return [...this.data.conversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...rest }) => rest);
  }

  all(): Conversation[] {
    return this.data.conversations;
  }

  get(id: string): Conversation | undefined {
    return this.data.conversations.find((c) => c.id === id);
  }

  create(title: string, at = new Date().toISOString()): Conversation {
    const c: Conversation = { id: randomUUID(), title, createdAt: at, updatedAt: at, turns: [] };
    this.data.conversations.push(c);
    return c;
  }

  async append(id: string, ...turns: Turn[]): Promise<void> {
    const c = this.get(id);
    if (!c) throw new Error('conversation not found');
    c.turns.push(...turns);
    c.updatedAt = turns[turns.length - 1].ts;
    await this.flush();
  }

  async remove(id: string): Promise<void> {
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
    await this.flush();
  }

  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }
}
