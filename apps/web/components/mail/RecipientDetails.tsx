'use client';

/**
 * Full addressee disclosure for one message.
 *
 * The header summary above it truncates (To at 3, Cc at 2) so a wide-
 * distribution circular stays one line — but truncation is exactly what stops
 * a reader telling whether they were addressed or merely copied. This panel is
 * the authoritative list: every address, in full, with Bcc shown when the
 * provider disclosed one (own sent items only).
 */

export interface Address {
  email: string;
  name?: string | null;
}

/** `Name <email>` when a display name exists — the address is always visible,
 *  because a display name alone is exactly what hides who was really on the
 *  mail (and is trivially spoofable). */
export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

function Row({ label, addresses }: { label: string; addresses: Address[] }) {
  if (addresses.length === 0) return null;
  return (
    <>
      <dt className="text-micro text-ink-3 shrink-0">{label}:</dt>
      <dd className="min-w-0 text-micro text-ink-2">
        {/* One address per line: a 40-recipient circular is scannable as a
            column and unreadable as a wrapped comma list. */}
        {addresses.map((a) => (
          <div key={`${label}-${a.email}`} className="truncate">
            {formatAddress(a)}
          </div>
        ))}
      </dd>
    </>
  );
}

export default function RecipientDetails({
  from,
  replyTo,
  to,
  cc,
  bcc,
  dateLabel,
}: {
  from: Address;
  replyTo?: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  dateLabel?: string;
}) {
  // A reply-to echoing the sender is noise; only a genuinely different return
  // path is worth a row (and worth the reader's suspicion).
  const showReplyTo =
    !!replyTo && replyTo.trim().toLowerCase() !== from.email.trim().toLowerCase();

  return (
    <dl
      data-testid="recipient-details"
      className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-lg border border-border-faint bg-muted/20 px-3 py-2"
    >
      <Row label="From" addresses={[from]} />
      {showReplyTo && <Row label="Reply-to" addresses={[{ email: replyTo! }]} />}
      <Row label="To" addresses={to} />
      <Row label="CC" addresses={cc} />
      <Row label="BCC" addresses={bcc} />
      {dateLabel && (
        <>
          <dt className="text-micro text-ink-3 shrink-0">Date:</dt>
          <dd className="min-w-0 text-micro text-ink-2">{dateLabel}</dd>
        </>
      )}
    </dl>
  );
}
