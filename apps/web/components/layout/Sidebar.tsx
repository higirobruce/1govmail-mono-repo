'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { useConfirmStore } from '@/stores/confirm.store';
import {
  Inbox, Send, FileText, Trash2, Archive,
  ChevronDown, LogOut, Settings, Plus, X,
  Calendar, Users, FolderOpen,
  ListTodo, UsersRound, Newspaper, Sparkles,
  Sun, Moon, Monitor, BookOpen, ShieldAlert,
  MoreHorizontal, Pencil, CloudOff, Loader2,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { useOffline } from '@/lib/offline/provider';
import { cn } from '@/lib/utils';
import { GlobalConfirmDialog } from '@/components/ui/confirm-dialog';
import { AppTour } from '@/components/tour/AppTour';
import { useThemeStore, type Theme } from '@/stores/theme.store';
import { useUIStore } from '@/stores/ui.store';
import { NotificationsBell } from '@/components/layout/NotificationsBell';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface FolderMenuState {
  x: number;
  y: number;
  folder: { id: string; name: string; isSystem?: boolean };
}

function FolderContextMenu({
  state,
  onClose,
  onRename,
  onEmpty,
  onDelete,
}: {
  state: FolderMenuState;
  onClose: () => void;
  onRename?: (id: string, name: string) => void;
  onEmpty?: (id: string, name: string) => void;
  onDelete?: (id: string, name: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(state.y, window.innerHeight - 160),
    left: Math.min(state.x, window.innerWidth - 180),
    zIndex: 9999,
  };

  const { folder } = state;

  return createPortal(
    <div
      ref={menuRef}
      style={style}
      className="bg-card border border-border/50 rounded-xl shadow-lg p-1.5 min-w-[160px]"
    >
      {!folder.isSystem && onRename && (
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[0.8125rem] text-foreground/80 hover:bg-muted/60 hover:text-foreground transition-colors text-left"
          onMouseDown={(e) => { e.preventDefault(); onClose(); onRename(folder.id, folder.name); }}
        >
          <Pencil className="w-3.5 h-3.5 shrink-0" />
          Rename
        </button>
      )}
      {onEmpty && (
        <button
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[0.8125rem] text-foreground/80 hover:bg-muted/60 hover:text-foreground transition-colors text-left"
          onMouseDown={(e) => { e.preventDefault(); onClose(); onEmpty(folder.id, folder.name); }}
        >
          <Trash2 className="w-3.5 h-3.5 shrink-0" />
          Empty folder
        </button>
      )}
      {!folder.isSystem && onDelete && (
        <>
          {(onRename || onEmpty) && (
            <div className="my-1 h-px bg-border/50 mx-1" />
          )}
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[0.8125rem] text-destructive hover:bg-destructive/10 transition-colors text-left"
            onMouseDown={(e) => { e.preventDefault(); onClose(); onDelete(folder.id, folder.name); }}
          >
            <X className="w-3.5 h-3.5 shrink-0" />
            Delete folder
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

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
  onEmptyFolder?: (folderId: string) => Promise<void>;
  onRenameFolder?: (folderId: string, name: string) => Promise<void>;
  /** Called after a nav action on mobile so the parent can close the drawer */
  onClose?: () => void;
  /** Extra classes for the root div — used to override hidden-on-mobile inside Sheet */
  className?: string;
  /** Multi-select label filter: names of label-folders the user has checkboxed
   *  to filter the active list by (matches against `message.tags`). Optional —
   *  when omitted, label rows render without checkboxes. */
  selectedLabelNames?: Set<string>;
  onToggleLabelFilter?: (name: string) => void;
  onClearLabelFilter?: () => void;
}

// All built-in Zimbra folder paths — user-created folders have paths not in this set
const BUILTIN_PATHS = new Set([
  '/Inbox', '/Trash', '/Sent', '/Drafts', '/Archive', '/Starred',
  '/Junk', '/Spam', '/Contacts', '/Calendar', '/Tasks', '/Briefcase',
  '/Chats', '/Emailed Contacts',
]);

// iconBg maps to semantic palette tokens so the sidebar re-themes automatically
// alongside the rest of the chrome (primary = state blue, accent = Rwanda flag
// blue, success = Rwanda green, warning = gold, destructive = crimson).
const SYSTEM_FOLDERS = [
  { id: 'inbox',   name: 'Inbox',   icon: Inbox,       path: '/Inbox',   iconBg: 'bg-primary' },
  { id: 'sent',    name: 'Sent',    icon: Send,        path: '/Sent',    iconBg: 'bg-success' },
  { id: 'drafts',  name: 'Drafts',  icon: FileText,    path: '/Drafts',  iconBg: 'bg-accent' },
  { id: 'archive', name: 'Archive', icon: Archive,     path: '/Archive', iconBg: 'bg-muted-foreground/70' },
  { id: 'junk',    name: 'Spam',    icon: ShieldAlert, path: '/Junk',    iconBg: 'bg-warning' },
  { id: 'trash',   name: 'Trash',   icon: Trash2,      path: '/Trash',   iconBg: 'bg-destructive' },
];

// System folders that can be emptied
const EMPTYABLE_PATHS = new Set(['/Trash', '/Junk']);

// User-created label colors: hashed onto the semantic palette so custom folders
// stay on-brand instead of drifting into arbitrary Tailwind shades.
const LABEL_COLORS = [
  'bg-primary', 'bg-accent', 'bg-success', 'bg-warning',
  'bg-destructive', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5',
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
      title={label}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[0.8125rem] transition-all duration-100 group relative',
        // Icon rail mode (sidebar collapsed): center the icon, drop the text.
        'group-data-[collapsed=true]/sidebar:justify-center group-data-[collapsed=true]/sidebar:px-0',
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
      <span className="flex-1 text-left truncate group-data-[collapsed=true]/sidebar:hidden">{label}</span>
      {comingSoon ? (
        <span className="text-[0.625rem] font-medium px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/35 tracking-wide group-data-[collapsed=true]/sidebar:hidden">
          Soon
        </span>
      ) : (!!unread && unread > 0 && (
        <>
          <span className={cn(
            'text-[0.6875rem] font-medium px-1.5 py-0.5 rounded-md tabular-nums group-data-[collapsed=true]/sidebar:hidden',
            active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
          )}>
            {unread > 99 ? '99+' : unread}
          </span>
          {/* Icon-rail mode: unread shows as a dot on the icon's corner */}
          <span className="hidden group-data-[collapsed=true]/sidebar:block absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-primary" />
        </>
      ))}
    </button>
  );
}

function LabelRow({
  folder,
  active,
  color,
  checked,
  filterEnabled,
  onSelect,
  onToggleFilter,
  onMore,
}: {
  folder: Folder;
  active: boolean;
  color: string;
  checked: boolean;
  filterEnabled: boolean;
  onSelect: () => void;
  onToggleFilter: () => void;
  onMore?: (x: number, y: number) => void;
}) {
  return (
    <div className={cn(
      'w-full flex items-center gap-2.5 pl-3 pr-2 py-1.5 rounded-lg text-[0.8125rem] transition-all duration-100 group relative',
      active ? 'bg-primary/10 text-primary font-medium' : 'text-foreground/65 hover:bg-muted/50 hover:text-foreground',
    )}>
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full" />
      )}

      {/* Color square — also serves as the filter checkbox when filterEnabled */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (filterEnabled) onToggleFilter();
          else onSelect();
        }}
        aria-label={filterEnabled ? (checked ? `Remove ${folder.name} filter` : `Filter by ${folder.name}`) : folder.name}
        aria-pressed={filterEnabled ? checked : undefined}
        className={cn(
          'shrink-0 w-[18px] h-[18px] rounded-[5px] flex items-center justify-center transition-all',
          color,
          filterEnabled && !checked && 'opacity-30 hover:opacity-60',
          checked && 'shadow-[0_0_0_1px_rgba(0,0,0,0.04)]',
        )}
      >
        {checked ? (
          <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M2 6l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : !filterEnabled ? (
          <FolderOpen className="w-2.5 h-2.5 text-white" />
        ) : null}
      </button>

      {/* Label name — navigates */}
      <button
        type="button"
        onClick={onSelect}
        className="flex-1 min-w-0 text-left truncate"
      >
        {folder.name}
      </button>

      {/* Unread count */}
      {!!folder.unreadCount && folder.unreadCount > 0 && (
        <span className={cn(
          'text-[0.6875rem] font-medium px-1.5 py-0.5 rounded-md tabular-nums shrink-0',
          active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
        )}>
          {folder.unreadCount > 99 ? '99+' : folder.unreadCount}
        </span>
      )}

      {/* Overflow menu */}
      {onMore && (
        <button
          className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 pointer-events-none group-hover/folderrow:opacity-100 group-hover/folderrow:pointer-events-auto"
          onClick={(e) => { e.stopPropagation(); onMore(e.clientX, e.clientY); }}
          aria-label="Folder options"
        >
          <MoreHorizontal className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function OfflineStatusPill() {
  const { status } = useOffline();
  if (status.online && status.pending === 0 && status.failed === 0) return null;

  const offline = !status.online;
  const Icon = offline ? CloudOff : Loader2;
  const label = offline
    ? status.pending > 0
      ? `Offline · ${status.pending} queued`
      : 'Offline'
    : `${status.pending} queued`;
  const tone = offline
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-muted-foreground';

  return (
    <div
      title={
        offline
          ? 'You are offline. Pending actions will sync when you reconnect.'
          : 'Pending actions are syncing in the background.'
      }
      className={cn(
        'flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[0.75rem]',
        'group-data-[collapsed=true]/sidebar:justify-center group-data-[collapsed=true]/sidebar:px-0',
        tone,
      )}
    >
      <Icon className={cn('w-3.5 h-3.5 shrink-0', !offline && 'animate-spin')} />
      <span className="flex-1 text-left truncate group-data-[collapsed=true]/sidebar:hidden">{label}</span>
    </div>
  );
}

export default function Sidebar({
  folders = [],
  activeFolderId,
  onFolderSelect,
  onCompose,
  onCreateFolder,
  onDeleteFolder,
  onEmptyFolder,
  onRenameFolder,
  onClose,
  className,
  selectedLabelNames,
  onToggleLabelFilter,
  onClearLabelFilter,
}: SidebarProps) {
  const filterEnabled = !!onToggleLabelFilter;
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [loggingOut, setLoggingOut] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [savingFolder, setSavingFolder] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  const [emptyConfirmFolder, setEmptyConfirmFolder] = useState<{ id: string; name: string } | null>(null);
  const [emptyConfirmInput, setEmptyConfirmInput] = useState('');
  const [emptyingFolder, setEmptyingFolder] = useState(false);
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [tourActive, setTourActive] = useState(false);
  const [calDragOver, setCalDragOver] = useState(false);
  const [tasksDragOver, setTasksDragOver] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirmStore((s) => s.confirm);

  // When no folders are supplied by the parent page (i.e. non-mail pages),
  // fetch them internally so unread counters are always visible.
  const [fetchedFolders, setFetchedFolders] = useState<Folder[]>([]);
  const activeFolders = folders.length > 0 ? folders : fetchedFolders;

  useEffect(() => {
    if (!isAuthenticated || folders.length > 0) return;
    let cancelled = false;
    const load = () => {
      api.mail.getFolders()
        .then((data: any[]) => { if (!cancelled) setFetchedFolders(data); })
        .catch(() => { /* non-fatal */ });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isAuthenticated, folders.length]);

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
      onConfirm: () => onDeleteFolder!(folderId),
    });
  };

  const handleRenameFolder = async () => {
    const name = renameFolderName.trim();
    if (!name || !renamingFolderId || !onRenameFolder) return;
    setSavingRename(true);
    try {
      await onRenameFolder(renamingFolderId, name);
      setRenamingFolderId(null);
      setRenameFolderName('');
    } catch {
      // parent shows toast
    } finally {
      setSavingRename(false);
    }
  };

  const handleEmptyFolder = async () => {
    if (!emptyConfirmFolder || !onEmptyFolder) return;
    setEmptyingFolder(true);
    try {
      await onEmptyFolder(emptyConfirmFolder.id);
      setEmptyConfirmFolder(null);
      setEmptyConfirmInput('');
    } catch {
      // parent shows toast
    } finally {
      setEmptyingFolder(false);
    }
  };

  const openEmptyConfirm = (id: string, name: string) => {
    setEmptyConfirmFolder({ id, name });
    setEmptyConfirmInput('');
  };

  const openRenameInline = (id: string, name: string) => {
    setRenamingFolderId(id);
    setRenameFolderName(name);
    setLabelsOpen(true);
    setTimeout(() => renameInputRef.current?.focus(), 50);
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
    const synced = activeFolders.find((f) => f.path === sf.path);
    // Drafts folder: show total message count (drafts are never "unread")
    // All other folders: show unread count
    const badgeCount = sf.path === '/Drafts'
      ? (synced?.totalCount ?? 0)
      : (synced?.unreadCount ?? 0);
    return { ...sf, id: synced?.id ?? sf.id, unread: badgeCount };
  });

  // Only show user-created MAIL folders — exclude built-in paths AND non-mail view types
  const customFolders = activeFolders.filter(
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
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
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
    <div
      data-collapsed={collapsed}
      className={cn(
        'group/sidebar shrink-0 hidden lg:flex flex-col h-full bg-sidebar border-r border-sidebar-border/60 transition-[width] duration-150',
        collapsed ? 'w-[60px]' : 'w-[220px]',
        className,
      )}
    >

      {/* User / org header + collapse toggle */}
      <div className={cn('pt-4 pb-2', collapsed ? 'px-2' : 'px-3')}>
        <div className={cn('flex items-center gap-2.5 py-1.5 rounded-lg', collapsed ? 'flex-col px-0' : 'px-2')}>
          <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0" title={displayName}>
            <span className="text-[0.6875rem] font-bold text-white leading-none">{initials}</span>
          </div>
          {!collapsed && (
            <span className="flex-1 text-[0.8125rem] font-semibold text-foreground truncate">
              {displayName}
            </span>
          )}
          <button
            onClick={toggleSidebar}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
          >
            {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Compose button */}
      <div className={cn('pb-3', collapsed ? 'px-2' : 'px-3')}>
        <button
          data-tour="compose"
          onClick={() => { onCompose?.(); onClose?.(); }}
          title="Compose"
          className={cn(
            'w-full flex items-center gap-2 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-lg text-[0.8125rem] font-medium transition-all',
            collapsed ? 'justify-center px-0' : 'px-3',
          )}
        >
          <Plus className="w-3.5 h-3.5 shrink-0" />
          {!collapsed && 'Compose'}
        </button>
      </div>

      {/* Folder list */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2">
        <div className="space-y-0.5 pb-4">

          {/* System folders */}
          {systemFolders.map((folder) => {
            const canEmpty = !!onEmptyFolder && EMPTYABLE_PATHS.has(folder.path);
            if (!canEmpty) {
              return (
                <NavItem
                  key={folder.id}
                  icon={folder.icon}
                  label={folder.name}
                  unread={folder.unread}
                  active={activeFolderId === folder.id}
                  onClick={() => { onFolderSelect(folder.id); onClose?.(); }}
                  iconBg={folder.iconBg}
                  tourId={folder.id === 'inbox' ? 'inbox' : undefined}
                />
              );
            }
            return (
              <div
                key={folder.id}
                className="relative group/folderrow"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFolderMenu({ x: e.clientX, y: e.clientY, folder: { id: folder.id, name: folder.name, isSystem: true } });
                }}
              >
                <NavItem
                  icon={folder.icon}
                  label={folder.name}
                  unread={folder.unread}
                  active={activeFolderId === folder.id}
                  onClick={() => { onFolderSelect(folder.id); onClose?.(); }}
                  iconBg={folder.iconBg}
                />
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex items-center justify-center w-5 h-5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 pointer-events-none group-hover/folderrow:opacity-100 group-hover/folderrow:pointer-events-auto"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFolderMenu({ x: e.clientX, y: e.clientY, folder: { id: folder.id, name: folder.name, isSystem: true } });
                  }}
                >
                  <MoreHorizontal className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {/* Custom / label folders — labels need their names; hidden in icon-rail mode */}
          {!collapsed && (customFolders.length > 0 || onCreateFolder) && (
            <div className="pt-3">
              <div className="flex items-center pr-1">
                <button
                  onClick={() => setLabelsOpen((o) => !o)}
                  className="flex items-center gap-1.5 px-3 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground flex-1 transition-colors"
                >
                  <ChevronDown className={cn('w-3 h-3 transition-transform', !labelsOpen && '-rotate-90')} />
                  Labels
                  {filterEnabled && selectedLabelNames && selectedLabelNames.size > 0 && (
                    <span className="ml-1 inline-flex items-center text-[0.625rem] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary normal-case tracking-normal">
                      {selectedLabelNames.size} active
                    </span>
                  )}
                </button>
                {filterEnabled && selectedLabelNames && selectedLabelNames.size > 0 && onClearLabelFilter && (
                  <button
                    onClick={onClearLabelFilter}
                    className="p-1 mb-1.5 rounded text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors"
                    title="Clear filter"
                    aria-label="Clear label filter"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
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
                    <div
                      key={folder.id}
                      className="relative group/folderrow"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (renamingFolderId !== folder.id) {
                          setFolderMenu({ x: e.clientX, y: e.clientY, folder: { id: folder.id, name: folder.name } });
                        }
                      }}
                    >
                      {renamingFolderId === folder.id ? (
                        <div className="flex items-center gap-1.5 px-3 py-1">
                          <div className={cn('w-[18px] h-[18px] rounded-[4px] flex items-center justify-center shrink-0', getLabelColor(renameFolderName || folder.name))}>
                            <FolderOpen className="w-2.5 h-2.5 text-white" />
                          </div>
                          <input
                            ref={renameInputRef}
                            value={renameFolderName}
                            onChange={(e) => setRenameFolderName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRenameFolder();
                              if (e.key === 'Escape') { setRenamingFolderId(null); setRenameFolderName(''); }
                            }}
                            onBlur={() => { if (!savingRename) { setRenamingFolderId(null); setRenameFolderName(''); } }}
                            disabled={savingRename}
                            placeholder="Folder name…"
                            className="flex-1 text-[0.8125rem] bg-transparent border-b border-border/60 focus:border-primary outline-none py-0.5 text-foreground placeholder:text-muted-foreground/40"
                          />
                        </div>
                      ) : (
                        <LabelRow
                          folder={folder}
                          active={activeFolderId === folder.id}
                          color={getLabelColor(folder.name)}
                          checked={!!selectedLabelNames?.has(folder.name)}
                          filterEnabled={filterEnabled}
                          onSelect={() => { onFolderSelect(folder.id); onClose?.(); }}
                          onToggleFilter={() => onToggleLabelFilter?.(folder.name)}
                          onMore={
                            (onDeleteFolder || onEmptyFolder || onRenameFolder)
                              ? (x, y) => setFolderMenu({ x, y, folder: { id: folder.id, name: folder.name } })
                              : undefined
                          }
                        />
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
                        className="flex-1 text-[0.8125rem] bg-transparent border-b border-border/60 focus:border-primary outline-none py-0.5 text-foreground placeholder:text-muted-foreground/40"
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
            <NavItem icon={Calendar} label="Calendar" onClick={() => { router.push('/calendar'); onClose?.(); }} tourId="calendar-nav" />
          </div>
          <NavItem icon={Users} label="Contacts" onClick={() => { router.push('/contacts'); onClose?.(); }} tourId="contacts-nav" />
          <NavItem icon={BookOpen} label="Docs" onClick={() => { router.push('/docs'); onClose?.(); }} tourId="docs-nav" />

          {/* Upcoming features */}
          <div
            onDragOver={(e) => { e.preventDefault(); setTasksDragOver(true); }}
            onDragLeave={() => setTasksDragOver(false)}
            onDrop={handleMailNavDrop('tasks')}
            className={tasksDragOver ? 'rounded-lg ring-2 ring-primary/40 bg-primary/5' : undefined}
          >
            <NavItem icon={ListTodo} label="Tasks" onClick={() => { router.push('/tasks'); onClose?.(); }} tourId="tasks-nav" />
          </div>
          <NavItem icon={UsersRound} label="Collaboration"  comingSoon />
          <NavItem icon={Newspaper}  label="News"           comingSoon />
        </div>
      </div>

      {/* Footer */}
      <div className="px-2 py-2 border-t border-sidebar-border/50 space-y-0.5">
        <OfflineStatusPill />
        <NotificationsBell />
        <NavItem icon={Settings} label="Settings" onClick={() => { router.push('/settings'); onClose?.(); }} />
        <button
          onClick={() => setTheme(nextTheme)}
          title={themeLabel}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[0.8125rem] text-foreground/65 hover:bg-muted/50 hover:text-foreground transition-all group-data-[collapsed=true]/sidebar:justify-center group-data-[collapsed=true]/sidebar:px-0"
        >
          <ThemeIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 text-left capitalize group-data-[collapsed=true]/sidebar:hidden">Theme: {theme}</span>
        </button>
        <button
          onClick={() => setTourActive(true)}
          title="Take a tour"
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[0.8125rem] text-foreground/65 hover:bg-muted/50 hover:text-foreground transition-all group-data-[collapsed=true]/sidebar:justify-center group-data-[collapsed=true]/sidebar:px-0"
        >
          <Sparkles className="w-3.5 h-3.5 shrink-0" />
          <span className="group-data-[collapsed=true]/sidebar:hidden">Take a tour</span>
        </button>
        <NavItem
          icon={LogOut}
          label={loggingOut ? 'Signing out…' : 'Sign out'}
          onClick={handleLogout}
        />
      </div>

      <GlobalConfirmDialog />
      <AppTour active={tourActive} onClose={() => setTourActive(false)} />

      {/* GitHub-style empty folder confirmation dialog */}
      <Dialog
        open={!!emptyConfirmFolder}
        onOpenChange={(open) => {
          if (!open) { setEmptyConfirmFolder(null); setEmptyConfirmInput(''); }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Empty &ldquo;{emptyConfirmFolder?.name}&rdquo;?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground pt-1">
                <p>
                  This action <strong className="text-foreground">cannot be undone</strong>. All messages
                  in <strong className="text-foreground">{emptyConfirmFolder?.name}</strong> will be
                  permanently deleted.
                </p>
                <p>
                  Please type{' '}
                  <strong className="text-foreground font-mono">{emptyConfirmFolder?.name}</strong>{' '}
                  to confirm.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <Input
            value={emptyConfirmInput}
            onChange={(e) => setEmptyConfirmInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && emptyConfirmInput === emptyConfirmFolder?.name) {
                handleEmptyFolder();
              }
            }}
            placeholder={emptyConfirmFolder?.name}
            className="mt-1"
          />
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => { setEmptyConfirmFolder(null); setEmptyConfirmInput(''); }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={emptyConfirmInput !== emptyConfirmFolder?.name || emptyingFolder}
              onClick={handleEmptyFolder}
            >
              {emptyingFolder ? 'Emptying…' : 'Empty folder'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {folderMenu && (
        <FolderContextMenu
          state={folderMenu}
          onClose={() => setFolderMenu(null)}
          onRename={onRenameFolder ? openRenameInline : undefined}
          onEmpty={onEmptyFolder ? openEmptyConfirm : undefined}
          onDelete={onDeleteFolder ? (id, name) => { handleDeleteFolder(id, name); } : undefined}
        />
      )}
    </div>
  );
}
