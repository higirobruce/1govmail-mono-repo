import Dexie, { type Table } from 'dexie';

export type OutboxStatus = 'pending' | 'running' | 'failed';

export interface OutboxOp {
  id: string;
  kind: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  createdAt: number;
  scheduledAt: number;
  idempotencyKey?: string;
}

export interface CachedFolderPage {
  folderId: string;
  data: unknown;
  fetchedAt: number;
}

export interface CachedMessage {
  id: string;
  data: unknown;
  fetchedAt: number;
  lastAccessedAt: number;
}

export class OfflineDB extends Dexie {
  outbox!: Table<OutboxOp, string>;
  folderPages!: Table<CachedFolderPage, string>;
  messages!: Table<CachedMessage, string>;

  constructor(name = 'offline') {
    super(name);
    this.version(1).stores({
      outbox: 'id, [status+scheduledAt], idempotencyKey',
    });
    this.version(2).stores({
      outbox: 'id, [status+scheduledAt], idempotencyKey',
      folderPages: 'folderId, fetchedAt',
      messages: 'id, lastAccessedAt',
    });
  }
}
