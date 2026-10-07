# Shareable email groups — design

**Date:** 2026-09-28
**Status:** design approved in chat 2026-09-28; awaiting spec review
**Branch:** ft-hyperscale

## 1. Why

A user who mails the same set of people on a schedule — a twice-daily circulation
to a team — has two options today: select every recipient by hand each time, or
ask the mail admin to create a distribution list for them. Both are wrong. The
first is tedious and error-prone; the second puts a human gatekeeper in front of
a thing the user should own.

The user should be able to build the group once, use it in a click, and share it
with the colleagues who also need it.

## 2. What already exists

Unusually much — the store and its management UI shipped some time ago and are
live on both VMs. What was never built is anything that *consumes* a group.

| Piece | State |
|---|---|
| `ContactGroup` table — `userId`, `name`, `description`, `members Json` | exists — `schema.prisma:577`, live via `0001_init` on both boxes |
| `GET/POST/PATCH/DELETE /contacts/groups` | exists — `contacts.controller.ts:81-116` |
| `getGroups` / `createGroup` / `updateGroup` / `deleteGroup` | exists — `contacts.service.ts:349-387` |
| `api.contacts.groups.*` client methods | exists — `api.ts:142-157` |
| Groups tab in Contacts — create, name, add/remove members | exists — `app/(app)/contacts/page.tsx` |
| Any way to share a group | **does not exist** — groups are single-owner, no ACL of any kind |
| Groups in recipient autocomplete | **does not exist** — `autocomplete()` merges personal contacts + GAL + mail history only |
| Any group awareness in compose | **does not exist** — zero occurrences of "group" in `ComposeModal.tsx`, `EmailChipInput.tsx`, `EmailAutocompleteInput.tsx` |
| "Email this group" action | **does not exist** — the Contacts compose button routes to a blank `/mail` (`page.tsx:444`) |

**Net effect today:** you create the group, then still pick all twelve people by
hand. The group is a dead end.

### 2.1 Why we are not reusing the institution

`User.institutionId` (`schema.prisma:27`) is a bare nullable `String?` — no
foreign key, no relation, no index. It is written at login to resolve
provider/host (`auth.service.ts:119`) and **nothing else in the API reads it**.
"Everyone in my institution" is therefore not a queryable set, which is why
institution-wide distribution lists are explicitly out of scope (§3).

There is also no role or admin concept anywhere in the codebase. The only `role`
is `InviteRole { VIEWER, EDITOR }` scoped to a single document
(`schema.prisma:699`), plus `ChatMessage.role`.

## 3. Decisions taken

| Question | Decision |
|---|---|
| Ownership | Personal groups, plus sharing |
| Share model | Invite **named colleagues by email**. Mirrors document sharing exactly. |
| Institution-wide lists | **Out of scope.** §2.1 — `institutionId` is not a real relation, and there is no admin role to gate who may publish an all-staff list. |
| Roles | `VIEWER` = may see and send to the group. `EDITOR` = may also change its members. Owner alone may share and delete. |
| Data approach | A dedicated `GroupInvite` table + the `OR` ACL query already proven in `docs.service.ts:1006`. **Rejected:** packing ACL into the `members` JSON — unindexable, no clean role enforcement, and a second access model to keep correct. |
| Compose behaviour | Selecting a group **expands to individual, editable recipient chips**. **Rejected:** a single chip expanded server-side at send — the user cannot drop one person for one mail, and the sent copy would not match what they typed. |
| Invite notification | **None in v1.** A shared group simply appears in the invitee's Groups tab. Assumed default — flagged in §10. |
| Group size in compose | Expand up to **50 chips**; beyond that collapse the remainder into a `+N more` chip. Assumed default — flagged in §10. |

`VIEWER` is the default role for a new invite, unlike `DocumentInvite` which
defaults to `EDITOR`. Sharing a circulation list should not hand over the power
to rewrite who receives it.

## 4. Data model

Additive only. Existing personal groups are untouched and simply have no invites.

### 4.1 New: `GroupInvite`

A near-copy of `DocumentInvite` (`schema.prisma:704`).

```prisma
model GroupInvite {
  id           String     @id @default(cuid())
  groupId      String
  invitedEmail String
  invitedBy    String
  role         InviteRole @default(VIEWER)
  createdAt    DateTime   @default(now())

  group   ContactGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  inviter User         @relation(fields: [invitedBy], references: [id], onDelete: Cascade)

  @@unique([groupId, invitedEmail])
  @@index([invitedEmail])
  @@map("group_invites")
}
```

`@@unique([groupId, invitedEmail])` makes re-inviting the same person idempotent
rather than an error. `onDelete: Cascade` on both relations means deleting a
group or a user cleans up its invites.

