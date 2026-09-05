export function isValidSenderAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^@?[^\s@]+@[^\s@]+\.[^\s@]+$|^@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
