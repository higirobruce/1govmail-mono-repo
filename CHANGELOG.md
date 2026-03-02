# Changelog

All notable changes to 1Gov Mail are documented here.

## [1.5.0](https://github.com/1govmail/email-client/compare/v1.4.0...v1.5.0) (2026-03-02)

### Features

* **docs:** new Documents module with rich TipTap editor — create, edit, delete, and organise documents inside the app
* **docs:** real-time collaborative editing — multiple users can edit the same document simultaneously with conflict-free Yjs CRDT sync and live remote cursors
* **docs:** document sharing — share any document via a secure read-only link; recipients can view without an account
* **docs:** live title sync — document title changes broadcast instantly to all collaborators via Yjs metadata
* **contacts:** contact groups and in-app notification support
* **mail:** drag email to create task or event — drag any message from the inbox to pre-fill a new task or calendar event with the subject and sender
* **ui:** theme switcher — toggle between Light, Dark, and System (follows OS) from settings
* **ui:** native OS desktop notifications for new mail and task reminders
* **ui:** keyboard shortcuts for common actions (compose, reply, archive, delete, navigate folders)
* **calendar:** full event detail view with per-attendee RSVP status indicators

### Improvements

* **tasks:** board column backgrounds and card styling refreshed for better readability and contrast
* **ui:** reusable DateTimePicker component — consistent date and time selection across all scheduling features
* **calendar:** improved layout; sidebar folder list no longer fails on slow API responses

### Bug Fixes

* **docs:** share dialog URL field is now a proper text input, making it easy to select and copy the link

---

## [1.4.0](https://github.com/1govmail/email-client/compare/v1.3.0...v1.4.0) (2026-03-01)

### Features