### 4.2 Changed: `ContactGroup` and `User`

`ContactGroup` gains `invites GroupInvite[]`. `User` gains
`sentGroupInvites GroupInvite[]` to satisfy the back-relation, alongside the
existing `contactGroups` and `sentInvites`.

`members` keeps its current shape and meaning: `[{ email, name }]`.

> **`members` and `invites` are two different lists.** `members` is where the
> mail goes. `invites` is who may use the group. A person can be in one, both,
> or neither. Nothing about being a member grants access to the group.

### 4.3 Migration

`cd apps/api && npx prisma migrate dev --name group_invites`

The dev DB has drifted, so the migration is hand-authored against the drifted
schema following the workflow already used for the agent-tool and minutes work,
then applied normally on the VMs.

## 5. Sharing and access

### 5.1 The read query

Copied from the shape guarding shared documents (`docs.service.ts:1006`), so we
are not introducing a second access model.

```ts
// contacts.service.ts — getGroups(userId)
const email = await this.getUserEmail(userId);
return this.prisma.contactGroup.findMany({
  where: {
    OR: [
      { userId },                                        // groups I own
      { invites: { some: { invitedEmail: email } } },    // groups shared with me
    ],
  },
  include: { invites: true },
  orderBy: { updatedAt: 'desc' },
});
```

**`getUserEmail` must be a new lightweight lookup, not the existing
`getUser`.** `getUser` throws `UnauthorizedException` when `authToken` is null
(`contacts.service.ts`), which is correct for provider calls but wrong here —
listing groups is a local database read and must keep working for a user whose
Zimbra token has expired. `getUserEmail` selects `{ email }` and throws only
`NotFoundException`.

Email comparison is case-insensitive and normalised (trim + lowercase) on both
write and read, matching how addresses are handled elsewhere in the mail paths.

### 5.2 Access matrix

| Action | Owner | EDITOR invitee | VIEWER invitee | Everyone else |
|---|---|---|---|---|
| See group, send to it | yes | yes | yes | no |
| Edit name, description, members | yes | yes | no | no |
| Invite and revoke | yes | no | no | no |
| Delete group | yes | no | no | no |

Every write path re-checks the caller's role server-side before mutating. The
client hiding a button is convenience, never the guard. A caller with no access
gets `NotFoundException`, not `ForbiddenException` — a stranger must not be able
to probe whether a group id exists.

## 6. Compose flow

Groups surface inside the recipient dropdown that already exists, so there is no
new place to learn. Selecting a group replaces itself with its members as
ordinary chips.

### 6.1 The shared-hook constraint

`useContactSuggestions` has two consumers:

| Consumer | Field | Groups? |
|---|---|---|
| `EmailChipInput` | compose To/Cc/Bcc — multi-value | **yes** |
| `EmailAutocompleteInput` | Advanced Search From/To — single-value (`AdvancedSearchPanel.tsx:156,166`) | **no** |

Searching `from:` a twelve-person group is meaningless, so group suggestions are
**opt-in, not global**:

- `GET /contacts/autocomplete?q=<q>&groups=true` — groups included only on request
- `useContactSuggestions(query, { includeGroups: true })` — default `false`
- Only `EmailChipInput` passes it

This also keeps the group query off the search-panel code path entirely rather
than fetching results it then discards.

### 6.2 Suggestion shape

`ContactSuggestion` gains a discriminant. Existing address suggestions are
unchanged in shape and behaviour:

```ts
export type ContactSuggestion =
  | { kind?: 'contact'; email: string; display: string }
  | { kind: 'group'; groupId: string; display: string; memberCount: number;
      members: Array<{ email: string; name?: string }> };
```

Members ride along on the suggestion so selecting a group needs no second
round-trip. Group matches rank **above** mail-history addresses — a user typing
their group's name wants the group — and the existing 20-result cap applies to
addresses, with groups added on top so a group match is never crowded out.

The hook's existing `exclude` option filters by `email` and therefore applies to
address suggestions only. **Group suggestions are never excluded by chips already
present** — a group stays offered even when some of its members are already
recipients, because selecting it is still useful (it adds the rest). Consumers
narrow on `kind` before reading `email`.

### 6.3 Selection behaviour

On selecting a group suggestion, `EmailChipInput` calls
`onChange([...value, ...newMemberEmails])` rather than appending one address:

- de-duped against chips already present, case-insensitively
- de-duped within the group's own member list
- capped at 50 added chips; the remainder collapses into one non-address `+N more`
  chip that expands on click (§3)
- an empty group adds nothing and shows a toast rather than silently doing nothing

The chips are ordinary, removable recipient chips from that point on. Nothing
about them remembers the group, which is what makes "trim one person for this
one mail" work.

