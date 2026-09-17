import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Resolve a message's inline images to blob: URLs.
 *
 * Returns progressively — the body renders immediately and images appear as
 * they arrive, rather than holding the text hostage to the slowest image.
 *
 * Every URL created here is revoked on unmount or when the message changes.
 * Without that a long mail session leaks every image it has ever rendered.
 */
export function useInlineImages(
  messageId: string | null,
  inlineImages: Array<{ cid: string; partId: string }> | undefined,
): Map<string, string> {
  const [resolved, setResolved] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    setResolved(new Map());
    if (!messageId || !inlineImages?.length) return;

    let alive = true;
    const created: string[] = [];

    for (const img of inlineImages) {
      api.mail
        .inlineImage(messageId, img.partId)
        .then((url) => {
          if (!alive) { URL.revokeObjectURL(url); return; }
          created.push(url);
          // Key by the cid VERBATIM as stored. rewriteCidRefs does the
          // bracket/entity/base normalisation — doing it in two places would
          // guarantee the two drift apart.
          setResolved((prev) => new Map(prev).set(img.cid, url));
        })
        // One image failing is not worth a broken message.
        .catch(() => {});
    }

    return () => {
      alive = false;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [messageId, inlineImages]);

  return resolved;
}
