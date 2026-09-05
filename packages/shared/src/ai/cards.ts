import { UNTRUSTED_CONTENT_RULE, detectInjectionAttempt, fenceUntrusted, neutralizeMarkers } from './promptCore';

/** The meta a card prompt needs — superset-compatible with web's BriefingSourceMessage. */
export interface CardSource {
  id: string;
  conversationId: string | null;
  direction: 'received' | 'sent';
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  receivedAt: string; // ISO
  attachments: string[]; // "name.pdf (2.1MB)"
}

export interface ExtractedCard {
  messageId: string;
  conversationId: string | null;
  direction: 'received' | 'sent';
  from: string;
  subject: string | null;
  receivedAt: string;
  gist: string;
  asksOfMe: string[];
  deadlines: string[];
  commitmentsIMade: string[];
  waitingOn: string | null;
  importance: 'high' | 'normal' | 'low';
  attachments: string[];
  injectionSuspected: boolean;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

/**
 * Format a message's attachment metadata into "name.ext (size)" strings.
 * Shared by the listing-row path (`toSource`, which mostly sees none — the
 * real listing endpoint returns only `hasAttachments`) and the hydrate step
 * in `generateBriefing`, which fills this in from `getMessage` detail.
 */
export function formatAttachments(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw
        .map((a) => a as { filename?: unknown; size?: unknown })
        .filter((a) => a && typeof a.filename === 'string')
        .map((a) => {
          const filename = a.filename as string;
          const size = typeof a.size === 'number' ? a.size : NaN;
          const sizeStr = formatSize(size);
          return `${filename}${sizeStr ? ` (${sizeStr})` : ''}`;
        })
    : [];
}

const CARD_SYSTEM = `${UNTRUSTED_CONTENT_RULE}

You extract facts from one email for an executive's briefing. Output ONLY a JSON object with exactly these keys:
{"gist": string (one sentence, what this email is about),
 "asksOfMe": string[] (explicit requests or decisions directed at the reader; [] if none),
 "deadlines": string[] (dates or times stated in the email; [] if none),
 "commitmentsIMade": string[] (ONLY for emails the reader sent: promises the reader made; [] otherwise),
 "waitingOn": string or null (what the reader is waiting to receive from the sender, if stated),
 "importance": "high" | "normal" | "low"}
Rules: report only what the email actually says — never invent. Empty arrays over guesses. "high" only for decisions, deadlines within days, or senior-official requests. No commentary, no markdown — JSON only.`;

export function buildCardPrompt(msg: CardSource, body: string): { system: string; user: string } {
  const from = msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail;
  const meta = [
    `Direction: ${msg.direction === 'sent' ? 'SENT BY the reader' : 'RECEIVED by the reader'}`,
    `From: ${from}`,
    msg.subject ? `Subject: ${msg.subject}` : null,
    msg.attachments.length ? `Attachments (names only, contents not available): ${msg.attachments.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  return {
    system: CARD_SYSTEM,
    user: `${meta}\n\n${fenceUntrusted('EMAIL', body)}\n\nExtract the JSON card now. Output ONLY the JSON object.`,
  };
}

export function firstJsonObject(raw: string): string | null {
  const cleaned = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null;
}

/**
 * Closers needed to balance a JSON prefix, or null when the prefix cannot be
 * balanced at this cut (ends inside a string, or brackets mismatch).
 */
export function missingClosers(slice: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of slice) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
    }
  }
  if (inString) return null;
  return stack.reverse().join('');
}

/**
 * Best-effort repair of JSON cut off by a hit token limit (finish_reason
 * "length"): back up to the last complete element boundary and close every
 * bracket still open. Complete items survive; the mangled tail is dropped.
 */
export function repairTruncatedJson(text: string): string | null {
  let cut = text.length;
  while (cut > 1) {
    const slice = text.slice(0, cut);
    const closers = missingClosers(slice);
    if (closers !== null) {
      const candidate = slice + closers;
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // fall through — cut further back
      }
    }
    const prev = Math.max(slice.lastIndexOf('}', cut - 2), slice.lastIndexOf(']', cut - 2));
    if (prev <= 0) return null;
    cut = prev + 1;
  }
  return null;
}

/** Parse a model's JSON-object output, salvaging truncated output when possible. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const jsonText = firstJsonObject(raw ?? '');
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // fall through to repair
    }
  }
  const cleaned = (raw ?? '').replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  const repaired = repairTruncatedJson(cleaned.slice(start));
  if (!repaired) return null;
  try {
    const parsed = JSON.parse(repaired) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Model output and any values echoed back from attacker-controlled email
// content (subject lines, sender names, attachment names) must never carry a
// forgeable fence/role-marker shape into a later prompt (the reduce step).
const strArr = (v: unknown, maxItems = 6, maxLen = 200): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, maxItems).map((s) => neutralizeMarkers(s).slice(0, maxLen)) : [];

export function parseCardJson(raw: string, msg: CardSource, body: string): ExtractedCard | null {
  const data = parseJsonObject(raw);
  if (!data) return null;
  const importance = data.importance === 'high' || data.importance === 'low' ? data.importance : 'normal';
  return {
    messageId: msg.id,
    conversationId: msg.conversationId,
    direction: msg.direction,
    from: msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail,
    subject: msg.subject,
    receivedAt: msg.receivedAt,
    gist: neutralizeMarkers(typeof data.gist === 'string' ? data.gist : '').slice(0, 300),
    asksOfMe: strArr(data.asksOfMe),
    deadlines: strArr(data.deadlines),
    commitmentsIMade: msg.direction === 'sent' ? strArr(data.commitmentsIMade) : [],
    waitingOn: typeof data.waitingOn === 'string' ? neutralizeMarkers(data.waitingOn).slice(0, 200) : null,
    importance,
    attachments: msg.attachments,
    injectionSuspected: detectInjectionAttempt(body),
  };
}

export type TriageLabel = 'needsDecision' | 'waitingOnYou' | 'deadline' | 'fyi';

export function deriveLabel(card: Pick<ExtractedCard, 'asksOfMe' | 'waitingOn' | 'deadlines'>): TriageLabel {
  if (card.asksOfMe.length > 0) return 'needsDecision';
  if (card.waitingOn) return 'waitingOnYou';
  if (card.deadlines.length > 0) return 'deadline';
  return 'fyi';
}
