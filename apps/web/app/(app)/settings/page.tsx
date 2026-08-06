'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { useThemeStore, type FontSize } from '@/stores/theme.store';
import { useAIStore } from '@/stores/ai.store';
import { api } from '@/lib/api';
import { AIClient } from '@/lib/ai/client';
import Sidebar from '@/components/layout/Sidebar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  User, Pen, Shield, Mail, Loader2, Plus, Trash2,
  Check, ChevronRight, RotateCcw, FileSignature,
  Palmtree, Settings2, Sparkles, AlertTriangle,
  Bold, Italic, Underline as UnderlineIcon, Image as ImageIcon,
} from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import TiptapImage from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { cn } from '@/lib/utils';
import { sanitizeSignatureHtml } from '@/lib/sanitize';

// Extend TipTap's Image extension to preserve the data-zimbra-src attribute
// that the backend embeds alongside each base64 data URI. Without this, TipTap
// strips the attribute on parse and the round-trip to Zimbra loses the original
// Briefcase path, causing a "zimbraPrefMailSignature > 10 240 bytes" error.
const ZimbraAwareImage = TiptapImage.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-zimbra-src': {
        default: null,
        parseHTML: (el) => el.getAttribute('data-zimbra-src') ?? null,
        renderHTML: (attrs) =>
          attrs['data-zimbra-src'] ? { 'data-zimbra-src': attrs['data-zimbra-src'] } : {},
      },
    };
  },
}).configure({ inline: true, allowBase64: true });

// ── Types ──────────────────────────────────────────────────────────────────────

interface Identity {
  id: string;
  name: string;
  attrs: Record<string, string>;
}

interface Signature {
  id: string;
  name: string;
  contentHtml: string;
  contentText: string;
}

interface SettingsData {
  email: string;
  zimbraHost: string;
  displayName: string | null;
  prefs: Record<string, string>;
  identities: Identity[];
  signatures: Signature[];
}

type Section = 'profile' | 'signatures' | 'vacation' | 'preferences' | 'ai' | 'security';

// ── Toggle Switch ──────────────────────────────────────────────────────────────

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/25',
        checked ? 'bg-primary' : 'bg-muted-foreground/25',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

// ── Select ─────────────────────────────────────────────────────────────────────

