# Inline Image Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop base64-embedding inline images into `bodyHtml`, serve them from an evictable filesystem cache instead, and reclaim the ~19 GB already embedded across the two VMs.

**Architecture:** A new cached route streams an inline image from disk, falling back to the provider on a miss. The API stops embedding, so `bodyHtml` keeps its `cid:` references. The web resolves those references to authenticated `blob:` URLs before building the iframe's `srcDoc`. A daily worker evicts by age and by total-size ceiling, and a one-off backfill lifts the already-embedded bytes out of the rows.

**Tech Stack:** NestJS 11 + Prisma 7 (api, Jest), Next.js 16 (web, Vitest), PostgreSQL, `@nestjs/schedule`.

**Spec:** `docs/superpowers/specs/2026-09-17-inline-image-cache-design.md` (commit `89ab3c9`)

## Global Constraints

- **The cache is authoritative for nothing.** Every entry must be rebuildable from the provider via `inlineImages`. Verified on both boxes: 854/854 and 442/442 oversized bodies retain a real `partId`.
- **Cache path is `/opt/govmail/imgcache/<userId>/<messageId>/<partId>`** — `userId` is in the path deliberately, and the route authorises against the token's subject.
- **A broken cache degrades to serving straight through, never to a broken mailbox.**
- **Inline images only, never attachments.** The existing attachment route is untouched.
- **The compose path is untouched.** It already converts pasted data URIs into CID attachments.
- **Env settings reject non-finite and non-positive values loudly and fall back to the default** — an empty var must never parse to `0`.
- `apps/web/components/mail/ThreadMessage.tsx` and `MailDetail.tsx` both build an email `srcDoc`. Both need the same treatment; the shared logic belongs in `apps/web/lib/emailRender.ts`, which both already import from.
- **`AskPanel.tsx` and these mail components DO mount in jsdom** — `ThreadMessageContrast.test.tsx` already renders one. Do not assume otherwise.

---

### Task 1: The cache store

**Files:**
- Create: `apps/api/src/mail/inline-image-cache.service.ts`
- Test: `apps/api/src/mail/inline-image-cache.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `InlineImageCacheService.pathFor(userId: string, messageId: string, partId: string): string`
  - `InlineImageCacheService.read(userId, messageId, partId): Promise<Buffer | null>`
  - `InlineImageCacheService.write(userId, messageId, partId, data: Buffer): Promise<boolean>` — `false` when skipped (over cap, or unwritable)
  - `InlineImageCacheService.CACHE_ROOT` and the exported const `MAX_FILE_BYTES`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/mail/inline-image-cache.service.spec.ts`:

```typescript
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InlineImageCacheService, MAX_FILE_BYTES } from './inline-image-cache.service';

describe('InlineImageCacheService', () => {
  let root: string;
  let svc: InlineImageCacheService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'imgcache-'));
    svc = new InlineImageCacheService(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keys the path by user, message and part', () => {
    expect(svc.pathFor('u1', 'm1', '1.1.2')).toBe(join(root, 'u1', 'm1', '1.1.2'));
  });

  it('refuses a part id that would escape the cache root', () => {
    // A traversing part id must not be able to read or write outside the user's
    // own directory. This is the tenancy boundary, not a tidiness rule.
    expect(() => svc.pathFor('u1', 'm1', '../../../../etc/passwd')).toThrow();
    expect(() => svc.pathFor('u1', '../u2', '1.1')).toThrow();
  });

  it('returns null for a miss', async () => {
    expect(await svc.read('u1', 'm1', '1.1')).toBeNull();
  });

  it('round-trips a written buffer', async () => {
    const data = Buffer.from('imagebytes');
    expect(await svc.write('u1', 'm1', '1.1', data)).toBe(true);
    expect(await svc.read('u1', 'm1', '1.1')).toEqual(data);
  });

  it('does not write a file over the per-file cap', async () => {
    const huge = Buffer.alloc(MAX_FILE_BYTES + 1);
    expect(await svc.write('u1', 'm1', '1.1', huge)).toBe(false);
    expect(await svc.read('u1', 'm1', '1.1')).toBeNull();
  });

  it('writes a file exactly at the cap', async () => {
    const atCap = Buffer.alloc(MAX_FILE_BYTES);
    expect(await svc.write('u1', 'm1', '1.1', atCap)).toBe(true);
  });

  it('reports failure instead of throwing when the root is unwritable', async () => {
    // A broken cache must degrade to serving straight through.
    const ro = mkdtempSync(join(tmpdir(), 'imgcache-ro-'));
    chmodSync(ro, 0o500);
    const roSvc = new InlineImageCacheService(ro);
    await expect(roSvc.write('u1', 'm1', '1.1', Buffer.from('x'))).resolves.toBe(false);
    chmodSync(ro, 0o700);
    rmSync(ro, { recursive: true, force: true });
  });

  it('reports a miss instead of throwing when a read fails', async () => {
    const dir = join(root, 'u1', 'm1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.1'), 'ok');
    expect(existsSync(join(dir, '1.1'))).toBe(true);
    expect(await svc.read('u1', 'nope', '1.1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx jest src/mail/inline-image-cache.service.spec.ts`
Expected: FAIL — cannot find module `./inline-image-cache.service`.

- [ ] **Step 3: Write the service**

Create `apps/api/src/mail/inline-image-cache.service.ts`:

