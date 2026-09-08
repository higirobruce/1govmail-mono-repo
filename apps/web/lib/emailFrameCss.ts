// Injected stylesheet for the sandboxed email-body iframes (MailDetail and
// ThreadMessage). The iframe document can't see the app's `.dark` class or CSS
// variables, so the palette is baked into the srcDoc — callers rebuild it when
// the theme flips (see hooks/useIsDark).
//
// Dark values are the literal oklch tokens from globals.css `.dark` so the
// frame canvas is indistinguishable from the bg-card container it sits in.

interface FramePalette {
  colorScheme: 'light' | 'dark';
  bg: string;        // canvas — matches --card
  text: string;      // default body text
  heading: string;   // headings + normalized text
  link: string;
  linkHover: string;
  quoteBorder: string;
  muted: string;     // quoted/aside text
  faint: string;     // yahoo/moz quote prefixes
  hr: string;
  codeBg: string;
}

const LIGHT: FramePalette = {
  colorScheme: 'light',
  bg: '#ffffff',
  text: '#1a1a1a',
  heading: '#111827',
  link: '#2563eb',
  linkHover: '#1d4ed8',
  quoteBorder: '#d1d5db',
  muted: '#6b7280',
  faint: '#9ca3af',
  hr: '#e5e7eb',
  codeBg: '#f3f4f6',
};

const DARK: FramePalette = {
  colorScheme: 'dark',
  bg: 'oklch(0.16 0.018 255)',          // --card
  text: 'oklch(0.95 0.006 245)',        // --foreground
  heading: 'oklch(0.95 0.006 245)',
  link: 'oklch(0.72 0.12 240)',         // --primary
  linkHover: 'oklch(0.78 0.12 240)',
  quoteBorder: 'oklch(0.32 0.016 255)', // --border-strong
  muted: 'oklch(0.68 0.012 245)',       // --muted-foreground
  faint: 'oklch(0.62 0.010 245)',       // --ink-3
  hr: 'oklch(0.24 0.016 255)',          // --border
  codeBg: 'oklch(0.21 0.018 255)',      // --secondary
};

// Raw mode: defaults only — sender inline styles win. An email that hardcodes
// its own light background keeps it (a light card on the dark canvas), same
// trade-off Apple Mail makes.
function baseCss(p: FramePalette): string {
  return `*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:${p.colorScheme}}
html,body{margin:0;padding:16px;background:${p.bg};color:${p.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;overflow-x:auto;word-wrap:break-word}
a{color:${p.link};text-decoration:underline}
a:hover{color:${p.linkHover}}
img{max-width:100%;height:auto;display:inline-block}
img[width="1"],img[height="1"],img[width="0"],img[height="0"]{display:none}
table{border-collapse:collapse;max-width:100%}
td,th{padding:4px 8px;vertical-align:top}
pre,code{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;white-space:pre-wrap;word-break:break-all}
blockquote{border-left:3px solid ${p.quoteBorder};margin:12px 0;padding:4px 12px;color:${p.muted}}
.gmail_quote,.gmail_extra{border-left:2px solid ${p.quoteBorder};margin:12px 0;padding:4px 12px;color:${p.muted};font-size:13px}
.yahoo_quoted,.moz-cite-prefix{color:${p.faint};font-size:13px}
.MsoNormal{margin:0}
div[style*="border-left"]{color:${p.muted}}
hr{border:none;border-top:1px solid ${p.hr};margin:16px 0}
ul,ol{padding-left:1.5em;margin:8px 0}
li{margin:4px 0}
h1,h2,h3,h4,h5,h6{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.3;margin:16px 0 8px;color:${p.heading}}
p{margin:0 0 12px}
p:last-child{margin-bottom:0}
font{font-family:inherit}`;
}

// Appended when "Consistent email display" is ON. Uses !important so these
// stylesheet rules beat inline style="" attributes on every element — the only
// way to override sender-supplied typography wholesale. Heading-specific rules
// restore the visual hierarchy because those selectors (h1, h2…) have higher
// specificity than the wildcard (*) rule.
function normalizeCss(p: FramePalette): string {
  return `
*,*::before,*::after{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif!important;color:${p.heading}!important;background-color:transparent!important;font-size:16px!important;line-height:1.65!important;letter-spacing:normal!important;text-transform:none!important;font-weight:normal!important;font-style:normal!important}
html,body{background-color:${p.bg}!important;color:${p.heading}!important}
h1{font-size:22px!important;font-weight:700!important;line-height:1.3!important;margin:16px 0 8px!important}
h2{font-size:18px!important;font-weight:600!important;line-height:1.3!important;margin:14px 0 6px!important}
h3{font-size:15px!important;font-weight:600!important;line-height:1.3!important;margin:12px 0 6px!important}
h4,h5,h6{font-size:14px!important;font-weight:600!important;line-height:1.3!important}
strong,b{font-weight:700!important}
em,i{font-style:italic!important}
small{font-size:12px!important}
a,a *{color:${p.link}!important;text-decoration:underline!important}
a:hover,a:hover *{color:${p.linkHover}!important}
code,pre,code *,pre *{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace!important;font-size:13px!important;background-color:${p.codeBg}!important}
pre{background-color:${p.codeBg}!important;padding:12px!important}
img{background-color:transparent!important}
`;
}

export function buildEmailFrameCss(opts: { dark: boolean; normalize: boolean }): string {
  const palette = opts.dark ? DARK : LIGHT;
  return opts.normalize ? baseCss(palette) + normalizeCss(palette) : baseCss(palette);
}
