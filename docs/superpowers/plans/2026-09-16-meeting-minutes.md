# Meeting Minutes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone who can see a calendar event create the meeting's minutes from it — one canonical document per occurrence, automatically visible to every attendee and shareable with people who weren't there.

**Architecture:** Calendar events are stored per mailbox, so two attendees' copies of one meeting are unrelated rows. The iCalendar **UID** is the string every copy shares, so the providers start reporting it and a `MeetingMinutes` row keyed on `(icalUid, occurrenceStartAt)` links a meeting occurrence to one document. Creation is a single endpoint whose server side performs four writes in one small transaction: the document, an `EDITOR` invite per attendee, the read-only share link, and the link row. The document layer already grants access via invites and already lists "shared with me", so no new access-control model is introduced.

**Tech Stack:** NestJS 11 + Prisma 7 (api), Next.js 16 + React + TipTap (web), Jest (api) / Vitest + Testing Library (web).

**Spec:** `docs/superpowers/specs/2026-09-16-meeting-minutes-design.md` (commit `9d7e87d`)

## Global Constraints

- One canonical document **per occurrence**, not per series: the key is `(icalUid, occurrenceStartAt)`, and `occurrenceStartAt` is **always the event row's own `startAt`** (both providers expand a series into one row per instance).
- Attendee invites use role **`EDITOR`**. The share link uses **`SharePermission.VIEW`**.
- Attendee emails are **lowercased, deduped, blanks dropped, and the caller excluded** (they own the document).
- Creation is **idempotent by database key**, never by check-then-act: if a link row exists for the occurrence, return its `documentId` and create nothing.
- **Keep the transaction small.** Content arrives already composed from the client, no provider calls inside it, invites inserted with one `createMany`. (An interactive transaction holds a pooled connection — this is the lesson from the notifications work at the 5,000-mailbox target.)
- An event with **no `icalUid`** still produces a document, with **no link row**, and the response reports `linked: false`.
- `icalUid` is **optional** on the provider types: the memory provider leaves it unset, which is what exercises the fallback.
- Every task ends green: `npx jest` (api) or `npx vitest run` (web), plus `npx tsc --noEmit`.

## File structure

| File | Responsibility |
|---|---|
| `apps/api/src/provider/provider-types.ts` | `icalUid` on `ProviderEvent` / `ProviderEventDetail` |
| `apps/api/src/ews/ews-envelopes.ts` | request `calendar:UID` on both calendar envelopes |
| `apps/api/src/ews/ews.service.ts` | read `UID` from both responses |
| `apps/api/src/zimbra/zimbra.mappers.ts` | read `uid` from the appointment and its detail |
| `apps/api/prisma/schema.prisma` | `CalendarEvent.icalUid`, `MeetingMinutes` |
| `apps/api/src/calendar/calendar.service.ts` | persist `icalUid`; resolve the event; expose `minutesDocumentId` |
| `apps/api/src/docs/docs.service.ts` | owns every `Document` write, including the minutes transaction |
| `apps/api/src/calendar/dto/create-minutes.dto.ts` | the request body |
| `apps/api/src/calendar/calendar.controller.ts` | `POST events/:id/minutes` |
| `apps/web/lib/calendar/minutesPrefill.ts` | pure: event → `{ title, content }` from the Meeting Minutes template |
| `apps/web/lib/api.ts` | `api.calendar.createMinutes` |
| `apps/web/app/(app)/calendar/page.tsx` | the Create / Open button in the event drawer |

---

### Task 1: The providers report the iCalendar UID

**Files:**
- Modify: `apps/api/src/provider/provider-types.ts`
- Modify: `apps/api/src/ews/ews-envelopes.ts` (`findCalendarEnvelope`, `getAppointmentEnvelope`)
- Modify: `apps/api/src/ews/ews.service.ts` (event + detail mapping)
- Modify: `apps/api/src/zimbra/zimbra.mappers.ts` (`ZimbraAppointment`, `mapZimbraAppointment`, `ZimbraAppointmentDetail`, `mapZimbraAppointmentDetail`)
- Test: `apps/api/src/ews/ews.contacts-calendar.spec.ts`
- Test: `apps/api/src/zimbra/zimbra.mappers.spec.ts`
- Create: `apps/api/src/ews/__fixtures__/findcalendar-uid.success.xml`

**Interfaces:**
- Produces: `ProviderEvent.icalUid?: string | null` and `ProviderEventDetail.icalUid?: string | null`. Every later task reads `icalUid` off these.

- [ ] **Step 1: Write the failing EWS tests**

Add to `apps/api/src/ews/ews.contacts-calendar.spec.ts`:

```typescript
describe('EWS calendar UID', () => {
  it('asks for calendar:UID on both calendar envelopes', () => {
    // The UID is the only cross-user identity a meeting has; without it the
    // minutes of one meeting cannot be the same document for two attendees.
    expect(findCalendarEnvelope('2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z'))
      .toContain('<t:FieldURI FieldURI="calendar:UID"/>');
    expect(getAppointmentEnvelope('ITEM-1=='))
      .toContain('<t:FieldURI FieldURI="calendar:UID"/>');
  });

  it('reads the UID off a calendar list hit', async () => {
    const { svc } = svcWith(fixture('findcalendar-uid.success.xml'));
    const events = await svc.getCalendarEvents(SESSION, Date.parse('2026-09-01'), Date.parse('2026-09-30'));
    expect(events[0].icalUid).toBe('040000008200E00074C5B7101A82E008');
  });

  it('leaves icalUid null when the response carries no UID', async () => {
    const { svc } = svcWith(FIND_CALENDAR);   // the pre-existing fixture has none
    const events = await svc.getCalendarEvents(SESSION, Date.parse('2026-09-01'), Date.parse('2026-09-30'));
    expect(events[0].icalUid ?? null).toBeNull();
  });
});
```

