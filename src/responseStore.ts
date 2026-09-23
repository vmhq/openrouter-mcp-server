/**
 * Holds full delegated answers that are too large to return inline.
 *
 * A tool result that is megabytes long either blows the calling agent's
 * context or gets clipped by its client — the answer looks truncated even
 * though the delegated model finished cleanly. Instead the tool returns a
 * first page plus an id, and the agent pulls the rest with
 * openrouter_fetch_response at its own pace.
 *
 * In-memory and per-process on purpose: entries are short-lived, disappear on
 * restart, and are not shared between replicas.
 */

const MAX_ENTRIES = 32;
const TTL_MS = 30 * 60 * 1000;

export interface StoredResponse {
  id: string;
  text: string;
  model: string;
  createdAt: number;
}

export interface ResponsePage {
  text: string;
  offset: number;
  next_offset: number | null;
  total_chars: number;
  has_more: boolean;
}

export class ResponseStore {
  private entries = new Map<string, StoredResponse>();
  private counter = 0;

  constructor(
    private maxEntries = MAX_ENTRIES,
    private ttlMs = TTL_MS,
    private now: () => number = Date.now
  ) {}

  private evict(): void {
    for (const [id, entry] of this.entries) {
      if (this.now() - entry.createdAt > this.ttlMs) this.entries.delete(id);
    }
    // Map preserves insertion order, so the first key is the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  put(text: string, model: string): StoredResponse {
    const entry: StoredResponse = {
      id: `resp_${(++this.counter).toString(36)}_${this.now().toString(36)}`,
      text,
      model,
      createdAt: this.now(),
    };
    this.entries.set(entry.id, entry);
    this.evict();
    return entry;
  }

  get(id: string): StoredResponse | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  page(id: string, offset: number, limit: number): ResponsePage | undefined {
    const entry = this.get(id);
    if (!entry) return undefined;
    return pageOf(entry.text, offset, limit);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Slices text into a page, clamping the bounds to the available range. */
export function pageOf(text: string, offset: number, limit: number): ResponsePage {
  const start = Math.max(0, Math.min(offset, text.length));
  const end = Math.min(text.length, start + Math.max(1, limit));
  return {
    text: text.slice(start, end),
    offset: start,
    next_offset: end < text.length ? end : null,
    total_chars: text.length,
    has_more: end < text.length,
  };
}
