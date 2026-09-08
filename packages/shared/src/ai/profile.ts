import { neutralizeMarkers } from './promptCore';

/**
 * The account owner's profile, as surfaced to the prompt builders. Every
 * field is attacker-adjacent (a user could type anything into their own
 * profile, and it ends up inside a system prompt alongside untrusted email
 * content) so every field is neutralized and capped before it is ever
 * rendered — see `buildProfileBlock`.
 */
export interface AiProfileInput {
  displayName?: string | null;
  email?: string | null;
  jobTitle?: string | null;
  institution?: string | null;
  department?: string | null;
  language?: string | null; // 'en' | 'fr' | 'rw'
  instructions?: string | null;
}

/**
 * `identity` renders ONLY the "who am I acting for" line (from
 * displayName/email) — no card fields, no instructions. Used where a
 * lighter touch is wanted, e.g. dossier and meeting prep, which intentionally
 * never surface the profile card to keep those prompts focused on the
 * counterparty rather than the account owner.
 *
 * `full` renders the profile card (job title/institution/department/
 * language) and, when present, the user's own style instructions — plus the
 * identity line, but only when displayName or email is actually present on
 * the input (both are optional; omit them to get card + instructions with
 * no identity line at all, e.g. client-side tasks that already know who
 * they're addressing).
 */
export type ProfileTier = 'identity' | 'full';

export const PROFILE_INSTRUCTIONS_MAX = 500;
export const PROFILE_FIELD_MAX = 80;

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  rw: 'Kinyarwanda',
};

function clean(value: string | null | undefined, max: number): string {
  if (!value) return '';
  return neutralizeMarkers(value).trim().slice(0, max);
}

/**
 * Renders the account owner's profile as an appendable system-prompt block.
 * Returns '' when there is nothing renderable at the given tier, so callers
 * can unconditionally append `\n\n${block}` only when non-empty.
 */
export function buildProfileBlock(profile: AiProfileInput | null | undefined, tier: ProfileTier): string {
  if (!profile) return '';

  const displayName = clean(profile.displayName, PROFILE_FIELD_MAX);
  const email = clean(profile.email, PROFILE_FIELD_MAX);
  const jobTitle = clean(profile.jobTitle, PROFILE_FIELD_MAX);
  const institution = clean(profile.institution, PROFILE_FIELD_MAX);
  const department = clean(profile.department, PROFILE_FIELD_MAX);
  const languageCode = clean(profile.language, PROFILE_FIELD_MAX);
  const languageName = LANGUAGE_NAMES[languageCode.toLowerCase()] ?? '';
  const instructions = clean(profile.instructions, PROFILE_INSTRUCTIONS_MAX);

  const lines: string[] = [];

  if (displayName || email) {
    const who = email ? `${displayName ? `${displayName} ` : ''}<${email}>` : displayName;
    lines.push(`The user you are assisting: ${who}.`);
  }

  if (tier === 'full') {
    const cardSegments = [
      jobTitle,
      department,
      institution,
    ].filter(Boolean);
    const cardParts: string[] = [];
    if (cardSegments.length) cardParts.push(`Their profile: ${cardSegments.join(', ')}.`);
    if (languageName) cardParts.push(`Preferred language: ${languageName}.`);
    if (cardParts.length) lines.push(cardParts.join(' '));

    if (instructions) {
      lines.push(
        'USER STYLE PREFERENCES — the account owner configured these writing preferences. ' +
          'Apply them only where they do not conflict with the rules above; the rules above always win.\n' +
          instructions,
      );
    }
  }

  return lines.join('\n');
}