Create `apps/api/src/ews/__fixtures__/findcalendar-uid.success.xml` — a copy of the existing `findcalendar.success.xml` with one `<t:UID>` added inside the `CalendarItem`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
  <m:FindItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
    xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
    <m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success">
      <m:ResponseCode>NoError</m:ResponseCode>
      <m:RootFolder TotalItemsInView="1" IncludesLastItemInRange="true"><t:Items>
        <t:CalendarItem>
          <t:ItemId Id="EVENT-1==" ChangeKey="K1"/>
          <t:Subject>Cabinet briefing</t:Subject>
          <t:UID>040000008200E00074C5B7101A82E008</t:UID>
          <t:Start>2026-09-17T09:00:00Z</t:Start>
          <t:End>2026-09-17T10:00:00Z</t:End>
          <t:IsAllDayEvent>false</t:IsAllDayEvent>
          <t:Location>Room 3</t:Location>
          <t:Organizer><t:Mailbox><t:EmailAddress>chair@minaffet.gov.rw</t:EmailAddress></t:Mailbox></t:Organizer>
        </t:CalendarItem>
      </t:Items></m:RootFolder>
    </m:FindItemResponseMessage></m:ResponseMessages>
  </m:FindItemResponse>
</s:Body></s:Envelope>
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx jest src/ews/ews.contacts-calendar.spec.ts -t "calendar UID"`
Expected: FAIL — the envelope does not contain the field, and `icalUid` is undefined rather than the fixture's value.

- [ ] **Step 3: Request and read the UID in EWS**

In `ews-envelopes.ts`, add the field to the `AdditionalProperties` block of **both** `findCalendarEnvelope` and `getAppointmentEnvelope`, beside the organizer field:

```typescript
    '<t:FieldURI FieldURI="calendar:UID"/>' +
```

In `ews.service.ts`, where a `CalendarItem` is mapped to a `ProviderEvent`, and where the appointment detail is mapped, carry it across:

```typescript
      // The one identity that is the same string in every attendee's copy of
      // this meeting — see the meeting-minutes spec §3.
      icalUid: textOf(item?.UID) ?? null,
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/api && npx jest src/ews/ews.contacts-calendar.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing Zimbra tests**

Add to `apps/api/src/zimbra/zimbra.mappers.spec.ts`:

```typescript
describe('Zimbra appointment UID', () => {
  it('reads uid off a search hit when Zimbra sends one', () => {
    const ev = mapZimbraAppointment({
      id: '520', name: 'Cabinet briefing', uid: 'cabinet-2026-09-17@zimbra',
      inst: [{ s: Date.parse('2026-09-17T09:00:00Z') }], dur: 3600000,
    } as any);
    expect(ev?.icalUid).toBe('cabinet-2026-09-17@zimbra');
  });

  it('leaves icalUid null when the search hit has no uid', () => {
    // Not every Zimbra version puts uid on the search response; the detail
    // fetch is the fallback, so a missing uid must be null and not a crash.
    const ev = mapZimbraAppointment({
      id: '520', name: 'Cabinet briefing',
      inst: [{ s: Date.parse('2026-09-17T09:00:00Z') }], dur: 3600000,
    } as any);
    expect(ev?.icalUid ?? null).toBeNull();
  });

  it('reads uid out of the appointment detail invite component', () => {
    const detail = mapZimbraAppointmentDetail({
      id: '520',
      inv: [{ comp: [{ uid: 'cabinet-2026-09-17@zimbra', at: [], or: { a: 'chair@risa.gov.rw' } }] }],
    } as any);
    expect(detail.icalUid).toBe('cabinet-2026-09-17@zimbra');
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/api && npx jest src/zimbra/zimbra.mappers.spec.ts -t "appointment UID"`
Expected: FAIL — `icalUid` is undefined in all three.

- [ ] **Step 7: Read the uid in the Zimbra mappers**

In `zimbra.mappers.ts`, add `uid?: string;` to both the `ZimbraAppointment` and the invite-component types, then return it:

```typescript
    // Zimbra puts uid on the appointment in most versions and always on the
    // invite component of a GetAppointment detail. Either is the same string
    // in every attendee's mailbox.
    icalUid: raw.uid ?? null,
```

and in `mapZimbraAppointmentDetail`, from the first invite component:

```typescript
    icalUid: comp?.uid ?? null,
```

In `provider-types.ts`, declare it on both interfaces:

```typescript
  /**
   * iCalendar UID — the same string in every attendee's copy of the meeting,
   * and the only cross-mailbox identity a meeting has. Optional because not
   * every provider or response carries it; consumers must handle null.
   */
  icalUid?: string | null;
```

- [ ] **Step 8: Run the whole provider + calendar suite**

Run: `cd apps/api && npx jest src/ews src/zimbra src/provider && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS, tsc clean. The memory provider is untouched and leaves `icalUid` unset — that is deliberate.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/provider/provider-types.ts apps/api/src/ews apps/api/src/zimbra
git commit -m "feat(api): providers report the iCalendar UID

A meeting's UID is the same string in every attendee's mailbox, and the only
cross-user identity a meeting has — calendar rows are keyed per mailbox, so
two attendees' copies of one meeting are otherwise unrelated.

EWS gets it for free: calendar:UID is one more field on the two calendar
requests the app already makes. Zimbra reads it off the search hit when that
version sends one, and otherwise off the invite component of the appointment
detail the app already fetches when an event is opened. Optional on the
provider types, so the memory provider simply leaves it unset."
```

