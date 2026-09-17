# Inline images out of the message row — design

**Date:** 2026-09-17
**Status:** approved in chat; §6.1 gate resolved 2026-09-17 (passed on both boxes)
**Branch:** ft-hyperscale

## 1. Why

Opening a message downloads every inline image from the provider, base64-encodes
each into the HTML, and writes the result back to `bodyHtml` permanently. On
`10.10.94.155` that is **4,122 messages occupying 15 GB** — about 3.7 MB per
message, against the **295 KB per message** the infra scale plan is built on.
Off by a factor of twelve.

The distribution is not uniform, which is what makes this tractable:

| | |
|---|---|
| `messages` total | 15 GB — heap 5 MB, indexes 1.6 MB, **TOAST 15 GB** |
| Rows | 4,122 across 8 mailboxes, 2021 to now |
| Bodies over 10 MB | **648 messages holding 13 GB** |
| Bodies over 1 MB | 854 messages holding 14 GB |
| Everything else | 2,257 messages, negligible |
| Largest single body | **133 MB** |
| Bodies over 1 MB containing `data:image` | **854 of 854** |

It is not bloat. Autovacuum is healthy and there were 334 dead tuples at
measurement. It is exactly what the code was built to do.

**`.154` measured 2026-09-17, and it sharpens the picture rather than repeating
it:** 6,352 MB across 18,117 rows — four times the mail of `.155` in under half
the space. 442 oversized bodies hold 5,706 MB of that.

So the 295 KB anchor is not uniformly wrong; it is an average over a distribution
with a very heavy tail. Strip the oversized bodies out and `.154` sits at **37 KB
per message**, comfortably under the anchor. The tail is the whole problem:

| | `.154` | `.155` |
|---|---|---|
| Rows | 18,117 | 4,122 |
| Oversized bodies | 442 (2.4%) | 854 (21%) |
| Share of all bytes they hold | ~90% | ~93% |

A capacity model built on a mean will therefore be wrong in both directions — far
too pessimistic for ordinary mail, and far too optimistic for any mailbox that
receives newsletters. §11.

Two consequences beyond disk: every query touching `messages` drags multi-megabyte
TOAST around, and at the 5,000-mailbox target this storage model does not survive
contact with reality.

## 2. What already exists

Unusually much, which is why this is smaller than it sounds.

| Piece | State |
|---|---|
| `GET /mail/messages/:messageId/attachments/:part?disposition=inline` — serves any part with the right content type and `nosniff` | exists — `mail.controller.ts:216` |
| `inlineImages` column carrying `{cid, partId, mimeType}` per message | exists |
| `api.mail.downloadAttachment` — authenticated fetch → `URL.createObjectURL` → `blob:` URL | exists — `api.ts:447` |
| Body rendered in an iframe with `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"` | exists — `ThreadMessage.tsx:322` |
| `provider.downloadAttachmentBuffer(session, messageId, partId)` | exists |
| `@Cron` worker pattern with a batch cap and a "hit the ceiling" warning | exists — `history-evict.worker.ts` |
| Any binary storage in the API — upload dir, blob table | **does not exist**; the only `Bytes` column in the schema is `Document.yjsState` |
| Any cache of provider bytes | **does not exist**; attachments stream through on every request |

## 3. Decisions taken

| Question | Decision |
|---|---|
| Where the bytes live | **A cache outside the row, evictable.** Bounded, measurable, aged out on the same clock as everything else, and a second open costs nothing. |
| The existing 13 GB | **Backfilled into the cache, not stripped.** The bytes are already on the box; they only need to move. No provider round trip, nothing lost. |
| Cache medium | **Filesystem under `/opt/govmail`.** A cache is losable by definition, so it should not bloat a backup or a restore, and eviction is deleting files rather than `DELETE` plus a table rewrite. It is also the only option that actually shrinks Postgres rather than moving bytes within it. |
| Which parts get cached | **Inline images only**, never attachments. §7. |
| Compose path | **Unchanged.** Outgoing mail already converts pasted data URIs into proper CID attachments. That code is not the problem. |

## 4. Architecture

