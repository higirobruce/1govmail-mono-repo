# Sessions & Device Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user see their active login sessions (device/browser, IP, last-active time) in Settings → Security, sign a specific one out remotely, or sign out every other device at once.

**Architecture:** The `Session` Prisma model already exists but is currently vestigial — nothing ever creates a row in it, and JWT validation only checks the signature/expiry, never the database. This plan wires it up end to end: `AuthService.createSession` starts persisting a row per login, `JwtStrategy` starts looking that row up on every authenticated request (so revoking a session actually takes effect immediately), and three new endpoints expose list/revoke-one/revoke-all-others to the frontend.

**Tech Stack:** NestJS 11, Prisma 7/PostgreSQL, `passport-jwt`, Jest (api), Next.js 16, Vitest (web), `date-fns` for relative timestamps (already a web dependency).

**Spec:** No separate spec doc exists for this feature — requirements are captured inline in the Context section below, derived from a live comparison against the RISA Zimbra Modern UI's "Sessions and Devices" settings pane (see the published gap-analysis artifact from this conversation).

## Context (why this is shaped the way it is)

Confirmed by reading the current code: `AuthService.createSession` (`apps/api/src/auth/auth.service.ts`) signs a JWT and upserts the `User` row, but **never** creates a `Session` row. `JwtStrategy.validate` (`apps/api/src/auth/strategies/jwt.strategy.ts`) only checks the JWT's signature and expiry via `passport-jwt` — it never touches the database. The existing `logout()` does `prisma.session.deleteMany({ where: { userId } })`, which today is a silent no-op, since no rows exist to delete. In short: the `Session` table is dead code until this plan brings it to life.

**Deliberate design boundary — the existing `/auth/logout` endpoint is untouched.** `User.authToken`/`csrfToken` (the actual Zimbra credential) is a single shared field per `User` row, not per-session. That means a per-device "sign out" that revoked the shared Zimbra token would break every *other* still-logged-in device's mail access too — the opposite of what "sign out this one device" should mean. So the three new endpoints this plan adds (list / revoke-one / revoke-others) only ever touch `Session` rows, never `User.authToken`. Revoking a session immediately blocks that device from using the *app* (its JWT gets rejected on its next request, per Task 2), even though the underlying Zimbra credential is shared and unaffected. The main "Log out" button keeps its existing full-account behavior (clears the Zimbra token and, incidentally, now also actually deletes `Session` rows instead of no-op'ing).

**Deployment note:** once Task 2 ships, JWTs issued *before* this change have no matching `Session` row (since none were ever created) and will be rejected on their next request. Every currently-logged-in user will be prompted to log in again, once. This is expected, not a bug — call it out in the release notes rather than being surprised by a support ticket.

## Global Constraints

- Do not modify the existing `/auth/logout` behavior or its route.
- Follow the exact `@Req() req: AuthenticatedRequest` + `req.user.sub` pattern for the current user.
- Migration command: `cd apps/api && npx prisma migrate dev --name <name>`.
- `apps/api` tests run with Jest (`*.spec.ts`); `apps/web` tests run with Vitest (`*.test.ts(x)`).

---

### Task 1: Prisma schema — `lastSeenAt` on `Session`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Produces: `Session.lastSeenAt` field, read/written by Task 2 and Task 4.

- [ ] **Step 1: Add the field**

In the existing `Session` model in `apps/api/prisma/schema.prisma`, add `lastSeenAt` next to `createdAt`:

```prisma
model Session {
  id         String   @id @default(cuid())
  userId     String
  token      String   @unique
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())
  userAgent  String?
  ipAddress  String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("sessions")
}
```

- [ ] **Step 2: Run the migration**