---

### Task 2: Store the UID and the minutes link

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_meeting_minutes/migration.sql`
- Modify: `apps/api/src/calendar/calendar.service.ts` (list sync + detail sync)
- **Create: `apps/api/src/calendar/calendar.service.spec.ts`** — this file does NOT exist yet. `CalendarService` has no tests at all today, so this task stands the spec file up and Tasks 3 and 4 extend it. Use the harness in Step 0 verbatim; it is the shared fixture those tasks rely on.

- [ ] **Step 0: Create the spec file and its harness**

`CalendarService`'s constructor is `(prisma: PrismaService, resolver: MailProviderResolver)` today; Task 3 adds `DocsService` as a third argument, so the harness takes it now and Task 3 only has to use it. Follow the `as unknown as PrismaService` fake pattern the mail specs use (`mail.service.spec.ts:25`).

```typescript
import { NotFoundException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { MailProviderResolver } from '../provider/mail-provider.resolver';
import { DocsService } from '../docs/docs.service';

/** `provider` is what MailProviderResolver.forUser reads — the DB always
 *  carries it, so the fixture must too or the resolver rejects the user. */
export const USER = {
  id: 'u1', email: 'me@risa.gov.rw', authToken: 'tok',
  tokenExpiry: new Date(Date.now() + 60_000), provider: 'zimbra',
};

export const zimbraStub = {
  getCalendarEvents: jest.fn(),
  getAppointment: jest.fn(),
};

export function makeService() {
  jest.clearAllMocks();
  const prisma = {
    user: { findUnique: jest.fn() },
    calendarEvent: {
      findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ id: 'e1' }), update: jest.fn(),
    },
    meetingMinutes: { findUnique: jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const docs = { createMinutesDocument: jest.fn() } as unknown as DocsService;
  const service = new CalendarService(
    prisma,
    new MailProviderResolver(zimbraStub as unknown as ZimbraService),
    docs,
  );
  return { service, prisma: prisma as any, docs: docs as any };
}
```

Run `cd apps/api && npx jest src/calendar/calendar.service.spec.ts` — it passes with no tests in it yet, which confirms the harness compiles before any behaviour depends on it.

**Interfaces:**
- Consumes: `ProviderEvent.icalUid`, `ProviderEventDetail.icalUid` (Task 1).
- Produces: `CalendarEvent.icalUid`; the `MeetingMinutes` model with `@@unique([icalUid, occurrenceStartAt])`, which Tasks 3 and 4 read and write.

- [ ] **Step 1: Write the failing persistence tests**

Add to `apps/api/src/calendar/calendar.service.spec.ts`:

```typescript
describe('CalendarService icalUid persistence', () => {
  it('stores the UID from a list sync', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    zimbraStub.getCalendarEvents.mockResolvedValue([
      { id: 'z-1', title: 'Cabinet briefing', startAt: new Date('2026-09-17T09:00:00Z'),
        endAt: new Date('2026-09-17T10:00:00Z'), allDay: false, attendees: [],
        inviteId: null, isRecurring: false, icalUid: 'cabinet@zimbra' },
    ]);

    await service.getEvents('u1', Date.parse('2026-09-01'), Date.parse('2026-09-30'));

    expect(prisma.calendarEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ icalUid: 'cabinet@zimbra' }),
        update: expect.objectContaining({ icalUid: 'cabinet@zimbra' }),
      }),
    );
  });

  it('fills the UID from the detail fetch when the list did not carry one', async () => {
    // This is the Zimbra fallback path: some versions omit uid on search but
    // always carry it on the appointment detail.
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({ id: 'e1', zimbraId: 'z-1', icalUid: null });
    zimbraStub.getAppointment.mockResolvedValue({
      id: 'z-1', attendees: [{ email: 'a@risa.gov.rw' }],
      organizer: { email: 'chair@risa.gov.rw' }, icalUid: 'cabinet@zimbra',
    });

    await service.getEvent('u1', 'e1');

    expect(prisma.calendarEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ icalUid: 'cabinet@zimbra' }) }),
    );
  });

  it('does not overwrite a stored UID with null when the detail omits it', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({ id: 'e1', zimbraId: 'z-1', icalUid: 'kept@zimbra' });
    zimbraStub.getAppointment.mockResolvedValue({ id: 'z-1', attendees: [], organizer: null });

    await service.getEvent('u1', 'e1');

    const data = prisma.calendarEvent.update.mock.calls[0][0].data;
    expect(data.icalUid).toBeUndefined();   // undefined means "leave unchanged" in Prisma
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx jest src/calendar/calendar.service.spec.ts -t "icalUid persistence"`
Expected: FAIL — no `icalUid` appears in either the upsert or the update.

- [ ] **Step 3: Add the schema and the migration**

In `apps/api/prisma/schema.prisma`, add the field to `CalendarEvent`:

```prisma
  /// iCalendar UID — the same string in every attendee's copy of this meeting.
  /// Null when the provider did not supply one (see the meeting-minutes spec).
  icalUid         String?
```

and the link model:

```prisma
/// Links one meeting OCCURRENCE to the single document that is its minutes.
/// Keyed by the iCalendar UID plus the occurrence's start, because a UID is
/// shared by every occurrence of a recurring series and weekly meetings have
/// weekly minutes.
model MeetingMinutes {
  id                String   @id @default(cuid())
  icalUid           String
  occurrenceStartAt DateTime
  documentId        String
  createdBy         String
  createdAt         DateTime @default(now())

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  creator  User     @relation(fields: [createdBy], references: [id], onDelete: Cascade)

  @@unique([icalUid, occurrenceStartAt])
  @@index([documentId])
  @@map("meeting_minutes")
}
```

Add the back-relations: `meetingMinutes MeetingMinutes[]` on both `Document` and `User`.

Then generate the migration:

```bash
cd apps/api && npx prisma migrate dev --name add_meeting_minutes
```

- [ ] **Step 4: Persist the UID in both sync paths**

In `calendar.service.ts`'s list sync, add `icalUid: ev.icalUid ?? null` to **both** the `create` and `update` halves of the `calendarEvent.upsert`.

In the detail sync, only write it when the detail actually carried one, so a detail response without a UID cannot erase a stored one:

```typescript
        // `undefined` means "leave unchanged" in Prisma; null would erase a UID
        // the list sync had already stored.
        ...(detail.icalUid ? { icalUid: detail.icalUid } : {}),
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd apps/api && npx jest src/calendar && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/src/calendar
git commit -m "feat(api): store the meeting UID and add the minutes link table

CalendarEvent gains icalUid, written by both sync paths — and the detail sync
writes it only when the detail carried one, because in Prisma undefined means
'leave unchanged' while null would erase a UID the list sync already stored.

MeetingMinutes links one meeting OCCURRENCE to one document, keyed
(icalUid, occurrenceStartAt). The occurrence is in the key because a UID is
shared by every instance of a recurring series, and weekly meetings have
weekly minutes. The document relation cascades, so deleting the minutes
returns the event to offering creation rather than leaving a dead button."
```

---

### Task 3: Create the minutes

**Files:**
- Modify: `apps/api/src/docs/docs.service.ts` (the transaction)
- Create: `apps/api/src/calendar/dto/create-minutes.dto.ts`
- Modify: `apps/api/src/calendar/calendar.service.ts` (resolve + delegate)
- Modify: `apps/api/src/calendar/calendar.controller.ts` (the route)
- Modify: `apps/api/src/calendar/calendar.module.ts` (import `DocsModule`)
- **Create: `apps/api/src/docs/docs.service.spec.ts`** — this file does NOT exist yet; `DocsService` has no tests today. The `makeService` helper in Step 1 is self-contained, so create the file with it. Import `DocsService` from `./docs.service` and `PrismaService` from `../prisma/prisma.service`.
- Modify: `apps/api/src/calendar/calendar.service.spec.ts` (created in Task 2 — reuse its exported `makeService`, `USER` and `zimbraStub`)

**Interfaces:**
- Consumes: `MeetingMinutes` and `CalendarEvent.icalUid` (Task 2).
- Produces:
  - `DocsService.createMinutesDocument(userId: string, input: { title: string; content: string; attendeeEmails: string[]; icalUid: string | null; occurrenceStartAt: Date }): Promise<{ documentId: string; linked: boolean }>`
  - `CalendarService.createMinutes(userId: string, eventId: string, dto: CreateMinutesDto): Promise<{ documentId: string; linked: boolean }>`
  - Route `POST /calendar/events/:id/minutes`, body `{ title, content }`.

- [ ] **Step 1: Write the failing DocsService tests**

Add to `apps/api/src/docs/docs.service.spec.ts`:

```typescript
describe('DocsService.createMinutesDocument', () => {
  const INPUT = {
    title: 'Minutes — Cabinet briefing',
    content: '{"type":"doc","content":[]}',
    attendeeEmails: ['Chair@risa.gov.rw', 'a@risa.gov.rw', 'a@risa.gov.rw', '', 'me@risa.gov.rw'],
    icalUid: 'cabinet@zimbra',
    occurrenceStartAt: new Date('2026-09-17T09:00:00Z'),
  };

  function makeService(existingLink: any = null) {
    const tx = {
      document: { create: jest.fn().mockResolvedValue({ id: 'doc-1' }), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
      documentInvite: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      meetingMinutes: { create: jest.fn().mockResolvedValue({ id: 'link-1' }) },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw' }) },
      meetingMinutes: { findUnique: jest.fn().mockResolvedValue(existingLink) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    } as unknown as PrismaService;
    return { service: new DocsService(prisma as any, {} as any), prisma: prisma as any, tx };
  }

  it('creates the document, the invites, the share link and the link row', async () => {
    const { service, tx } = makeService();

    const result = await service.createMinutesDocument('u1', INPUT);

    expect(result).toEqual({ documentId: 'doc-1', linked: true });
    expect(tx.document.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        userId: 'u1', title: INPUT.title, content: INPUT.content,
        isShared: true, sharePermission: 'VIEW',
      }) }),
    );
    expect(tx.document.create.mock.calls[0][0].data.shareToken).toBeTruthy();
    expect(tx.meetingMinutes.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        icalUid: 'cabinet@zimbra', occurrenceStartAt: INPUT.occurrenceStartAt,
        documentId: 'doc-1', createdBy: 'u1',
      }) }),
    );
  });

  it('invites each attendee once, lowercased, and never the caller', async () => {
    const { service, tx } = makeService();

    await service.createMinutesDocument('u1', INPUT);

    expect(tx.documentInvite.createMany).toHaveBeenCalledWith({
      data: [
        { documentId: 'doc-1', invitedEmail: 'chair@risa.gov.rw', invitedBy: 'u1', role: 'EDITOR' },
        { documentId: 'doc-1', invitedEmail: 'a@risa.gov.rw', invitedBy: 'u1', role: 'EDITOR' },
      ],
      skipDuplicates: true,
    });
  });

  it('returns the existing document when this occurrence already has minutes', async () => {
    // Idempotent by the unique key, not by check-then-act: two attendees
    // clicking at the same moment must land on the same document.
    const { service, prisma, tx } = makeService({ documentId: 'doc-existing' });

    const result = await service.createMinutesDocument('u1', INPUT);

    expect(result).toEqual({ documentId: 'doc-existing', linked: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.document.create).not.toHaveBeenCalled();
  });

  it('creates an UNLINKED document when the meeting has no UID', async () => {
    const { service, tx } = makeService();

    const result = await service.createMinutesDocument('u1', { ...INPUT, icalUid: null });

    expect(result).toEqual({ documentId: 'doc-1', linked: false });
    expect(tx.meetingMinutes.create).not.toHaveBeenCalled();
    expect(tx.document.create).toHaveBeenCalled();   // the minutes still exist
  });

  it('writes every row on the TRANSACTION client, not the ambient one', async () => {
    // A fake that hands back `prisma` itself would prove only that the writes
    // happened during the transaction window. This asserts they ran ON it.
    const { service, prisma, tx } = makeService();

    await service.createMinutesDocument('u1', INPUT);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.document.create).toHaveBeenCalled();
    expect(tx.documentInvite.createMany).toHaveBeenCalled();
    expect(tx.meetingMinutes.create).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx jest src/docs/docs.service.spec.ts -t "createMinutesDocument"`
Expected: FAIL — `service.createMinutesDocument is not a function`.

- [ ] **Step 3: Implement the transaction**

In `docs.service.ts`:

```typescript
  /**
   * Create the minutes document for one meeting occurrence: the document, an
   * EDITOR invite per attendee, the read-only share link, and the link row —
   * all in ONE transaction, so a failure leaves nothing half-made.
   *
   * Idempotent by the link table's unique key rather than by checking first:
   * two attendees clicking at the same moment must land on the same document.
   *
   * The transaction is deliberately small. Content arrives already composed by
   * the caller, nothing inside it talks to a mail provider, and the invites go
   * in as one `createMany` — an interactive transaction holds a pooled
   * connection, and at 5,000 mailboxes that is a load-correlated failure.
   */
  async createMinutesDocument(
    userId: string,
    input: {
      title: string;
      content: string;
      attendeeEmails: string[];
      icalUid: string | null;
      occurrenceStartAt: Date;
    },
  ): Promise<{ documentId: string; linked: boolean }> {
    if (input.icalUid) {
      const existing = await this.prisma.meetingMinutes.findUnique({
        where: {
          icalUid_occurrenceStartAt: {
            icalUid: input.icalUid,
            occurrenceStartAt: input.occurrenceStartAt,
          },
        },
        select: { documentId: true },
      });
      if (existing) return { documentId: existing.documentId, linked: true };
    }

    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const mine = (me?.email ?? '').trim().toLowerCase();

    // Lowercase, drop blanks, drop the caller (they own it), and dedupe while
    // preserving the order the organizer listed people in.
    const invitees = [...new Set(
      input.attendeeEmails
        .map((e) => (e ?? '').trim().toLowerCase())
        .filter((e) => e.length > 0 && e !== mine),
    )];

    return this.prisma.$transaction(async (tx) => {
      const last = await tx.document.findFirst({
        where: { userId, parentId: null },
        orderBy: { position: 'desc' },
        select: { position: true },
      });

      const doc = await tx.document.create({
        data: {
          userId,
          title: input.title,
          content: input.content,
          emoji: '📝',
          parentId: null,
          position: (last?.position ?? -1) + 1,
          // Sharing is on from the start: being sent the minutes is the whole
          // point, and VIEW keeps a forwarded link from rewriting the record.
          isShared: true,
          shareToken: shortToken(),
          sharePermission: 'VIEW',
        },
        select: { id: true },
      });

      if (invitees.length) {
        await tx.documentInvite.createMany({
          data: invitees.map((invitedEmail) => ({
            documentId: doc.id,
            invitedEmail,
            invitedBy: userId,
            role: 'EDITOR' as const,
          })),
          skipDuplicates: true,
        });
      }

      if (input.icalUid) {
        await tx.meetingMinutes.create({
          data: {
            icalUid: input.icalUid,
            occurrenceStartAt: input.occurrenceStartAt,
            documentId: doc.id,
            createdBy: userId,
          },
        });
      }

      return { documentId: doc.id, linked: !!input.icalUid };
    });
  }
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/api && npx jest src/docs/docs.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing CalendarService + route tests**

Add to `apps/api/src/calendar/calendar.service.spec.ts`:

```typescript
describe('CalendarService.createMinutes', () => {
  const DTO = { title: 'Minutes — Cabinet briefing', content: '{"type":"doc","content":[]}' };

  it('delegates with the event\'s attendees, UID and its own start as the occurrence', async () => {
    const { service, prisma, docs } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', userId: 'u1', icalUid: 'cabinet@zimbra',
      startAt: new Date('2026-09-17T09:00:00Z'),
      attendees: ['a@risa.gov.rw', 'b@risa.gov.rw'],
    });
    docs.createMinutesDocument.mockResolvedValue({ documentId: 'doc-1', linked: true });

    const result = await service.createMinutes('u1', 'e1', DTO);

    expect(result).toEqual({ documentId: 'doc-1', linked: true });
    expect(docs.createMinutesDocument).toHaveBeenCalledWith('u1', {
      title: DTO.title,
      content: DTO.content,
      attendeeEmails: ['a@risa.gov.rw', 'b@risa.gov.rw'],
      icalUid: 'cabinet@zimbra',
      occurrenceStartAt: new Date('2026-09-17T09:00:00Z'),
    });
  });

  it('refuses an event that is not the caller\'s', async () => {
    const { service, prisma, docs } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue(null);

    await expect(service.createMinutes('u1', 'someone-elses', DTO)).rejects.toBeInstanceOf(NotFoundException);
    expect(docs.createMinutesDocument).not.toHaveBeenCalled();
  });
});
```

Create `apps/api/src/calendar/calendar.controller.spec.ts` — it does not exist. `CalendarController`'s constructor takes only `(calendarService: CalendarService)`, so the harness is one fake:

```typescript
describe('CalendarController.createMinutes', () => {
  it('passes the caller, the event and the body straight through', async () => {
    const calendarService = {
      createMinutes: jest.fn().mockResolvedValue({ documentId: 'doc-1', linked: true }),
    } as unknown as CalendarService;
    const controller = new CalendarController(calendarService);

    const body = { title: 'Minutes', content: '{}' };
    const result = await controller.createMinutes({ user: { sub: 'u1' } } as any, 'e1', body as any);

    expect(calendarService.createMinutes).toHaveBeenCalledWith('u1', 'e1', body);
    expect(result).toEqual({ documentId: 'doc-1', linked: true });
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/api && npx jest src/calendar -t "createMinutes"`
Expected: FAIL — neither method exists.

- [ ] **Step 7: Implement the DTO, the service method and the route**

Create `apps/api/src/calendar/dto/create-minutes.dto.ts`:

```typescript
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateMinutesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  /** TipTap document JSON, composed by the client from the Meeting Minutes
   *  template. The API stores it verbatim and never parses it. */
  @IsString()
  @MinLength(2)
  content!: string;
}
```

In `calendar.service.ts`, add `DocsService` as the **third** constructor argument (`private readonly docs: DocsService`) — Task 2's test harness already passes it — and add:

```typescript
  /**
   * Create the minutes for one event. The caller must own the event row; the
   * occurrence is the row's own `startAt`, because both providers expand a
   * recurring series into one row per instance.
   */
  async createMinutes(userId: string, eventId: string, dto: CreateMinutesDto) {
    const event = await this.prisma.calendarEvent.findFirst({
      where: { id: eventId, userId },
      select: { icalUid: true, startAt: true, attendees: true },
    });
    if (!event) throw new NotFoundException('Event not found');

    return this.docs.createMinutesDocument(userId, {
      title: dto.title,
      content: dto.content,
      attendeeEmails: ((event.attendees as unknown as string[]) ?? []),
      icalUid: event.icalUid,
      occurrenceStartAt: event.startAt,
    });
  }
```

In `calendar.controller.ts`, beside the RSVP route:

```typescript
  /** Create (or open) the minutes document for this event's occurrence. */
  @Post('events/:id/minutes')
  @HttpCode(HttpStatus.OK)
  createMinutes(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateMinutesDto,
  ) {
    return this.calendarService.createMinutes(req.user.sub, id, dto);
  }
```

In `calendar.module.ts`, add `DocsModule` to `imports`.

- [ ] **Step 8: Run the full api suite**

Run: `cd apps/api && npx jest && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS, tsc clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/docs apps/api/src/calendar
git commit -m "feat(api): create a meeting's minutes from its calendar event

POST /calendar/events/:id/minutes creates the document, an EDITOR invite per
attendee, the read-only share link and the occurrence link row — in one
transaction, so nothing half-made survives a failure.

Idempotent by the link table's unique key rather than by checking first: two
attendees clicking at the same moment land on the same document. An event with
no UID still gets minutes, unlinked, and the response says so.

Document writes stay in DocsService, which owns them; CalendarService resolves
and validates the event and delegates. The transaction is deliberately small —
content arrives composed, no provider calls inside, invites in one createMany."
```

---

### Task 4: The event knows whether its minutes exist

**Files:**
- Modify: `apps/api/src/calendar/calendar.service.ts` (`getEvent`)
- Modify: `apps/api/src/calendar/calendar.service.spec.ts` (reuse Task 2's exported `makeService`, `USER` and `zimbraStub`; its prisma fake already carries a `meetingMinutes.findUnique` mock)

**Interfaces:**
- Produces: `minutesDocumentId: string | null` on the event-detail response, which Task 5's drawer reads.

- [ ] **Step 1: Write the failing test**

```typescript
describe('CalendarService.getEvent minutes link', () => {
  it('reports the minutes document for this occurrence', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', zimbraId: 'z-1', icalUid: 'cabinet@zimbra',
      startAt: new Date('2026-09-17T09:00:00Z'), attendees: [],
    });
    zimbraStub.getAppointment.mockResolvedValue({ id: 'z-1', attendees: [], organizer: null });
    prisma.calendarEvent.update.mockResolvedValue({ id: 'e1', startAt: new Date('2026-09-17T09:00:00Z') });
    prisma.meetingMinutes.findUnique.mockResolvedValue({ documentId: 'doc-1' });

    const event: any = await service.getEvent('u1', 'e1');

    expect(event.minutesDocumentId).toBe('doc-1');
  });

  it('reports null when this occurrence has no minutes', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', zimbraId: 'z-1', icalUid: 'cabinet@zimbra',
      startAt: new Date('2026-09-17T09:00:00Z'), attendees: [],
    });
    zimbraStub.getAppointment.mockResolvedValue({ id: 'z-1', attendees: [], organizer: null });
    prisma.calendarEvent.update.mockResolvedValue({ id: 'e1', startAt: new Date('2026-09-17T09:00:00Z') });
    prisma.meetingMinutes.findUnique.mockResolvedValue(null);

    const event: any = await service.getEvent('u1', 'e1');

    expect(event.minutesDocumentId).toBeNull();
  });

  it('reports null without querying when the event has no UID', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      id: 'e1', zimbraId: 'z-1', icalUid: null,
      startAt: new Date('2026-09-17T09:00:00Z'), attendees: [],
    });
    zimbraStub.getAppointment.mockResolvedValue({ id: 'z-1', attendees: [], organizer: null });
    prisma.calendarEvent.update.mockResolvedValue({ id: 'e1', startAt: new Date('2026-09-17T09:00:00Z') });

    const event: any = await service.getEvent('u1', 'e1');

    expect(event.minutesDocumentId).toBeNull();
    expect(prisma.meetingMinutes.findUnique).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx jest src/calendar/calendar.service.spec.ts -t "minutes link"`
Expected: FAIL — `minutesDocumentId` is undefined.

- [ ] **Step 3: Resolve the link in getEvent**

At the end of `getEvent`, after the row is refreshed:

```typescript
    // The drawer needs this to choose between "Create minutes" and "Open
    // minutes", so it rides the detail response rather than costing a request.
    const minutesDocumentId = updated.icalUid
      ? (await this.prisma.meetingMinutes.findUnique({
          where: {
            icalUid_occurrenceStartAt: {
              icalUid: updated.icalUid,
              occurrenceStartAt: updated.startAt,
            },
          },
          select: { documentId: true },
        }))?.documentId ?? null
      : null;

    return { ...updated, minutesDocumentId };
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/api && npx jest src/calendar && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/calendar
git commit -m "feat(api): event detail reports its minutes document

The drawer chooses between 'Create minutes' and 'Open minutes' from this, so
it rides the detail response the drawer already fetches rather than costing an
extra request. No UID means no query and a null answer."
```

---

### Task 5: The button in the event drawer

**Files:**
- Create: `apps/web/lib/calendar/minutesPrefill.ts`
- Test: `apps/web/lib/calendar/minutesPrefill.test.ts`
- Modify: `apps/web/lib/api.ts` (`api.calendar.createMinutes`)
- Modify: `apps/web/app/(app)/calendar/page.tsx` (the drawer button)

**Interfaces:**
- Consumes: `POST /calendar/events/:id/minutes` returning `{ documentId, linked }` (Task 3); `minutesDocumentId` on event detail (Task 4).
- Produces: `minutesPrefill(event): { title: string; content: string }`.

- [ ] **Step 1: Write the failing prefill test**

```typescript
import { describe, it, expect } from 'vitest';
import { minutesPrefill } from './minutesPrefill';

const EVENT = {
  title: 'Cabinet briefing',
  startAt: '2026-09-17T09:00:00.000Z',
  location: 'Room 3',
  organizer: 'chair@risa.gov.rw',
  attendees: ['a@risa.gov.rw', 'b@risa.gov.rw'],
};

describe('minutesPrefill', () => {
  it('names the document after the meeting', () => {
    expect(minutesPrefill(EVENT).title).toBe('Minutes — Cabinet briefing');
  });

  it('fills the template placeholders from the event', () => {
    const { content } = minutesPrefill(EVENT);
    expect(content).toContain('Cabinet briefing');
    expect(content).toContain('Room 3');
    expect(content).toContain('chair@risa.gov.rw');
    expect(content).toContain('a@risa.gov.rw');
    expect(content).toContain('b@risa.gov.rw');
    // the template's own placeholder text must not survive into a real document
    expect(content).not.toContain('[Title of Meeting]');
    expect(content).not.toContain('[Venue or Video Conference Link]');
  });

  it('is valid TipTap JSON', () => {
    const parsed = JSON.parse(minutesPrefill(EVENT).content);
    expect(parsed.type).toBe('doc');
    expect(Array.isArray(parsed.content)).toBe(true);
  });

  it('survives an event with no location, organizer or attendees', () => {
    const bare = minutesPrefill({ title: 'Standup', startAt: EVENT.startAt });
    expect(bare.title).toBe('Minutes — Standup');
    expect(() => JSON.parse(bare.content)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run lib/calendar/minutesPrefill.test.ts`
Expected: FAIL — cannot resolve `./minutesPrefill`.

- [ ] **Step 3: Implement the prefill**

```typescript
import { TEMPLATES } from '@/lib/docs/templates';

export interface MinutesPrefillEvent {
  title: string;
  startAt: string;
  location?: string | null;
  organizer?: string | null;
  attendees?: string[];
}

/**
 * Build the minutes document for a meeting from the Meeting Minutes template,
 * with the event's own facts in place of the template's placeholders.
 *
 * The template lives in the web app next to the editor that renders it, so the
 * API never has to know about TipTap — it stores what it is given.
 */
export function minutesPrefill(event: MinutesPrefillEvent): { title: string; content: string } {
  const template = TEMPLATES.find((t) => t.id === 'minutes');
  if (!template) throw new Error('The Meeting Minutes template is missing');

  const when = new Date(event.startAt).toLocaleString('en-GB', {
    dateStyle: 'full', timeStyle: 'short',
  });
  const attendees = (event.attendees ?? []).filter((a) => a && a.trim().length > 0);

  // Replace the template's bracketed placeholders with what the event knows.
  // Anything the event cannot answer keeps its placeholder, so the person
  // writing the minutes can see what still needs filling in.
  const replacements: Array<[string, string]> = [
    ['[Title of Meeting]', event.title],
    ['[Date and Time]', when],
    ['[Venue or Video Conference Link]', event.location?.trim() || 'Not recorded'],
    ['[Name]', event.organizer?.trim() || '[Name]'],
  ];

  let json = JSON.stringify(template.content);
  for (const [from, to] of replacements) {
    json = json.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
  }

  const doc = JSON.parse(json);

  // The attendee bullet list is the one place the template's two sample
  // bullets are replaced wholesale rather than patched.
  if (attendees.length) {
    const list = doc.content?.find(
      (n: any) => n.type === 'bulletList',
    );
    if (list) {
      list.content = attendees.map((email) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: email }] }],
      }));
    }
  }

  return { title: `Minutes — ${event.title}`, content: JSON.stringify(doc) };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run lib/calendar/minutesPrefill.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the API client method**

In `apps/web/lib/api.ts`, inside the `calendar` namespace:

```typescript
    /** Create (or open) the minutes document for this event's occurrence.
     *  `linked: false` means the meeting had no iCalendar UID, so this
     *  document is not the canonical record for other attendees. */
    createMinutes: (eventId: string, body: { title: string; content: string }) => {
      if (USE_MOCK) return delay({ documentId: 'mock-doc', linked: true });
      return request<{ documentId: string; linked: boolean }>(
        `/calendar/events/${eventId}/minutes`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
```

- [ ] **Step 6: Wire the drawer button**

In `apps/web/app/(app)/calendar/page.tsx`, in the event detail drawer, beside the existing actions:

```tsx
            {selectedEvent?.minutesDocumentId ? (
              <button
                onClick={() => router.push(`/docs?doc=${selectedEvent.minutesDocumentId}`)}
                className="flex items-center gap-1.5 text-ui text-primary hover:underline"
              >
                <ScrollText className="w-3.5 h-3.5" />
                Open minutes
              </button>
            ) : (
              <button
                onClick={async () => {
                  if (!selectedEvent) return;
                  try {
                    const { documentId, linked } = await api.calendar.createMinutes(
                      selectedEvent.id,
                      minutesPrefill({
                        title: selectedEvent.title,
                        startAt: selectedEvent.startAt,
                        location: selectedEvent.location,
                        organizer: selectedEvent.organizer ?? null,
                        attendees: (selectedEvent.attendees ?? []).map((a: any) => a?.email ?? a),
                      }),
                    );
                    toast.success(
                      linked
                        ? 'Minutes created and shared with the attendees'
                        : 'Minutes created — this meeting has no shared id, so attendees will need the link',
                    );
                    router.push(`/docs?doc=${documentId}`);
                  } catch (err: any) {
                    toast.error('Could not create the minutes', { description: err?.message });
                  }
                }}
                className="flex items-center gap-1.5 text-ui text-ink-2 hover:text-foreground"
              >
                <ScrollText className="w-3.5 h-3.5" />
                Create minutes
              </button>
            )}
```

**Read the detail off `selectedEvent`, not a separate variable.** The page merges
the fetched detail into it (`setSelectedEvent((prev) => ({ ...prev, ...full }))`
at `calendar/page.tsx:2087`), so there is no `selectedEventDetail` — the
organizer, the enriched attendees and `minutesDocumentId` all arrive on
`selectedEvent` itself.

Add `minutesDocumentId?: string | null;` to the `CalEvent` interface at the top
of `calendar/page.tsx`, or tsc will reject the property access.

Import `minutesPrefill` from `@/lib/calendar/minutesPrefill` and `ScrollText` from `lucide-react` if it is not already imported.

- [ ] **Step 7: Run the full web suite**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/calendar/minutesPrefill.ts apps/web/lib/calendar/minutesPrefill.test.ts \
        apps/web/lib/api.ts apps/web/app/\(app\)/calendar/page.tsx
git commit -m "feat(web): create or open a meeting's minutes from the event drawer

The button reads 'Create minutes' or 'Open minutes' from the minutesDocumentId
the detail response now carries, so it costs no extra request.

Creating composes the document from the existing Meeting Minutes template with
the event's own title, date, location, chair and attendee list in place of the
placeholders — anything the event cannot answer keeps its placeholder, so the
person writing the minutes can see what still needs filling in. The prefill is
a pure function, tested on its own; the button is thin."
```

---

## After the last task

- [ ] **Verify the Zimbra UID against the live server.** This is the one open question in the spec (§5.2): Zimbra's search response may not carry `uid`, and the code does not currently look. On `.154`, with a RISA account, open an event and confirm `calendar_events.icalUid` is populated — from the list sync if Zimbra sends it there, from the detail sync otherwise. If neither path fills it, minutes still work but fall back to unlinked, which is the documented degradation rather than a bug.
- [ ] Deploy api + web to `.154` and `.155`. This task **has a migration** (`add_meeting_minutes`), unlike the notifications work — run `prisma migrate deploy` with `api.env` sourced and confirm it applies cleanly as the next migration in the history.
- [ ] Live check with two accounts: create minutes as one attendee, confirm the document appears under Docs → Shared with me for a second attendee, and that the second attendee's event drawer now says "Open minutes" and opens the same document.
- [ ] Live check the share link: open the document's share URL in a logged-out browser and confirm it is readable and not editable.
- [ ] Release note: minutes are canonical only among 1Gov Mail users; an event with no iCalendar UID falls back to per-user minutes; attendees added after creation are not invited automatically; deleting a meeting leaves its minutes behind.
