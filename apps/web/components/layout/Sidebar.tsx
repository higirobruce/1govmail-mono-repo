'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth.store';
import { useConfirmStore } from '@/stores/confirm.store';
import {
  Inbox, Send, FileText, Trash2, Archive,
  ChevronDown, LogOut, Settings, Plus, X,
  Calendar, Users, FolderOpen,
  ListTodo, UsersRound, Newspaper, Sparkles,
  Sun, Moon, Monitor,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { GlobalConfirmDialog } from '@/components/ui/confirm-dialog';
import { AppTour } from '@/components/tour/AppTour';
import { useThemeStore, type Theme } from '@/stores/theme.store';
import { NotificationsBell } from '@/components/layout/NotificationsBell';

interface Folder {
  id: string;
  name: string;
  path: string;
  unreadCount: number;
  totalCount?: number;
  type?: string; // 'MAIL' | 'CONTACTS' | 'CALENDAR' | 'TASKS' | 'BRIEFCASE'
}

interface SidebarProps {
  folders?: Folder[];
  activeFolderId?: string;
  onFolderSelect: (folderId: string) => void;
  onCompose?: () => void;
  onCreateFolder?: (name: string) => Promise<void>;
  onDeleteFolder?: (folderId: string) => Promise<void>;
}

// All built-in Zimbra folder paths — user-created folders have paths not in this set
const BUILTIN_PATHS = new Set([
  '/Inbox', '/Trash', '/Sent', '/Drafts', '/Archive', '/Starred',
  '/Junk', '/Spam', '/Contacts', '/Calendar', '/Tasks', '/Briefcase',
  '/Chats', '/Emailed Contacts',
]);

const SYSTEM_FOLDERS = [
  { id: 'inbox',   name: 'Inbox',   icon: Inbox,    path: '/Inbox',   iconBg: 'bg-blue-500' },
  { id: 'sent',    name: 'Sent',    icon: Send,     path: '/Sent',    iconBg: 'bg-emerald-500' },
  { id: 'drafts',  name: 'Drafts',  icon: FileText, path: '/Drafts',  iconBg: 'bg-orange-400' },
  { id: 'archive', name: 'Archive', icon: Archive,  path: '/Archive', iconBg: 'bg-slate-400' },
  { id: 'trash',   name: 'Trash',   icon: Trash2,   path: '/Trash',   iconBg: 'bg-rose-500' },
];

const LABEL_COLORS = [
  'bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-pink-500',
];

function getLabelColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length];
}

function FolderIcon({ icon: Icon, bg }: { icon: React.ElementType; bg: string }) {
  return (
    <div className={cn('w-[18px] h-[18px] rounded-[4px] flex items-center justify-center shrink-0', bg)}>
      <Icon className="w-2.5 h-2.5 text-white" />
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  unread,
  active,
  onClick,
  iconBg,
  comingSoon,
  tourId,
}: {
  icon: React.ElementType;
  label: string;
  unread?: number;
  active?: boolean;
  onClick?: () => void;
  iconBg?: string;
  comingSoon?: boolean;
  tourId?: string;
}) {
  return (
    <button
      data-tour={tourId}
      onClick={comingSoon ? undefined : onClick}
      disabled={comingSoon}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] transition-all duration-100 group relative',
        active
          ? 'bg-primary/10 text-primary font-medium'
          : comingSoon
          ? 'text-foreground/28 cursor-not-allowed select-none'
          : 'text-foreground/65 hover:bg-muted/50 hover:text-foreground',
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full" />
      )}
      {iconBg ? (
        <FolderIcon icon={Icon} bg={iconBg} />
      ) : (
        <Icon className={cn(
          'w-4 h-4 shrink-0',
          active ? 'text-primary' : comingSoon ? 'text-foreground/20' : 'text-muted-foreground/50 group-hover:text-foreground/70',
        )} />
      )}
      <span className="flex-1 text-left truncate">{label}</span>
      {comingSoon ? (
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/35 tracking-wide">
          Soon
        </span>
      ) : (!!unread && unread > 0 && (
        <span className={cn(
          'text-[11px] font-medium px-1.5 py-0.5 rounded-md tabular-nums',
          active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
        )}>
          {unread > 99 ? '99+' : unread}
        </span>
      ))}
    </button>
  );
}

