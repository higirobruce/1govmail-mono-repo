export type SenderRuleKind = 'BLOCK' | 'ALLOW';

export interface SenderRuleLike {
  type: SenderRuleKind;
  address: string;
}

/**
 * Resolves which rule applies to `fromEmail`, or null if none match.
 * ALLOW always wins over BLOCK when both match, so a broad domain block
 * can be paired with a narrower per-address allow.
 */
export function matchSenderRule(fromEmail: string, rules: SenderRuleLike[]): SenderRuleKind | null {
  const email = fromEmail.trim().toLowerCase();
  const atIndex = email.indexOf('@');
  const domain = atIndex >= 0 ? email.slice(atIndex) : '';

  const matches = (rule: SenderRuleLike): boolean => {
    const address = rule.address.trim().toLowerCase();
    return address.startsWith('@') ? domain === address : email === address;
  };

  if (rules.some((rule) => rule.type === 'ALLOW' && matches(rule))) return 'ALLOW';
  if (rules.some((rule) => rule.type === 'BLOCK' && matches(rule))) return 'BLOCK';
  return null;
}
