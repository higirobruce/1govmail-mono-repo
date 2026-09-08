import { buildCalendarTools } from './calendar.tools';
import type { ToolContext } from '../tool-registry';

function makeCtx(): ToolContext {
  let n = 0;
  return { userId: 'u1', userEmail: 'u1@x.rw', aliasFor: () => `s${++n}`, emitChart: jest.fn() };
}

const calendar = {
  getEvents: jest.fn().mockResolvedValue([
    { id: 'e1', title: 'Standup', startAt: new Date('2026-09-07T08:00:00Z'), endAt: new Date('2026-09-07T08:30:00Z'), attendees: [{ email: 'a@b.rw' }] },
  ]),
  getFreeBusyBatch: jest.fn().mockResolvedValue([
    { email: 'a@b.rw', busy: [{ s: 1789200000000, e: 1789203600000 }], tentative: [], unavailable: [] },
  ]),
} as any;

const tools = buildCalendarTools(calendar);
const byName = (n: string) => tools.find((t) => t.name === n)!;

describe('calendar tools', () => {
  it('list_events converts ISO strings to Dates and returns event refs', async () => {
    const res = await byName('list_events').execute(
      { startDate: '2026-09-07T00:00:00Z', endDate: '2026-09-08T00:00:00Z' }, makeCtx(),
    );
    expect(calendar.getEvents).toHaveBeenCalledWith('u1', expect.any(Date), expect.any(Date));
    expect(res.refs![0]).toMatchObject({ type: 'event', id: 'e1', alias: 's1' });
    expect(res.content).toContain('Standup');
    expect(res.content).toContain('a@b.rw');
    expect(res.content).not.toContain('[object Object]');
  });

  it('get_freebusy renders busy windows as ISO ranges', async () => {
    const res = await byName('get_freebusy').execute(
      { emails: ['a@b.rw'], startDate: '2026-09-07T00:00:00Z', endDate: '2026-09-08T00:00:00Z' }, makeCtx(),
    );
    expect(res.content).toContain('a@b.rw');
    expect(res.content).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects an invalid date range', async () => {
    await expect(
      byName('list_events').execute({ startDate: 'garbage', endDate: '2026-09-08T00:00:00Z' }, makeCtx()),
    ).rejects.toThrow(/date/i);
  });
});
