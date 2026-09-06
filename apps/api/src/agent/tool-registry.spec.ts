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