### 6.4 Email this group

The group detail pane in Contacts gets an **Email this group** action that
routes to `/mail` with `initialTo` pre-filled from members. `ComposeModal`
already accepts `initialTo` (`ComposeModal.tsx:102`), so this is wiring, not new
compose behaviour. The same 50-chip cap applies.

## 7. API surface

All under the existing `/contacts` controller. Existing group CRUD keeps its
routes; three share routes are new.

| Method | Route | Purpose | Status |
|---|---|---|---|
| `GET` | `/contacts/groups` | List owned + shared-with-me, with invites | modify — ACL query |
| `POST` | `/contacts/groups` | Create | exists |
| `PATCH` | `/contacts/groups/:id` | Edit — owner or EDITOR | modify — role gate |
| `DELETE` | `/contacts/groups/:id` | Delete — owner only | modify — role gate |
| `GET` | `/contacts/groups/:id/shares` | List invitees | new |
| `POST` | `/contacts/groups/:id/shares` | Invite `{ email, role }` — owner only | new |
| `DELETE` | `/contacts/groups/:id/shares/:inviteId` | Revoke — owner only | new |
| `GET` | `/contacts/autocomplete?q=&groups=` | Now optionally returns groups | modify |

Route ordering matters in Nest: the share routes are multi-segment
(`groups/:id/shares`) so they do not collide with the existing single-segment
`:id` handlers, but they must still be declared inside the existing groups
block to keep the controller readable.

A user cannot invite themselves; a request to do so is rejected. Invites to an
email with no `User` row are allowed and simply resolve if and when that person
signs in — matching how `DocumentInvite` behaves.

## 8. Build plan

Sequenced so each phase is independently testable and leaves the tree shippable.

1. **Schema and migration** — `GroupInvite`, the two back-relations, hand-authored
   migration for the drifted dev DB.
2. **Server: sharing and ACL** — `getUserEmail`, the ACL read query, role checks
   on every write path, the three `/shares` endpoints.
3. **Server: groups in autocomplete** — the `groups=true` flag, group suggestions
   merged and ranked, degrading to address-only on any failure.
4. **Web: expand-on-select** — `includeGroups` option, group rendering in the
   dropdown, expansion with de-dupe and the 50 cap. *The visible payoff.*
5. **Web: sharing UI** — invite panel on the group detail (add email + role, list,
   revoke); edit controls hidden by role.
6. **Web: Email this group** — wire the Contacts compose button to `initialTo`.

Phases 1–3 are server-only and land without user-visible change. Phase 4 is the
first phase a user can feel.

## 9. Testing

TDD throughout, per the usual workflow.

**Server**

- The §5.2 access matrix becomes the test table: owner / EDITOR / VIEWER /
  stranger against read, edit-members, share, delete.
- A stranger hitting a real group id gets `NotFoundException`, not
  `ForbiddenException`.
- Listing groups works when `authToken` is null — the `getUserEmail` regression
  guard for §5.1.
- Autocomplete: a group shared with me appears; a stranger's group never does;
  `groups=true` absent means no groups in the payload; provider failure still
  returns address suggestions.
- Re-inviting the same email is idempotent, not a 500.

**Web**

- Selecting a group adds all members as chips; a member already present is not
  doubled; an existing chip is not duplicated case-variantly.
- A 60-member group yields 50 chips plus a `+N more`.
- Advanced Search's From/To fields never show a group suggestion.
- VIEWER sees no edit, invite, or delete controls.
- Existing `EmailChipInput`, `EmailAutocompleteInput`, `ComposeModal` and
  contacts tests keep passing unchanged.

**Live**

Smoke on both VMs after deploy. Per the standing rule, **no real external
recipients in test sends** — group members in testing are internal test
addresses only.

## 10. Assumptions to confirm on review

These three were flagged at design review and went unanswered; the recommended
default was adopted so implementation is not blocked. Any of them can be changed
without disturbing the rest of the design.

1. **Role split** — `VIEWER` sends, `EDITOR` edits members. The alternative is
   view-and-send only, with no shared editing at all, which would drop
   `InviteRole` from the model entirely.
2. **No invite notification in v1** — a shared group appears quietly in the
   invitee's Groups tab. A `Notification` model exists if we later want to
   announce it.
3. **50-chip soft cap** before `+N more` collapse.

## 11. Out of scope

- Institution-wide or admin-managed distribution lists (§2.1).
- Real Zimbra/EWS distribution lists — these groups are local to 1Gov Mail and
  are not written back to the provider.
- Nested groups (a group containing another group).
- Group membership sourced live from Contacts — `members` stays a snapshot of
  addresses, so renaming or deleting a contact does not alter any group.