* **mail:** snooze any message — resurfaces it at a chosen time (later today, tonight, tomorrow, next week, or a custom date/time) via a persistent DB record and a per-minute cron job ([#mail-snooze])
* **mail:** undo send — compose closes immediately after clicking Send; a 5-second toast with an Undo action cancels the outgoing message before it is dispatched ([#mail-undo-send])
* **mail:** scheduled send — compose a message and pick any future date/time for delivery; the backend scheduler processes due messages every minute ([#mail-scheduled-send])
* **mail:** email templates — save reusable canned responses (name, subject, body) and insert them into the compose editor from the toolbar dropdown ([#mail-templates])
* **mail:** mail rules — create if/then filters (field · operator · value → move/label/forward) stored per-user and managed via full CRUD endpoints ([#mail-rules])
* **mail:** mute conversations — silence a thread so it stays out of the way; muted state is surfaced in the message list and toggled from the thread header ([#mail-mute])
* **mail:** print view — opens a formatted, printer-friendly window for any email thread with a clean layout and no application chrome ([#mail-print])
* **mail:** bulk operations — checkbox-select multiple messages in the list; floating action bar lets you mark read/unread or delete all selected in one click ([#mail-bulk])
* **mail:** inline spell check — native browser spell check enabled in the TipTap compose editor, flagging typos in real time ([#mail-spellcheck])
* **web:** landing page at `/` showcasing the nine new features with links to sign in and open inbox

---

## [1.3.0](https://github.com/1govmail/email-client/compare/v1.2.0...v1.3.0) (2026-03-01)

### Features

* **onboarding:** interactive step-by-step guided tour launched from the sidebar — covers compose, inbox, tasks, calendar, and contacts
* **ui:** confirmation modals replace all `window.confirm` dialogs for destructive actions (delete task, event, contact, folder, signature)

### Improvements

* **calendar:** agenda view is now the default on page load
* **tasks:** task edit sheet correctly pre-fills all fields (title, description, status, priority, due date, recurrence, reminder, assignee) when reopening a saved task

### Bug Fixes

* **calendar:** RSVP (Accept / Decline / Tentative) no longer triggers a Zimbra Java NullPointerException

---

## [1.2.0](https://github.com/1govmail/email-client/compare/v1.1.0...v1.2.0) (2026-02-28)

### Features

* **tasks:** recurring tasks with configurable intervals — daily, weekly, monthly, yearly — that automatically spawn the next occurrence when marked done ([fa91efa](https://github.com/1govmail/email-client/commit/fa91efa))
* **tasks:** email reminder notifications sent to the task owner before the due date (15 min / 30 min / 1 hour / 1 day ahead) ([fa91efa](https://github.com/1govmail/email-client/commit/fa91efa))
* **tasks:** file attachments — upload up to 5 files (5 MB each) per task, download or delete inline ([fa91efa](https://github.com/1govmail/email-client/commit/fa91efa))
* **tasks:** My Day tab showing tasks due today with a live count badge ([fa91efa](https://github.com/1govmail/email-client/commit/fa91efa))
* **tasks:** bulk actions — multi-select tasks with checkboxes and a floating action bar to mark done or delete in one click ([fa91efa](https://github.com/1govmail/email-client/commit/fa91efa))
* **ui:** task create/edit now opens in a slide-in sheet panel for better use of screen space ([f517e0d](https://github.com/1govmail/email-client/commit/f517e0d))

## [1.1.0](https://github.com/1govmail/email-client/compare/v1.0.0...v1.1.0) (2026-02-27)

### Features

* **tasks:** full task management module with Zimbra integration — create, edit, delete, and status tracking ([03834ae](https://github.com/1govmail/email-client/commit/03834ae))
* **tasks:** subtasks with per-task progress counter ([5d8ab1f](https://github.com/1govmail/email-client/commit/5d8ab1f))
* **tasks:** threaded comments with author avatars and delete ([5d8ab1f](https://github.com/1govmail/email-client/commit/5d8ab1f))
* **tasks:** kanban board view with drag-and-drop between status columns ([5d8ab1f](https://github.com/1govmail/email-client/commit/5d8ab1f))
* **tasks:** sort by date and priority; filter by status and overdue ([5d8ab1f](https://github.com/1govmail/email-client/commit/5d8ab1f))
* **tasks:** create tasks directly from an email thread with subject pre-filled ([de9f2b2](https://github.com/1govmail/email-client/commit/de9f2b2))
* **tasks:** assign tasks to colleagues with an automatic notification email ([03834ae](https://github.com/1govmail/email-client/commit/03834ae))
* **calendar:** batch free/busy lookup for multi-attendee availability ([ca52bb7](https://github.com/1govmail/email-client/commit/ca52bb7))
* **calendar:** find-a-time panel with working hours overlay and per-user color coding ([ca52bb7](https://github.com/1govmail/email-client/commit/ca52bb7))
* **mail:** redesigned thread view with timeline spine and compact message layout ([4a50ee8](https://github.com/1govmail/email-client/commit/4a50ee8))
* **mail:** improved email rendering and sent message persistence ([d649d89](https://github.com/1govmail/email-client/commit/d649d89))
* **mail:** image support for email signatures and inline attachments ([048ad64](https://github.com/1govmail/email-client/commit/048ad64))
* **desktop:** cross-platform builds for macOS (Apple Silicon & Intel), Windows, and Linux ([4c19ec8](https://github.com/1govmail/email-client/commit/4c19ec8))

### Bug Fixes

* **compose:** improve signature selection and cache invalidation ([5e27463](https://github.com/1govmail/email-client/commit/5e27463))
* **mail:** prevent locally deleted drafts from reappearing after refresh ([2342da6](https://github.com/1govmail/email-client/commit/2342da6))
* **calendar:** improve free/busy search accuracy and tooltip styling ([78a58d5](https://github.com/1govmail/email-client/commit/78a58d5))

## [1.0.0](https://github.com/1govmail/email-client/releases/tag/v1.0.0) (2026-02-27)

### Features

* initialize monorepo with Next.js 15 frontend and NestJS 11 backend ([1207e34](https://github.com/1govmail/email-client/commit/1207e34))
* initialize desktop email client with Electron shell ([3ab4f53](https://github.com/1govmail/email-client/commit/3ab4f53))
* email, contacts, calendar, and settings modules with Zimbra integration
