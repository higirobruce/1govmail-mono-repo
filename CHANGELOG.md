# Changelog

All notable changes to 1Gov Mail are documented here.

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
