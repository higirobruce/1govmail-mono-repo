# Web tests

Two test runners live here:

- **Vitest** — unit + integration. Runs in jsdom with `fake-indexeddb` auto-loaded so Dexie code works without a browser.
- **Playwright** — E2E in a real browser. Specs live in `tests/e2e/`.

## Commands

```bash
pnpm --filter web test          # vitest run, single pass
pnpm --filter web test:watch    # vitest in watch mode
pnpm --filter web test:cov      # coverage for lib/offline (gated at 85%)
pnpm --filter web test:e2e      # playwright run
pnpm --filter web test:e2e:ui   # playwright UI mode
```

## Layout

```
apps/web/
  test/
    setup.ts            # jest-dom + fake-indexeddb + RTL cleanup
  lib/offline/          # offline-first runtime (Dexie, outbox, sync)
    *.test.ts           # unit tests co-located
  tests/e2e/            # playwright specs
```

## Coverage gate

Only `lib/offline/**` is gated. Other code can be tested but isn't required to.
Drop below 85% lines/functions/statements (or 80% branches) → `test:cov` fails.

## MSW

For tests that need to intercept fetch, instantiate a per-suite MSW server
in the test file rather than a global one — keeps suites isolated and avoids
hidden cross-test state.

## Known quirks

- `fake-indexeddb` is loaded via side-effect import in `test/setup.ts`. Tests that
  spin up multiple DB instances should call `indexedDB.deleteDatabase(name)`
  in their cleanup or use a fresh DB name per test.
- Playwright workers default to chromium only here. Add firefox/webkit projects
  in `playwright.config.ts` if cross-browser parity becomes a concern.
