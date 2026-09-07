import { z } from 'zod';

export type ToolMode = 'read' | 'write-auto' | 'write-gated' | 'clarify';

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

/**
 * Remove `pattern` keys from a JSON Schema, recursively. zod v4's .email()
 * emits a regex with negative lookaheads, which llama.cpp-based servers
 * (the Ollama host behind CHAT_MODEL) cannot convert to a sampling grammar —
 * the request 400s with "Failed to initialize samplers: failed to parse
 * grammar". The advertised schema only steers the model; real validation
 * happens server-side in parseArgs, so dropping patterns loses nothing.
 */
function stripPatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPatterns);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'pattern' && typeof value === 'string') continue;
      out[key] = stripPatterns(value);
    }
    return out;
  }
  return node;
}

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
        parameters: stripPatterns(z.toJSONSchema(t.schema)) as Record<string, unknown>,
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