```
now      open ──▶ fetch parts ──▶ base64 into bodyHtml ──▶ persist forever ──▶ render
                                     15 GB in the messages table

after    open ──▶ bodyHtml keeps cid: refs ─────────────────────────────────▶ render
                      │                                      ▲
                      └─▶ web resolves each cid ──▶ GET …/inline/:partId
                                                        │
                                           cache hit ◀──┴──▶ miss: fetch provider,
                                         (file on disk)        write cache, serve
```

### 4.1 The cache

`/opt/govmail/imgcache/<userId>/<messageId>/<sha256(partId) hex>`

- **The filename is the partId hashed, not the partId**, because an EWS
  AttachmentId runs 150-400 characters and may contain `/` — neither of which
  survives as a path segment. 64 hex characters always do.
- **`userId` is in the path deliberately.** Combined with authorising the route
  against the token's subject, guessing another person's message id reaches
  nothing — the path they would need is not the path that gets built.
- **A per-file size cap.** One 133 MB image must not be able to own the cache.
  Over the cap, the image is served straight through without being written.
- **The cache is authoritative for nothing.** Every entry can be rebuilt from the
  provider via `inlineImages`, which is what makes it safe to evict, safe to lose,
  and correct to exclude from backups. §6 is the one place that property is at
  risk.

### 4.2 The route

`GET /mail/messages/:messageId/inline/:partId` — a **new** route, not an
extension of the attachment one. The policy differs and should be visible:
attachments are clicked deliberately and can be enormous; inline images are
fetched automatically on every open. Only the second earns a cache.

On a miss it calls `provider.downloadAttachmentBuffer`, writes the file, and
serves it. On a hit it streams the file.

### 4.3 Resolution in the web client

Before building the iframe's `srcDoc`, walk `inlineImages`, fetch each part
through the authenticated call the app already has, and replace `src="cid:…"`
with the resulting `blob:` URL.

This must happen in the client rather than by rewriting the HTML server-side to
point at the route, because **the iframe is sandboxed and an `<img>` inside it
cannot send a bearer token** — a server-rewritten URL would simply 401. The
blob-URL pattern is the one `downloadAttachment` already uses.

Two details that will bite otherwise:

- **Revoke the blob URLs on unmount.** Without it a long mail session leaks every
  image it has ever rendered.
- **Render the body immediately**, with images arriving as they resolve, rather
  than waiting for all of them. A first open is slower than today either way;
  blocking the text on the images makes it feel far worse.

### 4.4 Eviction

A daily `@Cron` worker in the established shape: drop files past an age horizon,
**and** enforce a total-size ceiling by evicting least-recently-used until under
it. On a disk-constrained box the ceiling matters more than the age.

It logs what it removed and distinguishes "finished, nothing left" from "hit the
ceiling with work remaining", warning on the latter. That is the direct lesson
from the chat-history eviction worker, where a sweep that silently never caught
up would have been indistinguishable from one that was working.

Both settings are env-tunable and must reject non-finite or non-positive values
loudly rather than parsing to zero — also a lesson from that worker, where an
empty env var would have set the horizon to now.

## 5. Stopping the embed

`getMessage` no longer calls `embedInlineImages` on the persist path, and
`bodyHtml` keeps its `cid:` references.

**One inversion to get right.** Today `mail.service.ts:622` treats an un-embedded
`cid:` in the body as a reason to re-fetch:

```ts
const bodyHasCids = (cached?.bodyHtml ?? '').includes('cid:');
```

After this change a `cid:` is the *normal* resting state. If that condition is
not flipped, every open re-fetches forever — the cache would never be hit and the
provider would take more load than before the change, not less.

## 6. The backfill, and the one thing that gates it

A one-off, **idempotent and resumable** command — it runs against two live boxes:

1. For each message whose `bodyHtml` contains `data:image`, extract each URI.
2. Write the bytes to the cache under the part id from `inlineImages`.
3. Rewrite the tag back to `src="cid:<original cid>"`.
4. `VACUUM FULL messages` once, per box.

`VACUUM FULL` rather than plain `VACUUM` because only a rewrite returns TOAST
space to the operating system; a plain vacuum returns it to the free space map,
where `df` will never see it. After step 3 the table is small, so the rewrite
needs little free space — which matters, because a rewrite of the *current* 15 GB
would not fit. It takes an exclusive lock, so the API is down for minutes and it
should run in a chosen window.

