import { ConversationsController } from './conversations.controller';

const REQ = { user: { sub: 'u1' } } as any;

function makeController() {
  const service: any = {
    list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getTranscript: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({ id: 'c1' }),
    appendTurns: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    removeAll: jest.fn().mockResolvedValue({ deleted: 3 }),
  };
  return { controller: new ConversationsController(service), service };
}

describe('ConversationsController', () => {
  it('passes the caller own id to list, never an id from the query', async () => {
    const { controller, service } = makeController();
    await controller.list(REQ, 'budget', undefined);
    expect(service.list).toHaveBeenCalledWith('u1', { q: 'budget', cursor: undefined });
  });

  it('passes the caller own id to the transcript read', async () => {
    const { controller, service } = makeController();
    await controller.get(REQ, 'c1');
    expect(service.getTranscript).toHaveBeenCalledWith('u1', 'c1');
  });

  it('creates with the caller own id and forwards the full payload unchanged', async () => {
    const { controller, service } = makeController();
    const body: any = {
      scopeKind: 'app',
      scopeId: 's1',
      scopeLabel: 'Label',
      model: 'qwen3',
      turnId: 't1',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    };
    await controller.create(REQ, body);
    expect(service.create).toHaveBeenCalledWith('u1', {
      scopeKind: 'app',
      scopeId: 's1',
      scopeLabel: 'Label',
      model: 'qwen3',
      turnId: 't1',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    });
  });

  it('normalises absent scope fields to null rather than undefined', async () => {
    const { controller, service } = makeController();
    await controller.create(REQ, { scopeKind: 'app', model: 'qwen3', turns: [] } as any);
    const input = service.create.mock.calls[0][1];
    expect(input.scopeId).toBeNull();
    expect(input.scopeLabel).toBeNull();
  });

  it('appends with the caller own id and forwards the full payload, including turns', async () => {
    const { controller, service } = makeController();
    await controller.append(REQ, 'c1', {
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    } as any);
    expect(service.appendTurns).toHaveBeenCalledWith('u1', 'c1', {
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
      turnId: null,
    });
  });

  it('deletes one, and deletes all, with the caller own id', async () => {
    const { controller, service } = makeController();
    await controller.remove(REQ, 'c1');
    expect(service.remove).toHaveBeenCalledWith('u1', 'c1');
    await controller.removeAll(REQ);
    expect(service.removeAll).toHaveBeenCalledWith('u1');
  });
});
