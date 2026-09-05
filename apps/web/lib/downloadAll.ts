export interface DownloadableAttachment {
  messageId: string;
  id: string;
  filename: string;
}

/**
 * Sequentially download a list of attachments via anchor clicks.
 * Sequential + spaced so the browser doesn't suppress the downloads as a
 * popup burst; failures skip to the next file (reported via onError).
 */
export async function downloadAll(
  attachments: DownloadableAttachment[],
  getUrl: (messageId: string, attachmentId: string) => Promise<string>,
  opts: { delayMs?: number; onError?: (filename: string) => void } = {},
): Promise<number> {
  const { delayMs = 300, onError } = opts;
  let downloaded = 0;
  for (const att of attachments) {
    try {
      const url = await getUrl(att.messageId, att.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      a.click();
      downloaded += 1;
    } catch {
      onError?.(att.filename);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return downloaded;
}
