/**
 * Deployment-level AI policy, baked at build time.
 *
 * When NEXT_PUBLIC_AI_MODEL is set (e.g. on managed test/prod boxes), the AI
 * assistant is always on, pinned to that model, and the Settings section for
 * it disappears — the deployment env is the single source of truth. Leave it
 * unset in dev to keep the model picker and enable toggle.
 */
export const LOCKED_AI_MODEL: string | null = process.env.NEXT_PUBLIC_AI_MODEL || null;
export const AI_LOCKED = LOCKED_AI_MODEL !== null;