function Select({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 px-2 text-sm rounded-md border border-border/50 bg-muted/30 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/20 focus:border-primary/30"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// ── Section nav item ───────────────────────────────────────────────────────────

function NavItem({ icon: Icon, label, active, onClick }: {
  icon: React.ElementType; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-colors',
        active
          ? 'bg-primary/10 text-primary font-medium'
          : 'text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground',
      )}
    >
      <Icon className="w-4 h-4 shrink-0" />
      {label}
      {active && <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-50" />}
    </button>
  );
}

// ── Setting row ────────────────────────────────────────────────────────────────

function SettingRow({ label, description, children }: {
  label: string; description?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground/55 mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ── Theme selector ─────────────────────────────────────────────────────────────

function ThemeSelector() {
  const { theme, setTheme } = useThemeStore();
  const options = [
    { value: 'light',  label: 'Light' },
    { value: 'dark',   label: 'Dark' },
    { value: 'system', label: 'System' },
  ] as const;
  return (
    <div className="flex gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className={cn(
            'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
            theme === opt.value
              ? 'bg-primary/10 border-primary/40 text-primary'
              : 'border-border/50 text-muted-foreground hover:border-border hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Font size selector ─────────────────────────────────────────────────────────

function FontSizeSelector() {
  const { fontSize, setFontSize } = useThemeStore();
  const options: { value: FontSize; label: string; hint: string }[] = [
    { value: 'sm',      label: 'Small',    hint: 'A' },
    { value: 'default', label: 'Default',  hint: 'A' },
    { value: 'lg',      label: 'Large',    hint: 'A' },
    { value: 'xl',      label: 'X-Large',  hint: 'A' },
  ];
  const hintSizes = ['text-[11px]', 'text-[13px]', 'text-[15px]', 'text-[17px]'];
  return (
    <div className="flex gap-2">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => setFontSize(opt.value)}
          className={cn(
            'flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-lg border transition-all',
            (fontSize ?? 'default') === opt.value
              ? 'bg-primary/10 border-primary/40 text-primary'
              : 'border-border/50 text-muted-foreground hover:border-border hover:text-foreground',
          )}
        >
          <span className={cn('font-semibold leading-none', hintSizes[i])}>{opt.hint}</span>
          <span className="text-[10px] mt-0.5">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description && <p className="text-sm text-muted-foreground/60 mt-0.5">{description}</p>}
      <Separator className="mt-4" />
    </div>
  );
}

// ── Signature toolbar button helper ────────────────────────────────────────────

function SigToolBtn({
  children,
  active,
  onClick,
  title,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'p-1.5 rounded hover:bg-muted/60 transition-colors',
        active && 'bg-muted text-primary',
      )}
    >
      {children}
    </button>
  );
}

// ── Signature editor (WYSIWYG) ─────────────────────────────────────────────────

function SignatureEditor({
  sig,
  onSave,
  onCancel,
  saving,
}: {
  sig: Partial<Signature>;
  onSave: (data: { name: string; contentHtml: string }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(sig.name ?? '');
  const imgInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      ZimbraAwareImage,
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: sig.contentHtml || '<p></p>',
    editorProps: {
      attributes: {
        class: 'min-h-[120px] outline-none text-sm text-foreground leading-relaxed p-3 [&_img]:max-w-full',
      },
    },
  });

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editor) return;
    const reader = new FileReader();
    reader.onload = () => {
      editor.chain().focus().setImage({ src: reader.result as string }).run();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div className="space-y-4">
      {/* Name */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Work Signature"
          className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/30"
        />
      </div>

      {/* WYSIWYG editor */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Signature content</Label>
        <div className="border border-border/50 rounded-lg overflow-hidden">
          {/* Mini toolbar */}
          <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-border/40 bg-muted/20">
            <SigToolBtn
              active={editor?.isActive('bold')}
              onClick={() => editor?.chain().focus().toggleBold().run()}
              title="Bold"
            >
              <Bold className="w-3.5 h-3.5" />
            </SigToolBtn>
            <SigToolBtn
              active={editor?.isActive('italic')}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
              title="Italic"
            >
              <Italic className="w-3.5 h-3.5" />
            </SigToolBtn>
            <SigToolBtn
              active={editor?.isActive('underline')}
              onClick={() => editor?.chain().focus().toggleUnderline().run()}
              title="Underline"
            >
              <UnderlineIcon className="w-3.5 h-3.5" />
            </SigToolBtn>
            <div className="w-px h-4 bg-border/40 mx-1" />
            <SigToolBtn
              onClick={() => imgInputRef.current?.click()}
              title="Upload image"
            >
              <ImageIcon className="w-3.5 h-3.5" />
            </SigToolBtn>
            <input
              ref={imgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
          </div>
          <EditorContent editor={editor} className="bg-background" />
        </div>
        <p className="text-[11px] text-muted-foreground/40">
          Use the toolbar to format text and upload images (logo, photo, etc.).
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => onSave({ name: name.trim(), contentHtml: editor?.getHTML() ?? '' })}
          disabled={saving || !name.trim()}
          className="h-8 text-xs gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Save signature
        </Button>
        <Button
          size="sm" variant="ghost"
          onClick={onCancel}
          disabled={saving}
          className="h-8 text-xs text-muted-foreground/60"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [hydrated, setHydrated] = useState(false);
  const queryClient = useQueryClient();

  const [section, setSection] = useState<Section>('profile');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SettingsData | null>(null);

  // ── Auth guard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // ── Load settings ───────────────────────────────────────────────────────────
  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.settings.get();
      setData(d as SettingsData);
      // Invalidate the React Query ['settings'] cache so ComposeModal (and any
      // other component using useQuery(['settings'])) refetches the latest data,
      // including updated zimbraPrefDefaultSignatureId and signature content.
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch (err: any) {
      toast.error('Failed to load settings', { description: err?.message });
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    loadSettings();
  }, [hydrated, isAuthenticated, loadSettings]);

  if (!hydrated) return null;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />

      {/* ── Settings nav ── */}
      <div className="w-56 shrink-0 flex flex-col border-r border-border/50 h-full bg-card/50 py-4 px-3 gap-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/40 px-2 mb-2">
          Settings
        </p>
        <NavItem icon={User}          label="Profile"       active={section === 'profile'}     onClick={() => setSection('profile')} />
        <NavItem icon={FileSignature} label="Signatures"    active={section === 'signatures'}  onClick={() => setSection('signatures')} />
        <NavItem icon={Palmtree}      label="Vacation Reply" active={section === 'vacation'}   onClick={() => setSection('vacation')} />
        <NavItem icon={Settings2}     label="Preferences"   active={section === 'preferences'} onClick={() => setSection('preferences')} />
        <NavItem icon={Sparkles}      label="AI Assistant"  active={section === 'ai'}          onClick={() => setSection('ai')} />
        <NavItem icon={Shield}        label="Security"      active={section === 'security'}    onClick={() => setSection('security')} />
      </div>

      {/* ── Main content ── */}
      <ScrollArea className="flex-1 min-w-0 h-full">
        <div className="max-w-2xl mx-auto px-8 py-8">
          {loading ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/40" />
            </div>
          ) : data ? (
            <>
              {section === 'profile'     && <ProfileSection     data={data} onUpdate={loadSettings} />}
              {section === 'signatures'  && <SignaturesSection   data={data} onUpdate={loadSettings} />}
              {section === 'vacation'    && <VacationSection     data={data} onUpdate={loadSettings} />}
              {section === 'preferences' && <PreferencesSection  data={data} onUpdate={loadSettings} />}
              {section === 'ai'          && <AISection />}
              {section === 'security'    && <SecuritySection     data={data} />}
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Profile section
// ══════════════════════════════════════════════════════════════════════════════

function ProfileSection({ data, onUpdate }: { data: SettingsData; onUpdate: () => void }) {
  const primaryIdentity = data.identities[0];
  const attrs = primaryIdentity?.attrs ?? {};

  const [displayName, setDisplayName]   = useState(attrs.zimbraPrefFromDisplay ?? data.displayName ?? '');
  const [replyToEnabled, setReplyToEnabled] = useState(attrs.zimbraPrefReplyToEnabled === 'TRUE');
  const [replyToEmail, setReplyToEmail] = useState(attrs.zimbraPrefReplyToAddress ?? '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!primaryIdentity) { toast.error('No identity found'); return; }
    setSaving(true);
    try {
      await api.settings.updateIdentity(primaryIdentity.id, {
        zimbraPrefFromDisplay:    displayName,
        zimbraPrefReplyToEnabled: replyToEnabled ? 'TRUE' : 'FALSE',
        ...(replyToEnabled ? { zimbraPrefReplyToAddress: replyToEmail } : {}),
      });
      toast.success('Profile updated');
      onUpdate();
    } catch (err: any) {
      toast.error('Failed to update profile', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Profile"
        description="Manage how your name and address appear to recipients."
      />

      {/* Read-only info */}
      <div className="space-y-3 mb-6">
        <div>
          <Label className="text-xs text-muted-foreground/50 uppercase tracking-wider">Email address</Label>
          <p className="mt-1 text-sm text-foreground/70">{data.email}</p>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground/50 uppercase tracking-wider">Server</Label>
          <p className="mt-1 text-sm text-foreground/70">{data.zimbraHost}</p>
        </div>
      </div>

      <Separator className="mb-6" />

      {/* Editable */}
      <div className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Display name</Label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your Name"
            className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/30"
          />
          <p className="text-xs text-muted-foreground/40">Shown as the sender name in outgoing emails.</p>
        </div>

        <Separator />

        <SettingRow
          label="Custom reply-to address"
          description="Replies go to a different address than your main email."
        >
          <Switch checked={replyToEnabled} onChange={setReplyToEnabled} />
        </SettingRow>

        {replyToEnabled && (
          <div className="flex flex-col gap-1.5 pl-0">
            <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Reply-to email</Label>
            <Input
              type="email"
              value={replyToEmail}
              onChange={(e) => setReplyToEmail(e.target.value)}
              placeholder="replies@example.com"
              className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/30"
            />
          </div>
        )}
      </div>

      <div className="mt-6">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="h-8 text-xs gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Signatures section
// ══════════════════════════════════════════════════════════════════════════════

function SignaturesSection({ data, onUpdate }: { data: SettingsData; onUpdate: () => void }) {
  const [signatures, setSignatures] = useState<Signature[]>(data.signatures);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const confirm = useConfirmStore((s) => s.confirm);

  const editingSig = editingId === 'new'
    ? { id: 'new', name: '', contentHtml: '', contentText: '' }
    : signatures.find((s) => s.id === editingId) ?? null;

  const handleSave = async (sigData: { name: string; contentHtml: string }) => {
    if (!sigData.name) { toast.error('Signature name is required'); return; }
    setSaving(true);
    try {
      if (editingId === 'new') {
        const created = await api.settings.createSignature(sigData);
        setSignatures((prev) => [...prev, created as Signature]);
        toast.success('Signature created');
        if (created.imagesStripped) {
          toast.warning('Uploaded images were removed — only images from your Zimbra Briefcase can be saved in signatures.');
        }
      } else if (editingId) {
        const updated = await api.settings.updateSignature(editingId, sigData);
        setSignatures((prev) => prev.map((s) => s.id === editingId ? (updated as Signature) : s));
        toast.success('Signature updated');
        if (updated.imagesStripped) {
          toast.warning('Uploaded images were removed — only images from your Zimbra Briefcase can be saved in signatures.');
        }
      }
      setEditingId(null);
      onUpdate();
    } catch (err: any) {
      toast.error('Failed to save signature', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (id: string) => {
    confirm({
      title: 'Delete this signature?',
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        setDeletingId(id);
        try {
          await api.settings.deleteSignature(id);
          setSignatures((prev) => prev.filter((s) => s.id !== id));
          if (editingId === id) setEditingId(null);
          toast.success('Signature deleted');
          onUpdate();
        } catch (err: any) {
          toast.error('Failed to delete signature', { description: err?.message });
        } finally {
          setDeletingId(null);
        }
      },
    });
  };

  return (
    <div>
      <SectionHeader
        title="Email Signatures"
        description="Create signatures that are automatically appended to your messages."
      />

      <div className="space-y-3">
        {signatures.length === 0 && !editingId && (
          <div className="flex flex-col items-center justify-center py-10 text-center border border-dashed border-border/40 rounded-lg">
            <FileSignature className="w-8 h-8 text-muted-foreground/20 mb-2" />
            <p className="text-sm text-muted-foreground/50">No signatures yet</p>
          </div>
        )}

        {/* Signature list */}
        {signatures.map((sig) => (
          <div key={sig.id} className="border border-border/40 rounded-lg overflow-hidden">
            {editingId === sig.id ? (
              <div className="p-4">
                <SignatureEditor
                  sig={sig}
                  onSave={handleSave}
                  onCancel={() => setEditingId(null)}
                  saving={saving}
                />
              </div>
            ) : (
              <div className="flex items-start gap-3 p-3.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{sig.name}</p>
                  <div
                    className="text-xs text-muted-foreground/50 mt-1 line-clamp-2 [&_*]:max-w-full"
                    dangerouslySetInnerHTML={{ __html: sanitizeSignatureHtml(sig.contentHtml) }}
                  />
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => setEditingId(sig.id)}
                    className="h-7 w-7 p-0 text-muted-foreground/50 hover:text-foreground"
                    title="Edit"
                  >
                    <Pen className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm" variant="destructive-ghost"
                    onClick={() => handleDelete(sig.id)}
                    disabled={deletingId === sig.id}
                    className="h-7 w-7 p-0"
                    title="Delete"
                  >
                    {deletingId === sig.id
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Trash2 className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* New signature form */}
        {editingId === 'new' && (
          <div className="border border-border/40 rounded-lg p-4">
            <p className="text-sm font-medium text-foreground mb-4">New Signature</p>
            <SignatureEditor
              sig={{ name: '', contentHtml: '' }}
              onSave={handleSave}
              onCancel={() => setEditingId(null)}
              saving={saving}
            />
          </div>
        )}

        {editingId !== 'new' && (
          <Button
            size="sm" variant="outline"
            onClick={() => setEditingId('new')}
            className="h-8 text-xs gap-1.5 border-dashed border-border/50"
          >
            <Plus className="w-3.5 h-3.5" />
            Add signature
          </Button>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Vacation reply section
// ══════════════════════════════════════════════════════════════════════════════

const OOO_TEMPLATES = [
  {
    label: 'Brief',
    text: 'Thank you for your message. I am currently out of office and will respond upon my return.',
  },
  {
    label: 'With return date',
    text: 'I am out of office until {date}. I will reply to your message as soon as possible after that date.',
  },
  {
    label: 'Urgent contact',
    text: 'I am currently out of office. For urgent matters, please contact {contact}. I will respond to all other emails upon my return.',
  },
  {
    label: 'Conference / travel',
    text: 'I am attending a conference and have limited access to email. I will respond to your message as soon as possible.',
  },
] as const;

function OooTemplateInserter({ onInsert }: { onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-primary hover:text-primary/80 transition-colors"
      >
        Insert template ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 bg-card border border-border rounded-xl shadow-lg py-1 w-52">
          {OOO_TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => { onInsert(t.text); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-[12px] hover:bg-muted/50 text-foreground transition-colors"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VacationSection({ data, onUpdate }: { data: SettingsData; onUpdate: () => void }) {
  const p = data.prefs;

  const [enabled, setEnabled]       = useState(p.zimbraPrefOutOfOfficeReplyEnabled === 'TRUE');
  const [message, setMessage]       = useState(p.zimbraPrefOutOfOfficeReply ?? '');
  const [fromDate, setFromDate]     = useState(p.zimbraPrefOutOfOfficeFromDate  ?? '');
  const [untilDate, setUntilDate]   = useState(p.zimbraPrefOutOfOfficeUntilDate ?? '');
  const [extEnabled, setExtEnabled] = useState(p.zimbraPrefOutOfOfficeExternalReplyEnabled === 'TRUE');
  const [extMessage, setExtMessage] = useState(p.zimbraPrefOutOfOfficeExternalReply ?? '');
  const [saving, setSaving]         = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const isPastDate = enabled && fromDate && fromDate.slice(0, 10) < today;

  const handleSave = async () => {
    setSaving(true);
    try {
      const prefs: Record<string, string> = {
        zimbraPrefOutOfOfficeReplyEnabled: enabled ? 'TRUE' : 'FALSE',
        zimbraPrefOutOfOfficeReply:        message,
        zimbraPrefOutOfOfficeExternalReplyEnabled: extEnabled ? 'TRUE' : 'FALSE',
        zimbraPrefOutOfOfficeExternalReply: extMessage,
      };
      if (fromDate)  prefs.zimbraPrefOutOfOfficeFromDate  = fromDate;
      if (untilDate) prefs.zimbraPrefOutOfOfficeUntilDate = untilDate;
      await api.settings.updatePrefs(prefs);
      toast.success('Vacation reply saved');
      onUpdate();
    } catch (err: any) {
      toast.error('Failed to save vacation reply', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Vacation Reply"
        description="Automatically reply to messages when you're away."
      />

      <div className="space-y-1 divide-y divide-border/30">
        <SettingRow label="Enable vacation reply" description="Send an automatic reply to incoming messages.">
          <Switch checked={enabled} onChange={setEnabled} />
        </SettingRow>
      </div>

      {/* Past-date warning */}
      {isPastDate && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-600 dark:text-amber-400">
          <span className="shrink-0 mt-0.5">⚠</span>
          Your out-of-office period may have already started or passed. Check the dates below.
        </div>
      )}

      {enabled && (
        <div className="mt-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Away from</Label>
              <DateTimePicker
                value={fromDate ? fromDate.slice(0, 10) : ''}
                onChange={setFromDate}
                dateOnly
                className="h-8 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Until</Label>
              <DateTimePicker
                value={untilDate ? untilDate.slice(0, 10) : ''}
                onChange={setUntilDate}
                dateOnly
                className="h-8 text-sm"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Message</Label>
              <OooTemplateInserter onInsert={(t) => setMessage((m) => m ? `${m}\n\n${t}` : t)} />
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="I'm currently out of office and will reply when I return."
              rows={4}
              className="w-full rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/20 focus:border-primary/30 resize-y"
            />
          </div>

          <Separator />

          <div className="space-y-1 divide-y divide-border/30">
            <SettingRow
              label="Different reply for external senders"
              description="Use a separate message for people outside your organisation."
            >
              <Switch checked={extEnabled} onChange={setExtEnabled} />
            </SettingRow>
          </div>

          {extEnabled && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">External message</Label>
                <OooTemplateInserter onInsert={(t) => setExtMessage((m) => m ? `${m}\n\n${t}` : t)} />
              </div>
              <textarea
                value={extMessage}
                onChange={(e) => setExtMessage(e.target.value)}
                placeholder="Thank you for your email. I am currently out of office…"
                rows={4}
                className="w-full rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/20 focus:border-primary/30 resize-y"
              />
            </div>
          )}

          {/* Live preview */}
          <div className="border border-border/40 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setShowPreview((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/20 hover:bg-muted/40 transition-colors text-[12px] font-medium text-muted-foreground"
            >
              <span>Preview auto-reply</span>
              <span>{showPreview ? '▲' : '▼'}</span>
            </button>
            {showPreview && (
              <div className="p-4 bg-card space-y-2 text-[12px]">
                <div className="flex items-center gap-2 text-muted-foreground/60">
                  <span className="font-medium text-foreground/60">Subject:</span>
                  <span>Out of Office: Re: [your subject]</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground/60">
                  <span className="font-medium text-foreground/60">From:</span>
                  <span>{data.email}</span>
                </div>
                <Separator />
                <pre className="whitespace-pre-wrap text-foreground/80 text-[12px] font-sans leading-relaxed">
                  {message || '(no message set)'}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-6">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="h-8 text-xs gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Mail preferences section
// ══════════════════════════════════════════════════════════════════════════════

function PreferencesSection({ data, onUpdate }: { data: SettingsData; onUpdate: () => void }) {
  const p = data.prefs;
  const primaryIdentity = data.identities[0];

  // Reading / display
  const [htmlPreferred, setHtmlPreferred] = useState(p.zimbraPrefMessageViewHtmlPreferred !== 'FALSE');
  const [markReadDelay, setMarkReadDelay] = useState(p.zimbraPrefMarkMsgRead ?? '0');
  const [itemsPerPage,  setItemsPerPage]  = useState(p.zimbraPrefMailItemsPerPage ?? '25');

  // Client-side only pref (localStorage) — not stored in Zimbra
  const [normalizeEmailStyles, setNormalizeEmailStyles] = useState(() =>
    typeof window !== 'undefined'
      ? localStorage.getItem('1gov_normalize_email_styles') !== 'false'
      : true,
  );
  const handleNormalizeToggle = (v: boolean) => {
    setNormalizeEmailStyles(v);
    localStorage.setItem('1gov_normalize_email_styles', String(v));
  };

  // Composing
  const [composeFormat, setComposeFormat] = useState(p.zimbraPrefComposeFormat ?? 'html');
  const [defaultSigId,  setDefaultSigId]  = useState(
    primaryIdentity?.attrs?.zimbraPrefDefaultSignatureId ?? '',
  );
  const [replySigId, setReplySigId] = useState(
    primaryIdentity?.attrs?.zimbraPrefForwardReplySignatureId ?? '',
  );

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // 1. Update prefs
      await api.settings.updatePrefs({
        zimbraPrefMessageViewHtmlPreferred: htmlPreferred ? 'TRUE' : 'FALSE',
        zimbraPrefMarkMsgRead:              markReadDelay,
        zimbraPrefMailItemsPerPage:         itemsPerPage,
        zimbraPrefComposeFormat:            composeFormat,
      });
      // 2. Update identity signature settings
      if (primaryIdentity) {
        await api.settings.updateIdentity(primaryIdentity.id, {
          zimbraPrefDefaultSignatureId:        defaultSigId,
          zimbraPrefForwardReplySignatureId:   replySigId,
        });
      }
      toast.success('Preferences saved');
      onUpdate();
    } catch (err: any) {
      toast.error('Failed to save preferences', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  const sigOptions = [
    { value: '', label: '— None —' },
    ...data.signatures.map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <div>
      <SectionHeader
        title="Mail Preferences"
        description="Customise how messages are displayed and composed."
      />

      {/* Appearance */}
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/40 mb-3">Appearance</p>
      <div className="divide-y divide-border/30 mb-6">
        <SettingRow label="Theme" description="Choose light, dark, or follow your system preference.">
          <ThemeSelector />
        </SettingRow>
        <SettingRow label="Font size" description="Adjust the text size across the entire app.">
          <FontSizeSelector />
        </SettingRow>
      </div>

      {/* Reading */}
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/40 mb-3">Reading</p>
      <div className="divide-y divide-border/30 mb-6">
        <SettingRow
          label="Display messages as HTML"
          description="Render HTML email (disabling shows plain text)."
        >
          <Switch checked={htmlPreferred} onChange={setHtmlPreferred} />
        </SettingRow>

        <SettingRow
          label="Consistent email display"
          description="Override sender fonts and colours so every message uses the app's clean typography. Takes effect on the next message you open."
        >
          <Switch checked={normalizeEmailStyles} onChange={handleNormalizeToggle} />
        </SettingRow>

        <SettingRow
          label="Mark messages as read"
          description="Delay before a message is marked as read when opened."
        >
          <Select
            value={markReadDelay}
            onChange={setMarkReadDelay}
            options={[
              { value: '0',    label: 'Immediately' },
              { value: '1000', label: 'After 1 second' },
              { value: '3000', label: 'After 3 seconds' },
              { value: '5000', label: 'After 5 seconds' },
              { value: '-1',   label: 'Never' },
            ]}
          />
        </SettingRow>

        <SettingRow
          label="Messages per page"
          description="How many messages to load per scroll page."
        >
          <Select
            value={itemsPerPage}
            onChange={setItemsPerPage}
            options={[
              { value: '10',  label: '10' },
              { value: '25',  label: '25' },
              { value: '50',  label: '50' },
              { value: '100', label: '100' },
            ]}
          />
        </SettingRow>
      </div>

      {/* Composing */}
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/40 mb-3">Composing</p>
      <div className="divide-y divide-border/30 mb-6">
        <SettingRow
          label="Compose format"
          description="Default format for new messages."
        >
          <Select
            value={composeFormat}
            onChange={setComposeFormat}
            options={[
              { value: 'html', label: 'Rich text (HTML)' },
              { value: 'text', label: 'Plain text' },
            ]}
          />
        </SettingRow>

        {data.signatures.length > 0 && (
          <>
            <SettingRow
              label="Default signature"
              description="Appended to new messages."
            >
              <Select value={defaultSigId} onChange={setDefaultSigId} options={sigOptions} />
            </SettingRow>

            <SettingRow
              label="Reply / forward signature"
              description="Appended when replying or forwarding."
            >
              <Select value={replySigId} onChange={setReplySigId} options={sigOptions} />
            </SettingRow>
          </>
        )}
      </div>

      <Button
        size="sm"
        onClick={handleSave}
        disabled={saving}
        className="h-8 text-xs gap-1.5"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        Save changes
      </Button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// AI Assistant section
// ══════════════════════════════════════════════════════════════════════════════

function AISection() {
  const enabled = useAIStore((s) => s.enabled);
  const model = useAIStore((s) => s.model);
  const setEnabled = useAIStore((s) => s.setEnabled);
  const setModel = useAIStore((s) => s.setModel);

  const [draftModel, setDraftModel] = useState(model);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; detail: string }>(null);

  const handleSave = () => {
    setModel(draftModel.trim());
    toast.success('AI settings saved');
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const client = new AIClient();
      const reply = await client.chat({
        model: draftModel.trim(),
        messages: [
          { role: 'system', content: 'Respond with the single word: OK.' },
          { role: 'user', content: 'Test' },
        ],
        maxTokens: 5,
      });
      setTestResult({ ok: true, detail: `Reply: ${reply.slice(0, 80)}` });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setTestResult({ ok: false, detail: message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="AI Assistant"
        description="Summarize threads, paraphrase drafts, and suggest replies using the organisation's hosted model."
      />

      <div className="space-y-1 mb-6">
        <SettingRow
          label="Enable AI features"
          description="Adds Summarize, Rewrite, and Suggest Reply actions in mail."
        >
          <Switch checked={enabled} onChange={setEnabled} />
        </SettingRow>
      </div>

      <SectionHeader
        title="Model"
        description="Name of the model the server should use. Must match a model installed on the API host."
      />

      <div className="space-y-3 mb-6">
        <div>
          <Label className="text-xs text-muted-foreground">Model</Label>
          <Input
            value={draftModel}
            onChange={(e) => setDraftModel(e.target.value)}
            placeholder="gemma2:2b"
            className="mt-1"
          />
          <p className="text-[11px] text-muted-foreground/70 mt-1">
            Default: <code className="font-mono">gemma2:2b</code>. Change only if your administrator has installed another model.
          </p>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={handleSave} className="h-8">
            Save changes
          </Button>
          <Button size="sm" variant="outline" onClick={handleTest} disabled={testing} className="h-8 gap-1.5">
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Test connection
          </Button>
          {testResult && (
            <span
              className={cn(
                'text-[12px]',
                testResult.ok ? 'text-success' : 'text-destructive',
              )}
            >
              {testResult.ok ? '✓ ' : '✕ '}
              {testResult.detail}
            </span>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex gap-2 text-[12px] text-amber-700 dark:text-amber-300">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Privacy notice</p>
          <p className="mt-0.5 text-amber-700/80 dark:text-amber-300/80">
            When you use AI features, the email content (subject, sender, and body) is sent to the API server, which forwards it to a self-hosted model. Content does not leave your organisation's infrastructure.
          </p>
        </div>
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Security section
// ══════════════════════════════════════════════════════════════════════════════

function SecuritySection({ data }: { data: SettingsData }) {
  const [oldPwd, setOldPwd]         = useState('');
  const [newPwd, setNewPwd]         = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [saving, setSaving]         = useState(false);

  const handleChange = async () => {
    if (!oldPwd || !newPwd || !confirmPwd) {
      toast.error('All password fields are required');
      return;
    }
    if (newPwd !== confirmPwd) {
      toast.error('New passwords do not match');
      return;
    }
    if (newPwd.length < 6) {
      toast.error('New password must be at least 6 characters');
      return;
    }
    setSaving(true);
    try {
      await api.settings.changePassword(oldPwd, newPwd);
      toast.success('Password changed successfully');
      setOldPwd(''); setNewPwd(''); setConfirmPwd('');
    } catch (err: any) {
      toast.error('Failed to change password', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Security"
        description={`Change your Zimbra account password for ${data.email}.`}
      />

      <div className="max-w-sm space-y-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Current password</Label>
          <Input
            type="password"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
            placeholder="••••••••"
            className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/30"
            autoComplete="current-password"
          />
        </div>

        <Separator />

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">New password</Label>
          <Input
            type="password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            placeholder="••••••••"
            className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/30"
            autoComplete="new-password"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Confirm new password</Label>
          <Input
            type="password"
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
            placeholder="••••••••"
            className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/30"
            autoComplete="new-password"
          />
          {newPwd && confirmPwd && newPwd !== confirmPwd && (
            <p className="text-xs text-destructive">Passwords do not match</p>
          )}
        </div>

        <div className="pt-1">
          <Button
            size="sm"
            onClick={handleChange}
            disabled={saving || !oldPwd || !newPwd || !confirmPwd || newPwd !== confirmPwd}
            className="h-8 text-xs gap-1.5"
          >
            {saving
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Updating…</>
              : <><Shield className="w-3.5 h-3.5" /> Change password</>}
          </Button>
        </div>
      </div>
    </div>
  );
}
