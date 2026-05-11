// Vendor type stubs for packages without @types declarations.

// html-to-docx is require()'d server-side only (see app/api/docs/export/docx/route.ts)
// so no browser-facing declaration is needed here.

declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}