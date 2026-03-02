'use client';

import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import CodeBlockLowlightBase from '@tiptap/extension-code-block-lowlight';
import { createLowlight, all } from 'lowlight';

// ── Lowlight instance with all bundled languages ──────────────────────────────
const lowlight = createLowlight(all);

// ── Language list shown in the selector ──────────────────────────────────────
const LANGUAGES = [
  { value: '', label: 'Plain text' },
  { value: 'bash', label: 'Bash / Shell' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'css', label: 'CSS' },
  { value: 'diff', label: 'Diff' },
  { value: 'go', label: 'Go' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'html', label: 'HTML' },
  { value: 'http', label: 'HTTP' },
  { value: 'java', label: 'Java' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'json', label: 'JSON' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'lua', label: 'Lua' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'php', label: 'PHP' },
  { value: 'python', label: 'Python' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'rust', label: 'Rust' },
  { value: 'scss', label: 'SCSS' },
  { value: 'sql', label: 'SQL' },
  { value: 'swift', label: 'Swift' },
  { value: 'toml', label: 'TOML' },
  { value: 'tsx', label: 'TSX' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'xml', label: 'XML' },
  { value: 'yaml', label: 'YAML' },
];

// ── NodeView ──────────────────────────────────────────────────────────────────
function CodeBlockNodeView({
  node,
  updateAttributes,
  extension,
}: {
  node: { attrs: Record<string, string> };
  updateAttributes: (attrs: Record<string, unknown>) => void;
  extension: { options: { lowlight: unknown } };
}) {
  const lang = node.attrs.language ?? '';

  return (
    <NodeViewWrapper className="relative group my-2">
      <div className="code-block-wrapper rounded-lg overflow-hidden border border-border">
        {/* Header bar */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#1e1e2e] border-b border-white/10">
          {/* Dots */}
          <div className="flex items-center gap-1.5" contentEditable={false}>
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
          </div>

          {/* Language selector */}
          <select
            contentEditable={false}
            value={lang}
            onChange={(e) => updateAttributes({ language: e.target.value || null })}
            onKeyDown={(e) => e.stopPropagation()}
            className="text-[10px] bg-transparent text-white/50 hover:text-white/80 cursor-pointer outline-none border-none appearance-none pr-1 transition-colors"
          >
            {LANGUAGES.map(({ value, label }) => (
              <option key={value} value={value} className="bg-[#1e1e2e] text-white">
                {label}
              </option>
            ))}
          </select>
        </div>

        {/* Code area */}
        <pre className="!m-0 !rounded-none !border-0 overflow-x-auto">
          {/* @ts-expect-error NodeViewContent `as` accepts any tag */}
          <NodeViewContent as="code" className={lang ? `language-${lang} hljs` : 'hljs'} />
        </pre>
      </div>
    </NodeViewWrapper>
  );
}

// ── Extension ─────────────────────────────────────────────────────────────────
export const CodeBlockLowlight = CodeBlockLowlightBase.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
}).configure({ lowlight });
