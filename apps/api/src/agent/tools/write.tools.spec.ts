import { buildWriteTools, buildGatedTools, buildChartTool } from './write.tools';
import type { ToolContext, ChartSpec } from '../tool-registry';

function makeCtx(): ToolContext & { charts: ChartSpec[] } {
  let n = 0;
  const charts: ChartSpec[] = [];
  return {
    userId: 'u1', userEmail: 'u1@x.rw',
    nextAlias: () => `s${++n}`,
    emitChart: (spec) => charts.push(spec),
    charts,
  } as any;
}

const mail = { saveDraft: jest.fn().mockResolvedValue({ zimbraId: 'z9' }) } as any;
const docs = { create: jest.fn().mockResolvedValue({ id: 'd7', title: 'Memo' }) } as any;
const tasks = { create: jest.fn().mockResolvedValue({ id: 't3', title: 'Follow up' }) } as any;

describe('write-auto tools', () => {
  const tools = buildWriteTools(mail, docs, tasks);
  const byName = (n: string) => tools.find((t) => t.name === n)!;

  it('are all write-auto', () => {
    expect(tools.map((t) => t.mode)).toEqual(['write-auto', 'write-auto', 'write-auto']);
  });

  it('draft_email saves via MailService.saveDraft', async () => {
    const res = await byName('draft_email').execute(
      { to: ['a@b.rw'], subject: 'Hi', body: 'Body' }, makeCtx(),
    );
    expect(mail.saveDraft).toHaveBeenCalledWith('u1', { to: ['a@b.rw'], cc: undefined, subject: 'Hi', body: 'Body' });
    expect(res.summary).toContain('Draft');
  });

  it('create_document converts markdown to TipTap JSON', async () => {
    await byName('create_document').execute({ title: 'Memo', markdown: '# H\n\nBody' }, makeCtx());
    const dto = docs.create.mock.calls[0][1];
    expect(dto.title).toBe('Memo');
    expect(JSON.parse(dto.content).type).toBe('doc');
  });

  it('create_task forwards title/dueDate', async () => {
    await byName('create_task').execute({ title: 'Follow up', dueDate: '2026-09-10' }, makeCtx());
    expect(tasks.create).toHaveBeenCalledWith('u1', expect.objectContaining({ title: 'Follow up', dueDate: '2026-09-10' }));
  });
});

describe('gated tools', () => {
  const gated = buildGatedTools();

  it('send_email and create_calendar_event are write-gated and never execute', async () => {
    expect(gated.map((t) => `${t.name}:${t.mode}`)).toEqual([
      'send_email:write-gated', 'create_calendar_event:write-gated',
    ]);
    for (const tool of gated) {
      await expect(tool.execute({} as any, makeCtx())).rejects.toThrow(/never executed/);
    }
  });

  it('send_email schema matches SendMessageDto payload', () => {
    const ok = gated[0].schema.safeParse({ to: ['a@b.rw'], subject: 'S', body: 'B' });
    expect(ok.success).toBe(true);
    expect(gated[0].schema.safeParse({ to: [], subject: 'S', body: 'B' }).success).toBe(false);
  });
});

describe('create_chart', () => {
  it('validates the spec and emits it', async () => {
    const ctx = makeCtx();
    const tool = buildChartTool();
    const res = await tool.execute(
      { type: 'bar', title: 'Mail volume', labels: ['Mon', 'Tue'], series: [{ name: 'in', data: [3, 5] }] }, ctx,
    );
    expect(ctx.charts).toHaveLength(1);
    expect(res.summary).toContain('Chart');
  });
});
