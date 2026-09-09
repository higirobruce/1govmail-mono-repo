import { seedMailbox, type MemoryMailbox } from './memory-seed';

export type { MemoryMailbox };

/**
 * In-process store of seeded demo mailboxes, keyed by login email.
 *
 * Plain class today (Task 1); Task 6 wraps it as a Nest singleton provider.
 * `now` is injected so all "current time" in a seeded mailbox is deterministic
 * and testable — never `Date.now()`/`new Date()` directly.
 */
export class MemoryStore {
  private readonly mailboxes = new Map<string, MemoryMailbox>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  has(email: string): boolean {
    return this.mailboxes.has(email);
  }

  get(email: string): MemoryMailbox | undefined {
    return this.mailboxes.get(email);
  }

  /**
   * Seeds a mailbox for `email` on first call and caches it. Repeat calls are
   * idempotent — they return the SAME mailbox (same folders/messages/etc.),
   * only refreshing the stored password.
   */
  seedFor(email: string, password: string): MemoryMailbox {
    const existing = this.mailboxes.get(email);
    if (existing) {
      existing.password = password;
      return existing;
    }
    const mailbox = seedMailbox(email, password, this.now);
    this.mailboxes.set(email, mailbox);
    return mailbox;
  }

  reset(): void {
    this.mailboxes.clear();
  }
}