```typescript
import { promises as fs } from 'fs';
import { join, resolve, sep } from 'path';
import { Injectable, Logger } from '@nestjs/common';

export const CACHE_ROOT_DEFAULT = process.env.INLINE_IMAGE_CACHE_DIR ?? '/opt/govmail/imgcache';

/** One 133 MB image must not be able to own the cache. Over this, serve through. */
export const MAX_FILE_BYTES = Number(process.env.INLINE_IMAGE_MAX_BYTES ?? 5 * 1024 * 1024);

/**
 * Bytes for inline images, on disk, keyed by user + message + part.
 *
 * This cache is authoritative for NOTHING: every entry is rebuildable from the
 * provider via the message's `inlineImages` mapping. That is what makes it safe
 * to evict, safe to lose, and correct to exclude from backups — and it is why
 * every failure path here degrades to "no cache" rather than throwing.
 */
@Injectable()
export class InlineImageCacheService {
  private readonly logger = new Logger(InlineImageCacheService.name);
  private warnedUnwritable = false;

  constructor(private readonly root: string = CACHE_ROOT_DEFAULT) {}

  get CACHE_ROOT(): string {
    return this.root;
  }

  /**
   * Resolve and verify the path stays inside the cache root. A part id arrives
   * from the URL, so a traversing value would otherwise read or write outside
   * the caller's own directory — this is the tenancy boundary.
   */
  pathFor(userId: string, messageId: string, partId: string): string {
    const full = resolve(join(this.root, userId, messageId, partId));
    const base = resolve(this.root) + sep;
    if (!full.startsWith(base)) {
      throw new Error('inline image path escapes the cache root');
    }
    return full;
  }

  async read(userId: string, messageId: string, partId: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(userId, messageId, partId));
    } catch {
      return null;
    }
  }

  /** Returns false when the write was skipped — over cap, or the cache is unusable. */
  async write(userId: string, messageId: string, partId: string, data: Buffer): Promise<boolean> {
    if (data.byteLength > MAX_FILE_BYTES) return false;
    try {
      const full = this.pathFor(userId, messageId, partId);
      await fs.mkdir(join(full, '..'), { recursive: true });
      await fs.writeFile(full, data);
      return true;
    } catch (err: any) {
      // Log once. A cache that cannot be written is a degraded cache, not an
      // outage, and it must not produce a line per image on every open.
      if (!this.warnedUnwritable) {
        this.warnedUnwritable = true;
        this.logger.warn(`inline image cache unwritable (${err?.message}); serving through`);
      }
      return false;
    }
  }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/api && npx jest src/mail/inline-image-cache.service.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Whole suite and typecheck**

Run: `cd apps/api && npx jest && npx tsc --noEmit -p tsconfig.json`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/mail/inline-image-cache.service.ts apps/api/src/mail/inline-image-cache.service.spec.ts
git commit -m "feat(api): a filesystem cache for inline images"
```

---

### Task 2: The cached route

**Files:**
- Modify: `apps/api/src/mail/mail.service.ts`
- Modify: `apps/api/src/mail/mail.controller.ts`
- Modify: `apps/api/src/mail/mail.module.ts`
- Test: `apps/api/src/mail/inline-image.route.spec.ts`

**Interfaces:**
- Consumes: `InlineImageCacheService` (Task 1).
- Produces:
  - `MailService.getInlineImage(userId, messageId, partId): Promise<{ data: Buffer; contentType: string; cached: boolean }>`
  - Route `GET mail/messages/:messageId/inline/:partId`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/mail/inline-image.route.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { MailService } from './mail.service';
import { InlineImageCacheService } from './inline-image-cache.service';

function makeService(opts: { cacheHit?: Buffer; message?: any } = {}) {
  const cache = {
    read: jest.fn().mockResolvedValue(opts.cacheHit ?? null),
    write: jest.fn().mockResolvedValue(true),
  } as unknown as InlineImageCacheService;

  const provider = {
    downloadAttachmentBuffer: jest.fn().mockResolvedValue({
      data: Buffer.from('fetched'), contentType: 'image/png',
    }),
  };
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', email: 'u1@x.rw' }) },
    message: {
      findFirst: jest.fn().mockResolvedValue(
        opts.message === undefined
          ? { id: 'm1', userId: 'u1', zimbraId: 'z1',
              inlineImages: [{ cid: 'c1', partId: '1.1.2', mimeType: 'image/png' }] }
          : opts.message,
      ),
    },
  };
  const resolver = { forUser: () => provider } as any;
  // Match mail.service.spec.ts, which constructs the service for real rather
  // than reaching past the constructor — that is what catches a missing arg.
  const svc = new MailService(prisma, resolver, {} as any, {} as any, cache);
  return { svc, cache, provider, prisma };
}

