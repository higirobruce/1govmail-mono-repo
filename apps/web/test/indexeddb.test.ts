import { describe, it, expect, beforeEach } from 'vitest';
import Dexie, { type Table } from 'dexie';

interface Row {
  id: string;
  value: string;
}

class TestDB extends Dexie {
  rows!: Table<Row, string>;
  constructor(name: string) {
    super(name);
    this.version(1).stores({ rows: 'id' });
  }
}

describe('Dexie + fake-indexeddb', () => {
  let db: TestDB;

  beforeEach(async () => {
    const name = `test-db-${crypto.randomUUID()}`;
    db = new TestDB(name);
    await db.open();
  });

  it('writes and reads through Dexie', async () => {
    await db.rows.put({ id: 'a', value: 'hello' });
    const got = await db.rows.get('a');
    expect(got?.value).toBe('hello');
  });

  it('persists multiple rows and queries them', async () => {
    await db.rows.bulkPut([
      { id: '1', value: 'one' },
      { id: '2', value: 'two' },
      { id: '3', value: 'three' },
    ]);
    const all = await db.rows.toArray();
    expect(all).toHaveLength(3);
  });
});
