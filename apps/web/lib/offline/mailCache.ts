import type { CachedFolderPage, CachedMessage, OfflineDB } from './db';

export interface MailCacheDeps {
  now?: () => number;
}

const DEFAULT_MESSAGE_CAP = 200;

export class MailCache {
  private readonly now: () => number;

  constructor(private readonly db: OfflineDB, deps: MailCacheDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  async setFolderPage(folderId: string, data: unknown): Promise<void> {
    const row: CachedFolderPage = { folderId, data, fetchedAt: this.now() };
    await this.db.folderPages.put(row);
  }

  async getFolderPage(folderId: string): Promise<CachedFolderPage | undefined> {
    return this.db.folderPages.get(folderId);
  }

  async setMessage(id: string, data: unknown): Promise<void> {
    const ts = this.now();
    const row: CachedMessage = { id, data, fetchedAt: ts, lastAccessedAt: ts };
    await this.db.messages.put(row);
  }

  async getMessage(id: string): Promise<CachedMessage | undefined> {
    const row = await this.db.messages.get(id);
    if (!row) return undefined;
    const ts = this.now();
    await this.db.messages.update(id, { lastAccessedAt: ts });
    return { ...row, lastAccessedAt: ts };
  }

  async evictOldMessages(cap = DEFAULT_MESSAGE_CAP): Promise<number> {
    const total = await this.db.messages.count();
    if (total <= cap) return 0;
    const overflow = total - cap;
    const victims = await this.db.messages
      .orderBy('lastAccessedAt')
      .limit(overflow)
      .primaryKeys();
    if (victims.length === 0) return 0;
    await this.db.messages.bulkDelete(victims);
    return victims.length;
  }

  async clear(): Promise<void> {
    await Promise.all([this.db.folderPages.clear(), this.db.messages.clear()]);
  }
}