describe('MailService.getInlineImage', () => {
  it('serves from the cache without touching the provider', async () => {
    const { svc, provider } = makeService({ cacheHit: Buffer.from('cached') });
    const r = await svc.getInlineImage('u1', 'm1', '1.1.2');
    expect(r.data.toString()).toBe('cached');
    expect(r.cached).toBe(true);
    expect(provider.downloadAttachmentBuffer).not.toHaveBeenCalled();
  });

  it('fetches and writes on a miss', async () => {
    const { svc, cache, provider } = makeService();
    const r = await svc.getInlineImage('u1', 'm1', '1.1.2');
    expect(r.data.toString()).toBe('fetched');
    expect(r.cached).toBe(false);
    expect(provider.downloadAttachmentBuffer).toHaveBeenCalledTimes(1);
    expect(cache.write).toHaveBeenCalledWith('u1', 'm1', '1.1.2', expect.any(Buffer));
  });

  it('still serves when the cache write fails', async () => {
    const { svc, cache } = makeService();
    (cache.write as jest.Mock).mockResolvedValue(false);
    const r = await svc.getInlineImage('u1', 'm1', '1.1.2');
    expect(r.data.toString()).toBe('fetched');
  });

  it('refuses a message that is not the caller own', async () => {
    const { svc } = makeService({ message: null });
    await expect(svc.getInlineImage('u1', 'someone-else', '1.1.2'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a part that the message does not declare as an inline image', async () => {
    // Without this the route is a general attachment reader wearing a cache.
    const { svc, provider } = makeService();
    await expect(svc.getInlineImage('u1', 'm1', '9.9.9'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(provider.downloadAttachmentBuffer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx jest src/mail/inline-image.route.spec.ts`
Expected: FAIL — `svc.getInlineImage is not a function`.

- [ ] **Step 3: Add the service method**

In `apps/api/src/mail/mail.service.ts`, add a **fifth constructor parameter with a default**:

```typescript
    private readonly inlineCache: InlineImageCacheService = new InlineImageCacheService(),
```

**The default is not laziness — there are 23 `new MailService(...)` call sites** across
`mail.service.spec.ts` and `mail-recipients.spec.ts`. A required parameter would mean hand-editing
all 23 for no benefit. A default keeps them compiling, and Nest still injects the registered
provider in production: a default value does not opt a parameter out of DI, so an unregistered
provider still throws at boot and Step 5's registration stays a real requirement.

This is safe only because §4.1 of the spec requires every cache failure path to degrade rather
than throw — a default-constructed cache in a test points at a path that does not exist, reads
miss, writes return `false`, and nothing breaks. Do not weaken that degradation.

Then add:

```typescript
  /**
   * Bytes for one inline image. Cache first, provider on a miss.
   *
   * The part must be declared in the message's own `inlineImages`. Without that
   * check this route would be a general attachment reader with a cache bolted
   * on, reachable for any part of any message the caller owns.
   */
  async getInlineImage(
    userId: string,
    messageId: string,
    partId: string,
  ): Promise<{ data: Buffer; contentType: string; cached: boolean }> {
    const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    const declared = ((msg.inlineImages as any[]) ?? [])
      .find((i) => i?.partId === partId);
    if (!declared) throw new NotFoundException('Inline image not found');

    const hit = await this.inlineCache.read(userId, messageId, partId);
    if (hit) {
      return { data: hit, contentType: declared.mimeType ?? 'application/octet-stream', cached: true };
    }

    const user = await this.getUser(userId);
    const { data, contentType } = await this.resolver
      .forUser(user)
      .downloadAttachmentBuffer(buildMailSession(user), msg.zimbraId, partId);

    await this.inlineCache.write(userId, messageId, partId, data);
    return { data, contentType: contentType ?? declared.mimeType, cached: false };
  }
```

- [ ] **Step 4: Add the route**

In `apps/api/src/mail/mail.controller.ts`, directly after the existing
`downloadAttachment` handler:

```typescript
  /**
   * Inline images only — the parts a message declares in `inlineImages`, which
   * the client fetches automatically on every open. Cached on disk, unlike
   * attachments, which are clicked deliberately and can be enormous.
   */
  @Get('messages/:messageId/inline/:partId')
  async inlineImage(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param('messageId') messageId: string,
    @Param('partId') partId: string,
  ) {
    const { data, contentType } =
      await this.mailService.getInlineImage(req.user.sub, messageId, partId);

    res.set({
      'Content-Type': contentType,
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }
```

- [ ] **Step 5: Register the provider**

In `apps/api/src/mail/mail.module.ts`, add `InlineImageCacheService` to the
`providers` array and import it. If it is not registered, the route throws on
every request with a dependency-resolution error at boot.

- [ ] **Step 6: Run them and watch them pass**

Run: `cd apps/api && npx jest src/mail && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (5 new tests, existing mail tests still green).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/mail/mail.service.ts apps/api/src/mail/mail.controller.ts apps/api/src/mail/mail.module.ts apps/api/src/mail/inline-image.route.spec.ts
git commit -m "feat(api): serve inline images from the cache, fetch on a miss"
```

---

### Task 3: Stop embedding

**Files:**
- Modify: `apps/api/src/mail/mail.service.ts:620-700`
- Test: `apps/api/src/mail/mail.service.spec.ts` (or the closest existing mail service spec — match the file the repo already uses)

**Interfaces:**
- Consumes: nothing.
- Produces: `getMessage` returns `bodyHtml` with `cid:` refs intact and never writes an embedded body.

**The inversion that will bite.** `mail.service.ts:622` currently reads:

```typescript
const bodyHasCids = (cached?.bodyHtml ?? '').includes('cid:');
```

and a truthy `bodyHasCids` forces a re-fetch. After this change a `cid:` is the
**normal resting state**. If that condition is not flipped, every open re-fetches
forever — the cache is never hit and the provider takes *more* load than before.

- [ ] **Step 1: Write the failing tests**

Add to the mail service spec:

```typescript
describe('getMessage no longer embeds inline images', () => {
  it('does not re-fetch a cached body that still contains cid: refs', async () => {
    const { svc, provider, prisma } = makeService();
    prisma.message.findFirst.mockResolvedValue({
      id: 'm1', userId: 'u1', zimbraId: 'z1',
      bodyHtml: '<img src="cid:c1">', bodyText: 'hi',
      attachments: [], inlineImages: [{ cid: 'c1', partId: '1.1', mimeType: 'image/png' }],
    });

    await svc.getMessage('u1', 'm1');

    // The whole point: a cid: body is now the resting state, not a cache miss.
    expect(provider.getMessage).not.toHaveBeenCalled();
  });

  it('never writes a body containing a data: URI', async () => {
    const { svc, prisma } = makeService();
    prisma.message.findFirst.mockResolvedValue(null);
    prisma.message.upsert = jest.fn().mockResolvedValue({});

    await svc.getMessage('u1', 'm1').catch(() => {});

    for (const call of (prisma.message.upsert as jest.Mock).mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('data:image');
    }
  });
});
```

`apps/api/src/mail/mail.service.spec.ts` already has `makeService()` at line 21 —
**use it**, do not build a second harness. Read it first so your mock names match
the ones it already sets up.

- [ ] **Step 2: Run them and watch the first one fail**

Run: `cd apps/api && npx jest src/mail -t "no longer embeds"`
Expected: FAIL — the provider IS called, because `bodyHasCids` forces a refetch.

- [ ] **Step 3: Flip the condition and drop the embed**

In `apps/api/src/mail/mail.service.ts`, delete `bodyHasCids` from the cache-hit
condition at line 624 (leave `bodyHasZimbraUrls`, which is a different problem —
an un-proxied Zimbra URL still needs a refetch), and remove the
`embedInlineImages` call and its background write-back at lines ~672-700.

Leave `embedInlineImages` itself in place for now; Task 6 removes it once the
backfill no longer needs a reference implementation for extracting parts.

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/api && npx jest src/mail && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. Existing tests that assert embedding happened will now fail —
**fix them by asserting the new behaviour, never by deleting the assertion.**
Report every test you had to change and why.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail/mail.service.ts apps/api/src/mail/mail.service.spec.ts
git commit -m "feat(api): stop embedding inline images into the stored body"
```

---

### Task 4: Resolve cid refs in the web client

**Files:**
- Modify: `apps/web/lib/emailRender.ts`
- Create: `apps/web/lib/mail/useInlineImages.ts`
- Modify: `apps/web/lib/api.ts` (add `api.mail.inlineImage`)
- Modify: `apps/web/components/mail/ThreadMessage.tsx:288`
- Modify: `apps/web/components/mail/MailDetail.tsx`
- Test: `apps/web/lib/emailRender.test.ts`

**Interfaces:**
- Consumes: `GET mail/messages/:messageId/inline/:partId` (Task 2).
- Produces:
  - `rewriteCidRefs(html: string, resolved: Map<string, string>): string` from `emailRender.ts`
  - `useInlineImages(messageId: string | null, inlineImages: Array<{cid: string; partId: string}> | undefined): Map<string, string>`
  - `api.mail.inlineImage(messageId: string, partId: string): Promise<string>` — a `blob:` URL

- [ ] **Step 1: Write the failing tests for the pure part**

Add to `apps/web/lib/emailRender.test.ts` (create it if absent):

```typescript
import { describe, it, expect } from 'vitest';
import { rewriteCidRefs } from './emailRender';

describe('rewriteCidRefs', () => {
  const map = new Map([['c1', 'blob:x/1'], ['c2', 'blob:x/2']]);

  it('swaps a cid reference for its resolved url', () => {
    expect(rewriteCidRefs('<img src="cid:c1">', map)).toBe('<img src="blob:x/1">');
  });

  it('handles single quotes and mixed case', () => {
    expect(rewriteCidRefs("<img src='CID:c1'>", map)).toBe("<img src='blob:x/1'>");
  });

  it('swaps every occurrence, not just the first', () => {
    const out = rewriteCidRefs('<img src="cid:c1"><img src="cid:c2"><img src="cid:c1">', map);
    expect(out).toBe('<img src="blob:x/1"><img src="blob:x/2"><img src="blob:x/1">');
  });

  it('tolerates angle brackets around the cid, which is how they are stored', () => {
    expect(rewriteCidRefs('<img src="cid:<c1>">', map)).toBe('<img src="blob:x/1">');
  });

  it('leaves an unresolved cid alone rather than blanking the image', () => {
    const out = rewriteCidRefs('<img src="cid:unknown">', map);
    expect(out).toBe('<img src="cid:unknown">');
  });

  it('leaves html with no cid refs untouched', () => {
    expect(rewriteCidRefs('<p>hello</p>', map)).toBe('<p>hello</p>');
  });

  // The three normalisations below are not hypothetical — each is handled by the
  // embed code this replaces (mail.service.ts:1349-1358). Dropping any of them
  // means images silently failing to resolve on real mail while CI stays green.

  it('matches when the STORED cid is bracket-wrapped and the html is not', () => {
    const stored = new Map([['<img0@govmail>', 'blob:x/9']]);
    expect(rewriteCidRefs('<img src="cid:img0@govmail">', stored)).toBe('<img src="blob:x/9">');
  });

  it('matches when the html encodes the @ as an entity', () => {
    const stored = new Map([['img0@govmail', 'blob:x/9']]);
    expect(rewriteCidRefs('<img src="cid:img0&#64;govmail">', stored)).toBe('<img src="blob:x/9">');
    expect(rewriteCidRefs('<img src="cid:img0&#x40;govmail">', stored)).toBe('<img src="blob:x/9">');
  });

  it('falls back to the base when the html omits the @domain', () => {
    const stored = new Map([['image001.gif@01DD2986.DAAA8E30', 'blob:x/9']]);
    expect(rewriteCidRefs('<img src="cid:image001.gif">', stored)).toBe('<img src="blob:x/9">');
  });

  it('matches case-insensitively on the cid itself', () => {
    const stored = new Map([['IMG0@GovMail', 'blob:x/9']]);
    expect(rewriteCidRefs('<img src="cid:img0@govmail">', stored)).toBe('<img src="blob:x/9">');
  });

  it('returns the input unchanged for an empty map', () => {
    expect(rewriteCidRefs('<img src="cid:c1">', new Map())).toBe('<img src="cid:c1">');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && npx vitest run lib/emailRender.test.ts`
Expected: FAIL — `rewriteCidRefs` is not exported.

- [ ] **Step 3: Write the pure rewriter**

Add to `apps/web/lib/emailRender.ts`:

```typescript
/** Stored cids arrive wrapped in angle brackets; HTML `src="cid:…"` never has them. */
const bareCid = (cid: string) => cid.replace(/^<|>$/g, '');

/**
 * Swap `src="cid:…"` for a resolved URL.
 *
 * Three normalisations, all of them load-bearing and all of them copied from the
 * embed code this replaces (`mail.service.ts:1349-1358`, and see
 * `zimbra.mappers.ts:106`):
 *
 *  1. Stored cids are wrapped in angle brackets — `<img0@govmail>` — while the
 *     HTML reference never is. Both sides are stripped before comparison.
 *  2. HTML may encode the `@` as `&#64;` or `&#x40;`.
 *  3. Some mail references only the part before the `@`, so a full-cid miss
 *     falls back to matching on that base.
 *
 * An unresolved cid is left exactly as it was: a broken image icon is a better
 * failure than a blank src, which some renderers treat as the page itself.
 */
export function rewriteCidRefs(html: string, resolved: Map<string, string>): string {
  if (!html || resolved.size === 0) return html;

  const byCid = new Map<string, string>();
  const byBase = new Map<string, string>();
  for (const [cid, url] of resolved) {
    const bare = bareCid(cid);
    byCid.set(bare.toLowerCase(), url);
    const base = bare.split('@')[0];
    if (base && !byBase.has(base.toLowerCase())) byBase.set(base.toLowerCase(), url);
  }

  return html.replace(
    /src=(["'])cid:([^"']+)\1/gi,
    (whole, quote: string, raw: string) => {
      const ref = bareCid(raw).replace(/&#(?:64|x40);/gi, '@').toLowerCase();
      const url = byCid.get(ref) ?? byBase.get(ref.split('@')[0]);
      return url ? `src=${quote}${url}${quote}` : whole;
    },
  );
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/web && npx vitest run lib/emailRender.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Add the API client method**

In `apps/web/lib/api.ts`, inside the `mail` namespace, beside `downloadAttachment`
(which is the pattern — read it first and match it):

```typescript
    /** Inline image as a blob: URL. The iframe is sandboxed and cannot send a
     *  bearer token, so the bytes are fetched here and handed over as a blob. */
    inlineImage: async (messageId: string, partId: string): Promise<string> => {
      if (USE_MOCK) return '';
      const token = getToken();
      const res = await fetch(
        `${API_BASE}/mail/messages/${messageId}/inline/${encodeURIComponent(partId)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error('Failed to load inline image');
      return URL.createObjectURL(await res.blob());
    },
```

- [ ] **Step 6: Write the hook**

Create `apps/web/lib/mail/useInlineImages.ts`:

```typescript
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
```

- [ ] **Step 7: Wire both render sites**

In `apps/web/components/mail/ThreadMessage.tsx`, call the hook above the `docs`
`useMemo` at line 288 and feed its result in:

```typescript
  const inlineUrls = useInlineImages(message?.id ?? null, message?.inlineImages);
```

then inside that memo, replace `const body = prepareEmailHtml(html);` with:

```typescript
    const body = prepareEmailHtml(rewriteCidRefs(html, inlineUrls));
```

and add `inlineUrls` to the memo's dependency array. Do the same at
`MailDetail.tsx`'s equivalent `srcDoc` construction — it already declares
`inlineImages` on its props interface at line 50.

**Hook order:** the hook must be called unconditionally, above any early return.
`ThreadMessage` already has a comment at line 286 explaining that hooks run
before the no-html early return for exactly this reason; keep that property.

- [ ] **Step 8: Run the web suite and typecheck**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: all green, including the existing `ThreadMessageContrast.test.tsx`
which mounts `ThreadMessage` for real.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/emailRender.ts apps/web/lib/emailRender.test.ts apps/web/lib/mail/useInlineImages.ts apps/web/lib/api.ts apps/web/components/mail/ThreadMessage.tsx apps/web/components/mail/MailDetail.tsx
git commit -m "feat(web): resolve inline images to blob urls instead of reading them from the body"
```

---

### Task 5: Eviction

**Files:**
- Create: `apps/api/src/mail/inline-image-evict.worker.ts`
- Test: `apps/api/src/mail/inline-image-evict.worker.spec.ts`
- Modify: `apps/api/src/mail/mail.module.ts`

**Interfaces:**
- Consumes: `InlineImageCacheService.CACHE_ROOT` (Task 1).
- Produces: `InlineImageEvictWorker.processTick(): Promise<{ removed: number; bytesFreed: number; hitCeiling: boolean }>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/mail/inline-image-evict.worker.spec.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InlineImageEvictWorker } from './inline-image-evict.worker';

function put(root: string, rel: string, bytes: number, ageDays = 0) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes));
  const t = Date.now() / 1000 - ageDays * 86400;
  utimesSync(full, t, t);
  return full;
}

describe('InlineImageEvictWorker', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'evict-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes files past the age horizon', async () => {
    const old = put(root, 'u1/m1/1.1', 10, 120);
    const fresh = put(root, 'u1/m1/1.2', 10, 1);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 1e9 });

    const r = await w.processTick();

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(r.removed).toBe(1);
  });

  it('enforces the size ceiling by evicting least-recently-used first', async () => {
    const oldest = put(root, 'u1/m1/a', 100, 5);
    const newer  = put(root, 'u1/m1/b', 100, 2);
    const newest = put(root, 'u1/m1/c', 100, 1);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 250 });

    await w.processTick();

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });

  it('does nothing when under the ceiling and inside the horizon', async () => {
    const f = put(root, 'u1/m1/a', 10, 1);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 1e9 });

    const r = await w.processTick();

    expect(existsSync(f)).toBe(true);
    expect(r.removed).toBe(0);
    expect(r.hitCeiling).toBe(false);
  });

  it('reports hitting the ceiling so a sweep that never catches up is visible', async () => {
    for (let i = 0; i < 5; i++) put(root, `u1/m1/f${i}`, 100, 1);
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 90, maxTotalBytes: 250, maxRemovalsPerTick: 1 });

    const r = await w.processTick();

    expect(r.removed).toBe(1);
    expect(r.hitCeiling).toBe(true);
  });

  it('falls back to the default when a setting is zero or not a number', () => {
    // An empty env var parses to 0, which would set the horizon to now and
    // delete the entire cache on the next tick.
    const w = new InlineImageEvictWorker(root, { maxAgeDays: 0, maxTotalBytes: NaN });
    expect(w.settings.maxAgeDays).toBe(90);
    expect(w.settings.maxTotalBytes).toBeGreaterThan(0);
  });

  it('does not throw when the cache directory does not exist', async () => {
    const w = new InlineImageEvictWorker(join(root, 'nope'), { maxAgeDays: 90, maxTotalBytes: 1e9 });
    await expect(w.processTick()).resolves.toMatchObject({ removed: 0 });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx jest src/mail/inline-image-evict.worker.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the worker**

Create `apps/api/src/mail/inline-image-evict.worker.ts`:

```typescript
import { promises as fs } from 'fs';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CACHE_ROOT_DEFAULT } from './inline-image-cache.service';

const DEFAULTS = { maxAgeDays: 90, maxTotalBytes: 2 * 1024 * 1024 * 1024, maxRemovalsPerTick: 5000 };

/** An empty env var yields NaN or 0; either would evict the whole cache. */
function positive(value: number | undefined, fallback: number, logger: Logger, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (value !== undefined) logger.warn(`${name}=${value} is not a positive number; using ${fallback}`);
  return fallback;
}

interface Entry { path: string; size: number; atimeMs: number }

/**
 * Ages the inline-image cache out, by horizon AND by total size. On a
 * disk-constrained box the ceiling matters more than the age.
 */
@Injectable()
export class InlineImageEvictWorker {
  private readonly logger = new Logger(InlineImageEvictWorker.name);
  readonly settings: { maxAgeDays: number; maxTotalBytes: number; maxRemovalsPerTick: number };

  constructor(
    private readonly root: string = CACHE_ROOT_DEFAULT,
    overrides: Partial<typeof DEFAULTS> = {},
  ) {
    this.settings = {
      maxAgeDays: positive(overrides.maxAgeDays ?? Number(process.env.INLINE_IMAGE_MAX_AGE_DAYS), DEFAULTS.maxAgeDays, this.logger, 'INLINE_IMAGE_MAX_AGE_DAYS'),
      maxTotalBytes: positive(overrides.maxTotalBytes ?? Number(process.env.INLINE_IMAGE_MAX_TOTAL_BYTES), DEFAULTS.maxTotalBytes, this.logger, 'INLINE_IMAGE_MAX_TOTAL_BYTES'),
      maxRemovalsPerTick: positive(overrides.maxRemovalsPerTick ?? Number(process.env.INLINE_IMAGE_MAX_REMOVALS), DEFAULTS.maxRemovalsPerTick, this.logger, 'INLINE_IMAGE_MAX_REMOVALS'),
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { waitForCompletion: true })
  async tick(): Promise<void> {
    try {
      const { removed, bytesFreed, hitCeiling } = await this.processTick();
      const mb = Math.round(bytesFreed / 1048576);
      if (hitCeiling) {
        this.logger.warn(`inline image eviction: -${removed} files (${mb} MB); HIT THE CEILING, more remains`);
      } else {
        this.logger.log(`inline image eviction: -${removed} files (${mb} MB); nothing left to remove`);
      }
    } catch (err: any) {
      this.logger.error(`inline image eviction failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ removed: number; bytesFreed: number; hitCeiling: boolean }> {
    const entries = await this.walk(this.root);
    const cutoff = Date.now() - this.settings.maxAgeDays * 86_400_000;

    // Least-recently-used first, so the size pass evicts the coldest.
    entries.sort((a, b) => a.atimeMs - b.atimeMs);

    const doomed: Entry[] = entries.filter((e) => e.atimeMs < cutoff);
    const keep = entries.filter((e) => e.atimeMs >= cutoff);
    let total = keep.reduce((n, e) => n + e.size, 0);
    for (const e of keep) {
      if (total <= this.settings.maxTotalBytes) break;
      doomed.push(e);
      total -= e.size;
    }

    let removed = 0, bytesFreed = 0;
    for (const e of doomed) {
      if (removed >= this.settings.maxRemovalsPerTick) {
        return { removed, bytesFreed, hitCeiling: true };
      }
      try { await fs.unlink(e.path); removed++; bytesFreed += e.size; } catch { /* already gone */ }
    }
    return { removed, bytesFreed, hitCeiling: false };
  }

  private async walk(dir: string): Promise<Entry[]> {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return []; }
    const out: Entry[] = [];
    for (const name of names) {
      const full = join(dir, name);
      try {
        const st = await fs.stat(full);
        if (st.isDirectory()) out.push(...(await this.walk(full)));
        else out.push({ path: full, size: st.size, atimeMs: st.mtimeMs });
      } catch { /* vanished mid-walk */ }
    }
    return out;
  }
}
```

- [ ] **Step 4: Register it**

Add `InlineImageEvictWorker` to `providers` in `apps/api/src/mail/mail.module.ts`.
`ScheduleModule.forRoot()` is already registered at `app.module.ts:26`, so the
cron is live once the provider is. **If it is omitted the sweep silently never
runs, which on a disk-constrained box looks identical to working.**

- [ ] **Step 5: Run them and watch them pass**

Run: `cd apps/api && npx jest src/mail && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (6 new tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/mail/inline-image-evict.worker.ts apps/api/src/mail/inline-image-evict.worker.spec.ts apps/api/src/mail/mail.module.ts
git commit -m "feat(api): age the inline image cache out by horizon and by size"
```

---

### Task 6: The backfill command

**Files:**
- Create: `apps/api/src/mail/backfill-inline-images.ts`
- Test: `apps/api/src/mail/backfill-inline-images.spec.ts`
- Modify: `apps/api/package.json` (a `backfill:inline-images` script)

**Interfaces:**
- Consumes: `InlineImageCacheService` (Task 1).
- Produces: `backfillMessage(row, cache): Promise<{ html: string; written: number; skipped: number }>` — pure enough to test without a database.

**Why the mapping matters:** verified 2026-09-17, every oversized body on both
boxes retains its `inlineImages` with a real `partId` (854/854 and 442/442). That
is what lets the backfill write bytes under the *provider's* part id, so an
evicted file is re-fetchable. Do not invent synthetic part ids — that would make
the cache the only copy.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/mail/backfill-inline-images.spec.ts`:

```typescript
import { backfillMessage } from './backfill-inline-images';

const cache = () => ({ write: jest.fn().mockResolvedValue(true) } as any);

const PNG = Buffer.from('fakepng').toString('base64');

describe('backfillMessage', () => {
  it('lifts a data uri into the cache and rewrites the tag to its cid', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
      inlineImages: [{ cid: 'c1', partId: '1.1.2', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1">');
    expect(r.written).toBe(1);
    expect(c.write).toHaveBeenCalledWith('u1', 'm1', '1.1.2', expect.any(Buffer));
    expect((c.write.mock.calls[0][3] as Buffer).toString()).toBe('fakepng');
  });

  it('pairs data uris with inlineImages entries in order', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}"><img src="data:image/gif;base64,${PNG}">`,
      inlineImages: [
        { cid: 'c1', partId: '1.1', mimeType: 'image/png' },
        { cid: 'c2', partId: '1.2', mimeType: 'image/gif' },
      ],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1"><img src="cid:c2">');
    expect(c.write.mock.calls.map((x: any[]) => x[2])).toEqual(['1.1', '1.2']);
  });

  it('leaves a data uri alone when there is no mapping left for it', async () => {
    // Safety valve: rewriting to a cid with nothing behind it would lose the image.
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
      inlineImages: [],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toContain('data:image/png;base64');
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('leaves the tag as a data uri when the cache write fails', async () => {
    const c = cache();
    c.write.mockResolvedValue(false);
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: `<img src="data:image/png;base64,${PNG}">`,
      inlineImages: [{ cid: 'c1', partId: '1.1', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toContain('data:image/png;base64');
    expect(r.skipped).toBe(1);
  });

  it('is idempotent — a body already rewritten is left untouched', async () => {
    const c = cache();
    const row = {
      id: 'm1', userId: 'u1',
      bodyHtml: '<img src="cid:c1">',
      inlineImages: [{ cid: 'c1', partId: '1.1', mimeType: 'image/png' }],
    };

    const r = await backfillMessage(row as any, c);

    expect(r.html).toBe('<img src="cid:c1">');
    expect(r.written).toBe(0);
    expect(c.write).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx jest src/mail/backfill-inline-images.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the backfill**

Create `apps/api/src/mail/backfill-inline-images.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import { InlineImageCacheService } from './inline-image-cache.service';

interface Row {
  id: string;
  userId: string;
  bodyHtml: string | null;
  inlineImages: unknown;
}

/**
 * Lift every data: URI in one body into the cache and rewrite the tag back to
 * its `cid:`. Pairs URIs with `inlineImages` entries in document order, which
 * is the order embedInlineImages wrote them.
 *
 * Idempotent: a body already rewritten contains no data: URIs and is returned
 * untouched, so the job is safe to re-run after an interruption.
 *
 * A URI with no mapping left, or whose cache write fails, is LEFT AS A DATA URI.
 * Rewriting it to a cid with nothing behind it would lose the image outright.
 */
export async function backfillMessage(
  row: Row,
  cache: Pick<InlineImageCacheService, 'write'>,
): Promise<{ html: string; written: number; skipped: number }> {
  const html = row.bodyHtml ?? '';
  const maps = ((row.inlineImages as any[]) ?? []).filter((m) => m?.cid && m?.partId);

  let written = 0, skipped = 0, index = 0;
  const parts: string[] = [];
  let last = 0;

  const re = /src=(["'])data:(image\/[^;]+);base64,([^"']+)\1/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const mapping = maps[index++];
    parts.push(html.slice(last, m.index));
    last = m.index + m[0].length;

    if (!mapping) { parts.push(m[0]); skipped++; continue; }

    const buf = Buffer.from(m[3], 'base64');
    const ok = await cache.write(row.userId, row.id, mapping.partId, buf);
    if (!ok) { parts.push(m[0]); skipped++; continue; }

    parts.push(`src=${m[1]}cid:${mapping.cid}${m[1]}`);
    written++;
  }
  parts.push(html.slice(last));

  return { html: parts.join(''), written, skipped };
}

/** Entry point: `pnpm --filter api backfill:inline-images`. */
export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const cache = new InlineImageCacheService();
  let scanned = 0, rewritten = 0, images = 0, skipped = 0;

  // Paged by id so an interruption resumes simply by re-running.
  let cursor: string | undefined;
  for (;;) {
    const rows: Row[] = await prisma.$queryRawUnsafe(
      `select id, "userId", "bodyHtml", "inlineImages" from messages
        where "bodyHtml" like '%data:image%' ${cursor ? `and id > '${cursor}'` : ''}
        order by id limit 50`,
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      const r = await backfillMessage(row, cache);
      images += r.written; skipped += r.skipped;
      if (r.written > 0) {
        await prisma.message.update({ where: { id: row.id }, data: { bodyHtml: r.html } });
        rewritten++;
      }
      cursor = row.id;
    }
    console.log(`  scanned ${scanned}, rewritten ${rewritten}, images ${images}, skipped ${skipped}`);
  }

  console.log(`done: ${rewritten}/${scanned} bodies rewritten, ${images} images cached, ${skipped} left as data URIs`);
  console.log('now run:  VACUUM FULL messages;   -- required to return the space to the OS');
  await prisma.$disconnect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Add the script**

In `apps/api/package.json` scripts:

```json
    "backfill:inline-images": "ts-node src/mail/backfill-inline-images.ts"
```

`ts-node` is already a dependency and `apps/api` has no existing one-off script to
copy — its scripts are all build, test and start. So this is the first of its kind
and the `ts-node` form above is correct rather than a guess.

- [ ] **Step 5: Run them and watch them pass**

Run: `cd apps/api && npx jest src/mail && npx tsc --noEmit -p tsconfig.json`
Expected: PASS (5 new tests).

- [ ] **Step 6: Remove the now-dead embed path**

Delete `embedInlineImages` from `mail.service.ts` and any helper used only by it.
Run the whole suite again; anything that breaks was depending on embedding and
must be updated to the new behaviour, not deleted.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/mail/backfill-inline-images.ts apps/api/src/mail/backfill-inline-images.spec.ts apps/api/package.json apps/api/src/mail/mail.service.ts
git commit -m "feat(api): backfill embedded images into the cache, and drop the embed path"
```

---

## After the plan

- [ ] Whole suite in both apps and both typechecks.
- [ ] **Create the cache directory on each VM before deploying:**
      `sudo install -d -o risa1 -g risa1 -m 700 /opt/govmail/imgcache` (user `test` on `.155`).
- [ ] Deploy api + web to both VMs. **No migration in this release** — unlike the last two.
- [ ] **Re-run the mapping check per box before its backfill** (spec §6.1) — it is cheap and the answer could differ on a box synced since.
- [ ] **Size the two caps before the backfill — they are not code changes, they are per-box
      decisions the final review flagged (C3, C4).**
      - Measure the per-image size distribution on `.155` first. `INLINE_IMAGE_MAX_BYTES`
        defaults to 5 MB, and the tail this feature exists for — 648 bodies holding 13 GB,
        one of them 133 MB — is exactly where single images exceed it. Images over the cap
        stay embedded. Raise the env var **for the backfill run only** if the distribution
        says so; the run report now names why each image was left behind, so check it.
      - `INLINE_IMAGE_MAX_TOTAL_BYTES` defaults to 2 GB and neither box sets it. The backfill
        will write roughly 10 GB on `.155` and 4 GB on `.154`. Left at the default, the first
        04:00 tick evicts ~80% of what was just written at 5,000 removals a day, and every
        evicted image becomes a provider refetch. Set the ceiling deliberately per box against
        actual free space — `.155` is at 68%.
      - Check free space against the expected cache size on both boxes. Disk holds the old
        bodies *and* the new cache until `VACUUM FULL` runs.
- [ ] Run the backfill, then `VACUUM FULL messages` in a chosen window. It takes an exclusive lock; the API is down for minutes.
- [ ] **Capture the backfill's `ambiguous:` lines before `VACUUM FULL`.** A body whose data
      URIs cannot be proved to match its `inlineImages` is skipped whole and left embedded —
      that list is the only record of which rows need reclaiming by hand, and the originals
      are gone once the vacuum runs.
- [ ] **First open of an already-cached message pays one provider fetch.** Cache filenames are
      now the sha256 of the part id; anything written by a box running an earlier build misses
      and is refetched and rewritten once. Harmless, but do not read it as a cache failure.
- [ ] **Confirm the cache actually stores bytes on the Exchange box (`.155`).** An EWS
      `AttachmentId` runs 150-400 characters, which is why the filename is hashed; verify
      against one real Exchange message that files land under `/opt/govmail/imgcache` rather
      than the write silently failing.
- [ ] **Check the mount is not `noatime`** (`findmnt -no OPTIONS /opt`). With it, eviction
      degrades from LRU to FIFO with no signal — accepted, but worth knowing which one is running.
- [ ] Confirm the table collapsed: `.155` from 15 GB and `.154` from 6.3 GB.
- [ ] Exclude `/opt/govmail/imgcache` from any backup — the cache is authoritative for nothing.
- [ ] Live check: open a message with inline images, confirm they render; reopen and confirm the second open does not hit the provider (`journalctl -u govmail-api | grep inline`).
- [ ] Re-measure bytes per message and update the infra scale plan. Record both the mean and the tail — the 295 KB anchor is a mean over a very heavy tail, which is what made it misleading.
- [ ] Release note: **inline images now require a connection** — they previously worked offline because they were embedded. This is the only regression in the change.