Run: `cd apps/api && npx prisma migrate dev --name add_session_last_seen_at`
Expected: migration file created, Prisma Client regenerated, no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(auth): add Session.lastSeenAt for device-activity tracking"
```

---

### Task 2: Database-backed JWT validation

**Files:**
- Modify: `apps/api/src/common/interfaces/authenticated-request.interface.ts`
- Modify: `apps/api/src/auth/strategies/jwt.strategy.ts`
- Test: `apps/api/src/auth/strategies/jwt.strategy.spec.ts`

**Interfaces:**
- Consumes: `Session` model from Task 1.
- Produces: `req.user.sessionId: string` on every authenticated request — consumed by Task 4's controller endpoints.

- [ ] **Step 1: Add `sessionId` to the request shape**

```ts
// apps/api/src/common/interfaces/authenticated-request.interface.ts
import { Request } from 'express';

/** Shape of `req` inside guards-protected controllers (after JwtStrategy.validate). */
export interface AuthenticatedRequest extends Request {
  user: {
    sub: string;       // user UUID (from JWT payload)
    email: string;
    sessionId: string; // Session row backing this JWT (from Task 2's DB-backed validation)
  };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/api/src/auth/strategies/jwt.strategy.spec.ts
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';

function makeStrategy() {
  const config = { get: () => 'test-secret' } as unknown as ConfigService;
  const prisma = { session: { findUnique: jest.fn(), update: jest.fn() } } as unknown as PrismaService;
  return { strategy: new JwtStrategy(config, prisma), prisma: prisma as any };
}

function makeReq(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as any;
}

describe('JwtStrategy', () => {
  const payload = { sub: 'u1', email: 'u1@example.com' };

  it('rejects when no matching session exists', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue(null);

    await expect(strategy.validate(makeReq('tok'), payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the session has expired', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue({ id: 's1', expiresAt: new Date(Date.now() - 1000) });

    await expect(strategy.validate(makeReq('tok'), payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a valid session, touches lastSeenAt, and returns sessionId', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue({ id: 's1', expiresAt: new Date(Date.now() + 60_000) });
    prisma.session.update.mockResolvedValue({});

    const result = await strategy.validate(makeReq('tok'), payload);

    expect(result).toEqual({ sub: 'u1', email: 'u1@example.com', sessionId: 's1' });
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { lastSeenAt: expect.any(Date) },
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/api && npx jest jwt.strategy`
Expected: FAIL — `JwtStrategy is not a constructor` or an arity error, since the class doesn't accept a second constructor argument yet.

- [ ] **Step 4: Implement**

```ts
// apps/api/src/auth/strategies/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt', true) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      passReqToCallback: true,
      // ConfigService returns string|undefined; passport-jwt requires string|Buffer
      secretOrKey: config.get<string>('JWT_SECRET') ?? '',
    });
  }

  // Pre-auth two-factor challenge tokens are verified manually in
  // AuthService.loginTwoFactor and never reach this guard-backed strategy,
  // so `payload.sub` here is always a real user id, never 'zimbra:two-factor'.
  async validate(req: Request, payload: { sub: string; email: string }) {
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    if (!token) throw new UnauthorizedException();

    const session = await this.prisma.session.findUnique({ where: { token } });
    if (!session || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Session expired or signed out. Please log in again.');
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });

    return { sub: payload.sub, email: payload.email, sessionId: session.id };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx jest jwt.strategy`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/common/interfaces/authenticated-request.interface.ts apps/api/src/auth/strategies/jwt.strategy.ts apps/api/src/auth/strategies/jwt.strategy.spec.ts
git commit -m "feat(auth): validate JWTs against a live Session row, not just signature/expiry"
```

---

### Task 3: Persist a `Session` row on login

**Files:**
- Modify: `apps/api/src/auth/auth.service.ts`
- Test: `apps/api/src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `Session` model from Task 1.
- Produces: a `Session` row per successful login, with `token` equal to the issued JWT — read by Task 2's strategy, listed/revoked by Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/auth/auth.service.spec.ts
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { AuditService } from '../common/audit/audit.service';

function makeService() {
  const prisma = {
    user: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    session: { create: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const zimbra = { authenticate: jest.fn() } as unknown as ZimbraService;
  const jwt = { sign: jest.fn(() => 'signed.jwt.token'), verify: jest.fn() } as unknown as JwtService;
  const audit = { record: jest.fn() } as unknown as AuditService;
  const service = new AuthService(prisma, zimbra, jwt, audit);
  return { service, prisma: prisma as any, zimbra: zimbra as any, jwt: jwt as any, audit: audit as any };
}

describe('AuthService.login', () => {
  it('persists a Session row tied to the issued token', async () => {
    const { service, prisma, zimbra } = makeService();
    zimbra.authenticate.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime: 3_600_000,
      displayName: 'Test User',
      refer: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u1@example.com', displayName: 'Test User', zimbraHost: 'mail.example.com',
    });

    await service.login('u1@example.com', 'pw', 'mail.example.com', { ip: '10.0.0.1', userAgent: 'Vitest/1.0' });

    expect(prisma.session.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        token: 'signed.jwt.token',
        expiresAt: expect.any(Date),
        userAgent: 'Vitest/1.0',
        ipAddress: '10.0.0.1',
      },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx jest auth.service`
Expected: FAIL — `expect(prisma.session.create).toHaveBeenCalledWith(...)` sees zero calls.

- [ ] **Step 3: Implement**

In `apps/api/src/auth/auth.service.ts`, inside `createSession`, right after `const accessToken = this.jwt.sign({ sub: user.id, email: user.email });`, add:

```ts
    await this.prisma.session.create({
      data: {
        userId: user.id,
        token: accessToken,
        expiresAt: tokenExpiry,
        userAgent: ctx.userAgent ?? null,
        ipAddress: ctx.ip ?? null,
      },
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx jest auth.service`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/auth.service.ts apps/api/src/auth/auth.service.spec.ts
git commit -m "feat(auth): create a Session row on every successful login"
```

---

### Task 4: List and revoke sessions

**Files:**
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Test: `apps/api/src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `req.user.sessionId` from Task 2.
- Produces: `AuthService.getSessions/revokeSession/revokeOtherSessions`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others` — consumed by Task 5's API client.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/auth/auth.service.spec.ts` (the `makeService()` helper from Task 3 already stubs `findFirst`/`delete`/`findMany` on `prisma.session`, so no changes needed there):

```ts
import { NotFoundException } from '@nestjs/common';

describe('AuthService sessions', () => {
  it('lists sessions ordered by lastSeenAt, flagging the current one', async () => {
    const { service, prisma } = makeService();
    prisma.session.findMany.mockResolvedValue([
      { id: 's1', userAgent: 'Chrome', ipAddress: '10.0.0.1', createdAt: new Date(), lastSeenAt: new Date() },
      { id: 's2', userAgent: 'Firefox', ipAddress: '10.0.0.2', createdAt: new Date(), lastSeenAt: new Date() },
    ]);

    const result = await service.getSessions('u1', 's2');

    expect(prisma.session.findMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, orderBy: { lastSeenAt: 'desc' } });
    expect(result.find((s: any) => s.id === 's2').isCurrent).toBe(true);
    expect(result.find((s: any) => s.id === 's1').isCurrent).toBe(false);
  });

  it('revokeSession deletes an owned session', async () => {
    const { service, prisma } = makeService();
    prisma.session.findFirst.mockResolvedValue({ id: 's1', userId: 'u1' });

    const result = await service.revokeSession('u1', 's1');

    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(result).toEqual({ success: true });
  });

  it('revokeSession throws NotFoundException for a session the user does not own', async () => {
    const { service, prisma } = makeService();
    prisma.session.findFirst.mockResolvedValue(null);

    await expect(service.revokeSession('u1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revokeOtherSessions deletes every session except the current one', async () => {
    const { service, prisma } = makeService();
    prisma.session.deleteMany.mockResolvedValue({ count: 2 });

    const result = await service.revokeOtherSessions('u1', 's-current');

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', id: { not: 's-current' } } });
    expect(result).toEqual({ success: true, revoked: 2 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx jest auth.service -t "sessions"`
Expected: FAIL — `service.getSessions is not a function`.

- [ ] **Step 3: Implement the service methods**

Add `NotFoundException` to the existing `@nestjs/common` import at the top of `apps/api/src/auth/auth.service.ts`:

```ts
import { Injectable, UnauthorizedException, NotFoundException, Logger } from '@nestjs/common';
```

Then add the three methods (anywhere after `logout`, before the closing class brace):

```ts
  async getSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      isCurrent: s.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({ where: { userId, id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    await this.prisma.session.delete({ where: { id: sessionId } });
    return { success: true };
  }

  async revokeOtherSessions(userId: string, currentSessionId: string) {
    const { count } = await this.prisma.session.deleteMany({
      where: { userId, id: { not: currentSessionId } },
    });
    return { success: true, revoked: count };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx jest auth.service`
Expected: PASS, all tests including the one from Task 3.

- [ ] **Step 5: Add the controller endpoints**

In `apps/api/src/auth/auth.controller.ts`, extend the `@nestjs/common` import:

```ts
import { Controller, Post, Get, Delete, Param, Body, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
```

Add, after the existing `logout` method:

```ts
  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  getSessions(@Req() req: AuthenticatedRequest) {
    return this.authService.getSessions(req.user.sub, req.user.sessionId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  revokeSession(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.authService.revokeSession(req.user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  revokeOtherSessions(@Req() req: AuthenticatedRequest) {
    return this.authService.revokeOtherSessions(req.user.sub, req.user.sessionId);
  }
```

- [ ] **Step 6: Manually verify**

Log in twice (e.g. once in a normal browser window, once in a private/incognito window) to create two `Session` rows, then from the first window:
```bash
curl http://localhost:3001/api/auth/sessions -H "Authorization: Bearer <jwt-from-first-window>"
```
Expected: an array of two sessions, exactly one with `isCurrent: true`. Then `DELETE /auth/sessions/<the-other-one's-id>` and confirm the second window's next request gets a 401.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/auth.service.ts apps/api/src/auth/auth.controller.ts apps/api/src/auth/auth.service.spec.ts
git commit -m "feat(auth): list, revoke, and bulk-revoke-others active sessions"
```

---

### Task 5: Frontend API client

**Files:**
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: the three `/auth/sessions*` endpoints from Task 4.
- Produces: `api.auth.getSessions()`, `.revokeSession(id)`, `.revokeOtherSessions()` — consumed by Task 6.

- [ ] **Step 1: Add the methods**

In `apps/web/lib/api.ts`, inside the existing `auth: { ... }` object, directly after the existing `logout` entry:

```ts
    getSessions: () => {
      if (USE_MOCK) return delay<any[]>([]);
      return request<any[]>('/auth/sessions');
    },
    revokeSession: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/auth/sessions/${id}`, { method: 'DELETE' });
    },
    revokeOtherSessions: () => {
      if (USE_MOCK) return delay({ success: true, revoked: 0 });
      return request<any>('/auth/sessions/revoke-others', { method: 'POST' });
    },
```

- [ ] **Step 2: Manually verify the shape compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(auth): add sessions API client namespace"
```

---

### Task 6: Frontend — Active Sessions panel in Security settings

**Files:**
- Modify: `apps/web/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `api.auth.getSessions/revokeSession/revokeOtherSessions` from Task 5.

- [ ] **Step 1: Add icon imports**

Add `Monitor` and `LogOut` to the existing `lucide-react` import list in `apps/web/app/(app)/settings/page.tsx`:

```ts
import {
  User, Pen, Shield, Mail, Loader2, Plus, Trash2,
  Check, ChevronRight, RotateCcw, FileSignature,
  Palmtree, Settings2, Sparkles, AlertTriangle, Ban,
  Bold, Italic, Underline as UnderlineIcon, Image as ImageIcon,
  Monitor, LogOut,
} from 'lucide-react';
```

Add the `date-fns` import used elsewhere in this app for relative timestamps (e.g. `apps/web/components/mail/ThreadHeader.tsx`):

```ts
import { formatDistanceToNow, parseISO } from 'date-fns';
```

- [ ] **Step 2: Add state and data loading to `SecuritySection`**

At the top of the existing `SecuritySection` function body in `apps/web/app/(app)/settings/page.tsx` (alongside the existing `oldPwd`/`newPwd`/etc. state), add:

```tsx
  const [sessions, setSessions] = useState<Array<{
    id: string; userAgent: string | null; ipAddress: string | null;
    createdAt: string; lastSeenAt: string; isCurrent: boolean;
  }>>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const data = await api.auth.getSessions();
      setSessions(data);
    } catch (err: any) {
      toast.error('Failed to load sessions', { description: err?.message });
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const handleRevoke = async (id: string) => {
    try {
      await api.auth.revokeSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      toast.success('Session signed out');
    } catch (err: any) {
      toast.error('Failed to sign out session', { description: err?.message });
    }
  };

  const handleRevokeOthers = async () => {
    try {
      const result = await api.auth.revokeOtherSessions();
      toast.success(`Signed out ${result.revoked} other session${result.revoked === 1 ? '' : 's'}`);
      await loadSessions();
    } catch (err: any) {
      toast.error('Failed to sign out other sessions', { description: err?.message });
    }
  };
```

- [ ] **Step 3: Render the panel**

Inside `SecuritySection`'s returned JSX, after the existing password-change `<div className="max-w-sm space-y-4">...</div>` block and its closing tag, add:

```tsx
      <Separator className="my-6" />

      <SectionHeader
        title="Active sessions"
        description="Devices currently signed in to your account."
      />

      {sessionsLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
        </div>
      ) : (
        <div className="max-w-md space-y-2">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 py-2 px-3 rounded bg-muted/20">
              <div className="flex items-center gap-2.5 min-w-0">
                <Monitor className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm truncate">
                    {s.userAgent ?? 'Unknown device'}
                    {s.isCurrent && <span className="ml-2 text-xs text-primary">This session</span>}
                  </p>
                  <p className="text-xs text-muted-foreground/60">
                    {s.ipAddress ?? 'Unknown IP'} · last active {formatDistanceToNow(parseISO(s.lastSeenAt), { addSuffix: true })}
                  </p>
                </div>
              </div>
              {!s.isCurrent && (
                <button
                  onClick={() => handleRevoke(s.id)}
                  className="text-xs text-muted-foreground/60 hover:text-destructive shrink-0 flex items-center gap-1"
                >
                  <LogOut className="w-3.5 h-3.5" /> Sign out
                </button>
              )}
            </div>
          ))}

          {sessions.filter((s) => !s.isCurrent).length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRevokeOthers}
              className="h-8 text-xs gap-1.5 mt-2"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign out all other sessions
            </Button>
          )}
        </div>
      )}
```

- [ ] **Step 4: Manually verify in the browser**

Log in from two different browsers (or one normal + one private window). In the first, go to Settings → Security, confirm both sessions appear, the current one is marked "This session" and has no Sign out button, the other has one. Click "Sign out" on the other session, confirm it disappears from the list and that browser's next action redirects to login. Log in again from a third place and use "Sign out all other sessions" from the first, confirming only the current one remains.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/\(app\)/settings/page.tsx
git commit -m "feat(auth): show active sessions with per-device and bulk sign-out"
```

---

## Follow-ups (explicitly out of scope for this plan)

- Parsing `userAgent` into a friendly "Chrome on macOS" label instead of showing the raw string — cosmetic, not required for the feature to work.
- Mobile ActiveSync device management (ActiveSync isn't used by this app at all, only browser JWT sessions) — a different subsystem entirely, not covered here.
