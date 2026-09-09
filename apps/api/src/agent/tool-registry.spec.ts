import { z } from 'zod';
import { ToolRegistry, ToolValidationError, type ToolDef } from './tool-registry';

const echoTool: ToolDef = {
  name: 'echo',
  description: 'Echo a message.',
  mode: 'read',
  resultBudget: 100,
  schema: z.object({ message: z.string().min(1) }),
  execute: async (args: any) => ({ summary: 'ok', content: args.message }),
};

describe('ToolRegistry', () => {
  it('registers and lists tools; rejects duplicates', () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(r.list().map((t) => t.name)).toEqual(['echo']);
    expect(() => r.register(echoTool)).toThrow(/duplicate/);
  });

  it('produces OpenAI-compat tool specs with JSON Schema parameters', () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    const [spec] = r.openAiTools();
    expect(spec.type).toBe('function');
    expect(spec.function.name).toBe('echo');
    expect((spec.function.parameters as any).properties.message.type).toBe('string');
  });

  it('parseArgs validates and coerces', () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(r.parseArgs('echo', '{"message":"hi"}')).toEqual({ message: 'hi' });
    expect(() => r.parseArgs('echo', '{"message":""}')).toThrow(ToolValidationError);
    expect(() => r.parseArgs('echo', 'not json')).toThrow(ToolValidationError);
    expect(() => r.parseArgs('nope', '{}')).toThrow(/unknown tool/);
  });

  it('parseArgs treats empty arguments as {}', () => {
    const r = new ToolRegistry();
    r.register({ ...echoTool, name: 'noargs', schema: z.object({}) } as ToolDef);
    expect(r.parseArgs('noargs', '')).toEqual({});
  });
});

describe('openAiTools grammar compatibility', () => {
  it('strips regex patterns (llama.cpp grammar cannot express lookaheads)', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'mailer',
      description: 'send',
      mode: 'write-gated',
      resultBudget: 0,
      schema: z.object({
        to: z.array(z.string().email()).min(1).max(20),
        contact: z.string().email(),
      }),
      execute: async () => ({ summary: '', content: '' }),
    } as ToolDef);
    const json = JSON.stringify(r.openAiTools());
    expect(json).not.toContain('"pattern"');
    // structure the model needs is preserved
    const params: any = r.openAiTools()[0].function.parameters;
    expect(params.properties.to.items.type).toBe('string');
    expect(params.properties.to.maxItems).toBe(20);
  });
});

describe('openAiTools filtering', () => {
  const mk = (name: string): ToolDef => ({
    ...echoTool, name, description: `${name} tool.`,
  });

  it('advertises every registered tool when given no allowlist', () => {
    const r = new ToolRegistry();
    r.registerAll([mk('get_thread'), mk('read_email'), mk('search_emails')]);
    expect(r.openAiTools().map((t) => t.function.name).sort())
      .toEqual(['get_thread', 'read_email', 'search_emails']);
  });

  it('advertises only the allowlisted tools', () => {
    const r = new ToolRegistry();
    r.registerAll([mk('get_thread'), mk('read_email'), mk('search_emails')]);
    const names = r.openAiTools(new Set(['get_thread', 'read_email'])).map((t) => t.function.name).sort();
    expect(names).toEqual(['get_thread', 'read_email']);
  });

  it('ignores allowlisted names the registry does not have', () => {
    const r = new ToolRegistry();
    r.registerAll([mk('get_thread')]);
    expect(r.openAiTools(new Set(['nope']))).toHaveLength(0);
  });
});
