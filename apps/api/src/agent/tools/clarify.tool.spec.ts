import { buildClarifyTool } from './clarify.tool';

describe('ask_user clarify tool', () => {
  const tool = buildClarifyTool();

  it('is registered as a clarify-mode tool named ask_user', () => {
    expect(tool.name).toBe('ask_user');
    expect(tool.mode).toBe('clarify');
  });

  it('accepts a question with 2-4 short options', () => {
    expect(
      tool.schema.safeParse({
        question: 'Which document did you mean?',
        options: ['The Docs document', 'The email attachment'],
      }).success,
    ).toBe(true);
    expect(
      tool.schema.safeParse({
        question: 'Which one?',
        options: ['a', 'b', 'c', 'd'],
      }).success,
    ).toBe(true);
  });

  it('rejects missing options, a single option, or too many', () => {
    expect(tool.schema.safeParse({ question: 'Which one?' }).success).toBe(false);
    expect(tool.schema.safeParse({ question: 'Which one?', options: ['only'] }).success).toBe(false);
    expect(
      tool.schema.safeParse({ question: 'Which one?', options: ['a', 'b', 'c', 'd', 'e'] }).success,
    ).toBe(false);
  });

  it('is never executed server-side', async () => {
    await expect(tool.execute({} as any, {} as any)).rejects.toThrow(/never executed/);
  });
});