export default function Sidebar({ folders = [], activeFolderId, onFolderSelect, onCompose, onCreateFolder, onDeleteFolder }: SidebarProps) {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const [loggingOut, setLoggingOut] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [savingFolder, setSavingFolder] = useState(false);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [tourActive, setTourActive] = useState(false);
  const [calDragOver, setCalDragOver] = useState(false);
  const [tasksDragOver, setTasksDragOver] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirmStore((s) => s.confirm);

  const handleMailNavDrop = (target: 'calendar' | 'tasks') => (e: React.DragEvent) => {
    e.preventDefault();
    if (target === 'calendar') setCalDragOver(false);
    else setTasksDragOver(false);
    try {
      const raw = e.dataTransfer.getData('application/x-govmail-msg');
      if (!raw) return;
      sessionStorage.setItem(`govmail-prefill-${target}`, raw);
      router.push(`/${target}`);
    } catch { /* ignore */ }
  };

  const handleDeleteFolder = (folderId: string, folderName: string) => {
    if (!onDeleteFolder) return;
    confirm({
      title: `Delete folder "${folderName}"?`,
      description: 'Messages inside will not be deleted.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        setDeletingFolderId(folderId);
        try { await onDeleteFolder!(folderId); } finally { setDeletingFolderId(null); }
      },
    });
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
      router.replace('/login');
    } catch {
      toast.error('Failed to sign out. Please try again.');
      setLoggingOut(false);
    }
  };

  const systemFolders = SYSTEM_FOLDERS.map((sf) => {
    const synced = folders.find((f) => f.path === sf.path);
    // Drafts folder: show total message count (drafts are never "unread")
    // All other folders: show unread count
    const badgeCount = sf.path === '/Drafts'
      ? (synced?.totalCount ?? 0)
      : (synced?.unreadCount ?? 0);
    return { ...sf, id: synced?.id ?? sf.id, unread: badgeCount };
  });

  // Only show user-created MAIL folders — exclude built-in paths AND non-mail view types
  const customFolders = folders.filter(
    (f) => !BUILTIN_PATHS.has(f.path) && (f.type === 'MAIL' || !f.type),
  );

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !onCreateFolder) return;
    setSavingFolder(true);
    try {
      await onCreateFolder(name);
      setNewFolderName('');
      setCreatingFolder(false);
    } catch {
      // parent shows the toast
    } finally {
      setSavingFolder(false);
    }
  };

  const { theme, setTheme } = useThemeStore();
  const THEME_CYCLE: Theme[] = ['light', 'dark', 'system'];
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
  const themeLabel = `Theme: ${theme} (click for ${nextTheme})`;

  const initials = user?.displayName
    ?.split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) ?? user?.email?.[0]?.toUpperCase() ?? '?';

  const displayName = user?.displayName ?? user?.email ?? 'Mailbox';

  return (
    <div className="w-[220px] shrink-0 flex flex-col h-full bg-sidebar border-r border-sidebar-border/60">

      {/* User / org header */}
      <div className="px-3 pt-4 pb-2">
        <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg">
          <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
            <span className="text-[11px] font-bold text-white leading-none">{initials}</span>
          </div>
          <span className="flex-1 text-[13px] font-semibold text-foreground truncate">
            {displayName}
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
        </div>
      </div>

      {/* Compose button */}
      <div className="px-3 pb-3">
        <button
          data-tour="compose"
          onClick={onCompose}
          className="w-full flex items-center gap-2 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-lg text-[13px] font-medium transition-all"
        >
          <Plus className="w-3.5 h-3.5 shrink-0" />
          Compose
        </button>
      </div>

      {/* Folder list */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2">
        <div className="space-y-0.5 pb-4">

          {/* System folders */}
          {systemFolders.map((folder) => (
            <NavItem
              key={folder.id}
              icon={folder.icon}
              label={folder.name}
              unread={folder.unread}
              active={activeFolderId === folder.id}
              onClick={() => onFolderSelect(folder.id)}
              iconBg={folder.iconBg}
              tourId={folder.id === 'inbox' ? 'inbox' : undefined}
            />
          ))}

          {/* Custom / label folders */}
          {(customFolders.length > 0 || onCreateFolder) && (
            <div className="pt-3">
              <div className="flex items-center pr-1">
                <button
                  onClick={() => setLabelsOpen((o) => !o)}
                  className="flex items-center gap-1.5 px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground flex-1 transition-colors"
                >
                  <ChevronDown className={cn('w-3 h-3 transition-transform', !labelsOpen && '-rotate-90')} />
                  Labels
                </button>
                {onCreateFolder && (
                  <button
                    onClick={() => {
                      setCreatingFolder(true);
                      setLabelsOpen(true);
                      setTimeout(() => newFolderInputRef.current?.focus(), 50);
                    }}
                    className="p-1 mb-1.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
                    title="New folder"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                )}
              </div>
              {labelsOpen && (
                <div className="space-y-0.5">
                  {customFolders.map((folder) => (
                    <div key={folder.id} className="group relative">
                      <NavItem
                        icon={FolderOpen}
                        label={folder.name}
                        unread={folder.unreadCount}
                        active={activeFolderId === folder.id}
                        onClick={() => onFolderSelect(folder.id)}
                        iconBg={getLabelColor(folder.name)}
                      />
                      {onDeleteFolder && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder.id, folder.name); }}
                          disabled={deletingFolderId === folder.id}
                          title="Delete folder"
                          className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center justify-center w-5 h-5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  {creatingFolder && (
                    <div className="flex items-center gap-1.5 px-3 py-1">
                      <div className={cn('w-[18px] h-[18px] rounded-[4px] flex items-center justify-center shrink-0', getLabelColor(newFolderName || 'New'))}>
                        <FolderOpen className="w-2.5 h-2.5 text-white" />
                      </div>
                      <input
                        ref={newFolderInputRef}
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCreateFolder();
                          if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); }
                        }}
                        onBlur={() => { if (!savingFolder) { setCreatingFolder(false); setNewFolderName(''); } }}
                        disabled={savingFolder}
                        placeholder="Folder name…"
                        className="flex-1 text-[13px] bg-transparent border-b border-border/60 focus:border-primary outline-none py-0.5 text-foreground placeholder:text-muted-foreground/40"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Divider */}
          <div className="pt-3 pb-1.5 px-1">
            <div className="h-px bg-sidebar-border/50" />
          </div>

          {/* Utility nav */}
          <div
            onDragOver={(e) => { e.preventDefault(); setCalDragOver(true); }}
            onDragLeave={() => setCalDragOver(false)}
            onDrop={handleMailNavDrop('calendar')}
            className={calDragOver ? 'rounded-lg ring-2 ring-primary/40 bg-primary/5' : undefined}
          >
            <NavItem icon={Calendar} label="Calendar" onClick={() => router.push('/calendar')} tourId="calendar-nav" />
          </div>
          <NavItem icon={Users} label="Contacts" onClick={() => router.push('/contacts')} tourId="contacts-nav" />

          {/* Upcoming features */}
          <div
            onDragOver={(e) => { e.preventDefault(); setTasksDragOver(true); }}
            onDragLeave={() => setTasksDragOver(false)}
            onDrop={handleMailNavDrop('tasks')}
            className={tasksDragOver ? 'rounded-lg ring-2 ring-primary/40 bg-primary/5' : undefined}
          >
            <NavItem icon={ListTodo} label="Tasks" onClick={() => router.push('/tasks')} tourId="tasks-nav" />
          </div>
          <NavItem icon={UsersRound} label="Collaboration"  comingSoon />
          <NavItem icon={Newspaper}  label="News"           comingSoon />
        </div>
      </div>

      {/* Footer */}
      <div className="px-2 py-2 border-t border-sidebar-border/50 space-y-0.5">
        <NotificationsBell />
        <NavItem icon={Settings} label="Settings" onClick={() => router.push('/settings')} />
        <button
          onClick={() => setTheme(nextTheme)}
          title={themeLabel}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-foreground/65 hover:bg-muted/50 hover:text-foreground transition-all"
        >
          <ThemeIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 text-left capitalize">Theme: {theme}</span>
        </button>
        <button
          onClick={() => setTourActive(true)}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] text-foreground/65 hover:bg-muted/50 hover:text-foreground transition-all"
        >
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          Take a tour
        </button>
        <NavItem
          icon={LogOut}
          label={loggingOut ? 'Signing out…' : 'Sign out'}
          onClick={handleLogout}
        />
      </div>

      <GlobalConfirmDialog />
      <AppTour active={tourActive} onClose={() => setTourActive(false)} />
    </div>
  );
}