### 6.1 The gate — RESOLVED, and it passed

The question was whether those rows still carry their `inlineImages` mapping. If
they did not, the cache would become the **only** copy of those images — a
downgrade in durability from today, since the database is backed up and a cache
directory would not be.

Measured 2026-09-17 on both boxes:

| | oversized bodies | with a usable map | without |
|---|---|---|---|
| `.155` | 854 | **854** | 0 |
| `.154` | 442 | **442** | 0 |

Every single one retains a real `partId` — a sample entry reads
`{"cid": "image001.gif@01DD2986.DAAA8E30", "partId": "1.1.2", "mimeType": "image/gif"}`.

So a backfilled image whose cache file is later evicted or lost is re-fetched
from the provider by its real part id. **§4.1's property holds: the cache is
authoritative for nothing**, which is what makes it safe to evict, safe to lose,
and correct to exclude from backups. The backfill keeps the shape described
above, and no fallback branch is needed for unmapped rows.

The query, for re-running before each box's backfill — it is cheap and the answer
could differ on a box synced later:

```sql
select count(*) from messages
 where pg_column_size("bodyHtml") > 1048576
   and "inlineImages" is not null
   and jsonb_array_length("inlineImages"::jsonb) > 0;
```

## 7. What this deliberately does not do

- **Does not cache attachments.** Clicked deliberately, can be enormous, and
  streaming them through has been fine. The automatic-on-every-open property is
  what earns a cache.
- **Does not touch the compose path.** It already does the right thing.
- **Does not raise the disk.** Housekeeping on 2026-09-17 took `.155` from 80% to
  68% by deleting logs and caches. That bought time; it fixed nothing.
- **Does not introduce a blob table.** §3.
- **Does not attempt a shared cache across API instances.** If the API is ever
  run as more than one process, each keeps its own and each refetches once. That
  is acceptable for a cache and should simply be known.

## 8. Failure and edge behaviour

| Case | Behaviour |
|---|---|
| Cache miss | Fetch from the provider, write, serve. The normal cold path. |
| Provider unavailable on a miss | The image fails to load; the body still renders. An inline image is not worth failing a message over. |
| Image over the per-file cap | Served straight through, never written to the cache. |
| Cache directory missing or unwritable | Log once and serve straight through. A broken cache must degrade to today's behaviour minus the persistence, never to a broken mailbox. |
| Two opens race on the same miss | Both fetch; last write wins. The file is identical, so this is wasted work rather than corruption. Worth a single-flight guard only if measurement shows it matters. |
| A message is deleted | Its cache directory is orphaned until eviction collects it. Age-based eviction handles this without a cascade. |
| Offline | **Inline images stop working offline.** They work today only because they are embedded in the stored body. §9. |

## 9. Known limits, for the release note

- **Inline images require a connection.** They previously worked offline because
  they were embedded in the stored message; they are now fetched. This is a real
  regression and the only one in this change.
- A first open of a message with many images is slower than before; subsequent
  opens are faster.
- The API gains a filesystem dependency. The cache directory must be created at
  deploy and deliberately excluded from backups.
- `VACUUM FULL` during the backfill takes the API down for minutes on each box.

## 10. Testing

- **Tenancy** — one user cannot reach another's inline image through the route,
  including by supplying another person's message id. This is the security test.
- **Cache hit and miss** — a miss fetches once and writes; a second request does
  not touch the provider. Asserted on the provider mock, not on timing.
- **The inversion in §5** — a body containing `cid:` does *not* trigger a
  re-fetch. This is the test that catches the every-open-refetches regression,
  and it must fail if the condition is restored.
- **Eviction** — the size ceiling evicts least-recently-used; the age horizon
  drops old files; a non-positive env value falls back to the default rather than
  evicting everything.
- **Per-file cap** — an oversized image is served but not written.
- **Backfill** — idempotent (running twice changes nothing the second time), and
  resumable from an interruption.
- **Degradation** — an unwritable cache directory still serves images.

## 11. Measurement, after

Re-measure bytes per message on both boxes and update the infra scale plan. The
295 KB anchor is currently out by twelve times, and every capacity number
downstream of it inherits that error. Also worth measuring, rather than assuming:
whether getting multi-megabyte TOAST out of the row makes listing, search and
sync measurably faster.
