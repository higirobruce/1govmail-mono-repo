import { z } from 'zod';

export type ToolMode = 'read' | 'write-auto' | 'write-gated';

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie';
  title: string;
  labels: string[];
  series: Array<{ name: string; data: number[] }>;
}

export interface ToolContext {
  userId: string;
  userEmail: string;
  /** Returns 's1', 's2', ... — one counter per agent turn, matching the ask alias convention. */
  nextAlias(): string;
  emitChart(spec: ChartSpec): void;
}

export interface ToolRef {
  alias: string;
  type: 'mail' | 'doc' | 'event';
  id: string;
  title: string | null;
  date: string;
  snippet: string;
  injectionSuspected: boolean;
}

export interface ToolExecResult {
  summary: string;
  content: string;
  refs?: ToolRef[];
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  mode: ToolMode;
  schema: S;
  resultBudget: number;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolExecResult>;
}

export class ToolValidationError extends Error {}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    this.tools.set(def.name, def);
  }

  registerAll(defs: ToolDef[]): void {
    for (const def of defs) this.register(def);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  openAiTools(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> {
    return this.list().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
      },
    }));
  }

  parseArgs(name: string, rawJson: string): unknown {
    const def = this.tools.get(name);
    if (!def) throw new ToolValidationError(`unknown tool: ${name}`);
    let parsed: unknown;
    try {
      parsed = rawJson.trim() ? JSON.parse(rawJson) : {};
    } catch {
      throw new ToolValidationError(`arguments for ${name} are not valid JSON`);
    }
    const result = def.schema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ToolValidationError(`invalid arguments for ${name}: ${detail}`);
    }
    return result.data;
  }
}
