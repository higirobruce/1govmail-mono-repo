/**
 * UUID v4 generator that works outside a secure context.
 *
 * `crypto.randomUUID` only exists over HTTPS or on `http://localhost`; on a
 * plain-HTTP origin served to a non-localhost host (e.g. the test VMs at
 * `http://10.10.94.x:3000`) it is `undefined` and throws. Route all UUID
 * generation through this helper so those deployments don't break. See
 * https://github.com/higirobruce/1govmail-mono-repo/issues/4
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: RFC-4122-shaped v4 for non-secure contexts.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
