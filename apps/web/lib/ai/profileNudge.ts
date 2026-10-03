/**
 * Whether to invite the user to fill in their AI profile.
 *
 * The prompt is a single dismissible line inside the AI panes, never a modal
 * and never a toast — someone who came to read mail should not be interrupted
 * to configure a feature they may never open.
 */

/** The profile fields that actually say something about the person. */
export interface AiProfileNudgeInput {
  jobTitle?: string | null;
  institution?: string | null;
  department?: string | null;
  instructions?: string | null;
  /** Present on the real profile, deliberately ignored here. */
  language?: string | null;
}

const filled = (value?: string | null): boolean => !!value && value.trim().length > 0;

export function shouldShowAiProfileNudge(
  profile: AiProfileNudgeInput | null | undefined,
  dismissed: boolean,
): boolean {
  // No profile yet means "still loading", not "empty" — showing the nudge here
  // makes it flash on every page load before the fetch resolves.
  if (!profile) return false;
  if (dismissed) return false;

  // `language` is excluded on purpose: it can be set automatically, so it is no
  // evidence that the user has told us anything about themselves.
  return !filled(profile.jobTitle)
    && !filled(profile.institution)
    && !filled(profile.department)
    && !filled(profile.instructions);
}
