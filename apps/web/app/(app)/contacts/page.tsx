'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { api } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import {
  Search, Plus, User, Mail, Phone, Building2, Briefcase,
  Pencil, Trash2, X, Check, Loader2, ChevronLeft, UsersRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ContactEmail  { email: string; type: string; primary?: boolean }
interface ContactPhone  { number: string; type: string }

interface Contact {
  id: string;
  zimbraId: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  nickname: string | null;
  company: string | null;
  jobTitle: string | null;
  emails: ContactEmail[];
  phones: ContactPhone[];
  notes: string | null;
  photoUrl: string | null;
  tags: string[];
}

interface ContactGroup {
  id: string;
  name: string;
  description: string | null;
  members: Array<{ email: string; name?: string }>;
  createdAt: string;
}

type FormMode = 'view' | 'create' | 'edit';
type Tab = 'contacts' | 'groups';

const EMPTY_FORM = {
  firstName: '', lastName: '', nickname: '', company: '', jobTitle: '',
  email: '', email2: '', email3: '',
  phone: '', mobile: '', homePhone: '',
  notes: '',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function contactDisplayName(c: Contact): string {
  return c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.emails[0]?.email || '(No name)';
}

function contactInitials(c: Contact): string {
  const name = contactDisplayName(c);
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
}

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-pink-500',
];
function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = id.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// ── Contact avatar ─────────────────────────────────────────────────────────────

function Avatar({ contact, size = 'md' }: { contact: Contact; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'sm' ? 'w-8 h-8 text-xs' : size === 'lg' ? 'w-14 h-14 text-lg' : 'w-10 h-10 text-sm';
  return (
    <div className={cn('rounded-full flex items-center justify-center shrink-0 font-semibold text-white', sz, avatarColor(contact.id))}>
      {contactInitials(contact)}
    </div>
  );
}

// ── Field row in detail view ───────────────────────────────────────────────────

function DetailField({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 py-2">
      <Icon className="w-4 h-4 text-muted-foreground/40 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground/50 uppercase tracking-wider mb-0.5">{label}</p>
        <p className="text-sm text-foreground break-all">{value}</p>
      </div>
    </div>
  );
}

// ── Form field ─────────────────────────────────────────────────────────────────

function FormField({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
      />
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ContactsPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [hydrated, setHydrated] = useState(false);

  const [tab, setTab] = useState<Tab>('contacts');

  // ── Contacts state ──────────────────────────────────────────────────────────
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [formMode, setFormMode] = useState<FormMode>('view');
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── Groups state ────────────────────────────────────────────────────────────
  const [groups, setGroups] = useState<ContactGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<ContactGroup | null>(null);
  const [groupMode, setGroupMode] = useState<FormMode>('view');
  const [groupName, setGroupName] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [groupMembers, setGroupMembers] = useState<Array<{ email: string; name?: string }>>([]);
  const [memberInput, setMemberInput] = useState('');
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupDeleting, setGroupDeleting] = useState(false);

  const confirm = useConfirmStore((s) => s.confirm);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── Load contacts (sync=true on first load) ─────────────────────────────────
  const loadContacts = useCallback(async (q?: string, sync = false) => {
    setLoading(true);
    try {
      const data = await api.contacts.getAll(q, sync);
      setContacts(data as Contact[]);
    } catch (err: any) {
      toast.error('Failed to load contacts', { description: err?.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    loadContacts(undefined, true);
  }, [hydrated, isAuthenticated, loadContacts]);

  // ── Debounced search ────────────────────────────────────────────────────────
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      loadContacts(search.trim() || undefined, false);
    }, 280);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [search, loadContacts]);

  // ── Load groups ─────────────────────────────────────────────────────────────
  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const data = await api.contacts.groups.getAll();
      setGroups(data as ContactGroup[]);
    } catch (err: any) {
      toast.error('Failed to load groups', { description: err?.message });
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'groups' && hydrated && isAuthenticated) loadGroups();
  }, [tab, hydrated, isAuthenticated, loadGroups]);

  // ── Open edit form ──────────────────────────────────────────────────────────
  const openEdit = (c: Contact) => {
    const primaryEmail = c.emails.find(e => e.primary)?.email ?? c.emails[0]?.email ?? '';
    const email2 = c.emails[1]?.email ?? '';
    const email3 = c.emails[2]?.email ?? '';
    const workPhone   = c.phones.find(p => p.type === 'work')?.number ?? '';
    const mobilePhone = c.phones.find(p => p.type === 'mobile')?.number ?? '';
    const homePhone   = c.phones.find(p => p.type === 'home')?.number ?? '';
    setForm({
      firstName: c.firstName ?? '',
      lastName:  c.lastName  ?? '',
      nickname:  c.nickname  ?? '',
      company:   c.company   ?? '',
      jobTitle:  c.jobTitle  ?? '',
      email:     primaryEmail,
      email2,
      email3,
      phone:     workPhone,
      mobile:    mobilePhone,
      homePhone,
      notes:     c.notes ?? '',
    });
    setSelectedContact(c);
    setFormMode('edit');
  };

  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setSelectedContact(null);
    setFormMode('create');
  };

  // ── Save contact (create or update) ────────────────────────────────────────
  const handleSave = async () => {
    if (!form.firstName && !form.lastName && !form.email) {
      toast.error('Please fill in at least a name or email');
      return;
    }
    setSaving(true);
    try {
      if (formMode === 'create') {
        const created = await api.contacts.create(form) as Contact;
        setContacts(prev => [created, ...prev]);
        setSelectedContact(created);
        toast.success('Contact created');
      } else if (formMode === 'edit' && selectedContact) {
        const updated = await api.contacts.update(selectedContact.id, form) as Contact;
        setContacts(prev => prev.map(c => c.id === updated.id ? updated : c));
        setSelectedContact(updated);
        toast.success('Contact updated');
      }
      setFormMode('view');
    } catch (err: any) {
      toast.error('Failed to save contact', { description: err?.message });
    } finally {
      setSaving(false);
    }
  };

  // ── Delete contact ──────────────────────────────────────────────────────────
  const handleDelete = (c: Contact) => {
    confirm({
      title: `Delete "${contactDisplayName(c)}"?`,
      description: 'This contact will be permanently deleted.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        setDeleting(true);
        try {
          await api.contacts.delete(c.id);
          setContacts(prev => prev.filter(x => x.id !== c.id));
          if (selectedContact?.id === c.id) {
            setSelectedContact(null);
            setFormMode('view');
          }
          toast.success('Contact deleted');
        } catch (err: any) {
          toast.error('Failed to delete contact', { description: err?.message });
        } finally {
          setDeleting(false);
        }
      },
    });
  };

  // ── Group handlers ──────────────────────────────────────────────────────────
  const openCreateGroup = () => {
    setGroupName('');
    setGroupDesc('');
    setGroupMembers([]);
    setMemberInput('');
    setSelectedGroup(null);
    setGroupMode('create');
  };

  const openEditGroup = (g: ContactGroup) => {
    setGroupName(g.name);
    setGroupDesc(g.description ?? '');
    setGroupMembers([...g.members]);
    setMemberInput('');
    setSelectedGroup(g);
    setGroupMode('edit');
  };

  const addMember = () => {
    const email = memberInput.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    if (groupMembers.some(m => m.email === email)) {
      toast.error('Already in group');
      return;
    }
    setGroupMembers(prev => [...prev, { email }]);
    setMemberInput('');
  };

  const removeMember = (email: string) => {
    setGroupMembers(prev => prev.filter(m => m.email !== email));
  };

  const handleSaveGroup = async () => {
    if (!groupName.trim()) {
      toast.error('Group name is required');
      return;
    }
    setGroupSaving(true);
    try {
      if (groupMode === 'create') {
        const created = await api.contacts.groups.create({
          name: groupName.trim(),
          description: groupDesc.trim() || undefined,
          members: groupMembers,
        }) as ContactGroup;
        setGroups(prev => [created, ...prev]);
        setSelectedGroup(created);
        toast.success('Group created');
      } else if (groupMode === 'edit' && selectedGroup) {
        const updated = await api.contacts.groups.update(selectedGroup.id, {
          name: groupName.trim(),
          description: groupDesc.trim() || undefined,
          members: groupMembers,
        }) as ContactGroup;
        setGroups(prev => prev.map(g => g.id === updated.id ? updated : g));
        setSelectedGroup(updated);
        toast.success('Group updated');
      }
      setGroupMode('view');
    } catch (err: any) {
      toast.error('Failed to save group', { description: err?.message });
    } finally {
      setGroupSaving(false);
    }
  };

  const handleDeleteGroup = (g: ContactGroup) => {
    confirm({
      title: `Delete group "${g.name}"?`,
      description: 'The group will be removed. Contacts will not be deleted.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        setGroupDeleting(true);
        try {
          await api.contacts.groups.delete(g.id);
          setGroups(prev => prev.filter(x => x.id !== g.id));
          if (selectedGroup?.id === g.id) {
            setSelectedGroup(null);
            setGroupMode('view');
          }
          toast.success('Group deleted');
        } catch (err: any) {
          toast.error('Failed to delete group', { description: err?.message });
        } finally {
          setGroupDeleting(false);
        }
      },
    });
  };

  const setF = (key: keyof typeof EMPTY_FORM) => (v: string) =>
    setForm(prev => ({ ...prev, [key]: v }));

  if (!hydrated) return null;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />

      {/* ── Left panel ── */}
      <div className="w-72 shrink-0 flex flex-col border-r border-border/50 h-full bg-card/50">
        <div className="px-4 pt-4 pb-3 border-b border-border/40 space-y-2.5">
          <div className="flex items-center justify-between">
            <h1 className="text-sm font-semibold text-foreground">Contacts</h1>
            <Button
              size="sm" variant="ghost"
              onClick={tab === 'groups' ? openCreateGroup : openCreate}
              className="h-7 w-7 p-0 text-primary hover:bg-primary/10"
              title={tab === 'groups' ? 'New group' : 'New contact'}
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 p-0.5 rounded-lg bg-muted/40">
            <button
              onClick={() => setTab('contacts')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-[12px] font-medium transition-all',
                tab === 'contacts'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground/60 hover:text-foreground',
              )}
            >
              <User className="w-3.5 h-3.5" />
              All
            </button>
            <button
              onClick={() => setTab('groups')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-[12px] font-medium transition-all',
                tab === 'groups'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground/60 hover:text-foreground',
              )}
            >
              <UsersRound className="w-3.5 h-3.5" />
              Groups
            </button>
          </div>

          {tab === 'contacts' && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts…"
                className="pl-8 h-8 text-xs bg-muted/30 border-border/50"
              />
            </div>
          )}
        </div>

        <ScrollArea className="flex-1 min-h-0">
          {tab === 'contacts' ? (
            loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
              </div>
            ) : contacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <User className="w-8 h-8 text-muted-foreground/20 mb-2" />
                <p className="text-xs text-muted-foreground/50">
                  {search ? 'No contacts found' : 'No contacts yet'}
                </p>
              </div>
            ) : (
              <div className="py-1">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setSelectedContact(c); setFormMode('view'); }}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                      selectedContact?.id === c.id
                        ? 'bg-primary/8 border-l-2 border-primary'
                        : 'hover:bg-muted/40 border-l-2 border-transparent',
                    )}
                  >
                    <Avatar contact={c} size="sm" />
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground truncate">
                        {contactDisplayName(c)}
                      </p>
                      {c.company && (
                        <p className="text-[11px] text-muted-foreground/55 truncate">{c.company}</p>
                      )}
                      {!c.company && c.emails[0] && (
                        <p className="text-[11px] text-muted-foreground/55 truncate">{c.emails[0].email}</p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : (
            /* Groups list */
            groupsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
              </div>
            ) : groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                <UsersRound className="w-8 h-8 text-muted-foreground/20 mb-2" />
                <p className="text-xs text-muted-foreground/50">No groups yet</p>
                <button onClick={openCreateGroup} className="text-xs text-primary hover:underline mt-1">
                  Create one
                </button>
              </div>
            ) : (
              <div className="py-1">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => { setSelectedGroup(g); setGroupMode('view'); }}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                      selectedGroup?.id === g.id
                        ? 'bg-primary/8 border-l-2 border-primary'
                        : 'hover:bg-muted/40 border-l-2 border-transparent',
                    )}
                  >
                    <div className="w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center shrink-0">
                      <UsersRound className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground truncate">{g.name}</p>
                      <p className="text-[11px] text-muted-foreground/55 truncate">
                        {g.members.length} {g.members.length === 1 ? 'member' : 'members'}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )
          )}
        </ScrollArea>
      </div>

      {/* ── Detail / form panel ── */}
      <div className="flex-1 min-w-0 flex flex-col h-full">
        {tab === 'contacts' ? (
          formMode === 'create' || formMode === 'edit' ? (
            /* ── Edit / Create contact form ── */
            <div className="flex flex-col h-full">
              <div className="px-6 py-4 border-b border-border/40 flex items-center gap-3">
                <Button
                  variant="ghost" size="sm"
                  onClick={() => { setFormMode('view'); }}
                  className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <h2 className="text-sm font-semibold text-foreground">
                  {formMode === 'create' ? 'New Contact' : 'Edit Contact'}
                </h2>
                <div className="flex-1" />
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setFormMode('view')}
                  disabled={saving}
                  className="text-muted-foreground/60 hover:text-foreground h-8 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 text-xs gap-1.5"
                >
                  {saving
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                    : <><Check className="w-3.5 h-3.5" /> Save</>}
                </Button>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="px-6 py-5 max-w-md space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <FormField label="First name"  value={form.firstName} onChange={setF('firstName')} placeholder="John" />
                    <FormField label="Last name"   value={form.lastName}  onChange={setF('lastName')}  placeholder="Doe" />
                  </div>
                  <FormField label="Nickname"    value={form.nickname}   onChange={setF('nickname')}   placeholder="Johnny" />
                  <FormField label="Company"     value={form.company}    onChange={setF('company')}    placeholder="Acme Inc." />
                  <FormField label="Job title"   value={form.jobTitle}   onChange={setF('jobTitle')}   placeholder="Engineer" />
                  <div className="pt-2 border-t border-border/30">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-3">Email</p>
                    <div className="space-y-2">
                      <FormField label="Work email"     value={form.email}  onChange={setF('email')}  placeholder="work@company.com"    type="email" />
                      <FormField label="Personal email" value={form.email2} onChange={setF('email2')} placeholder="personal@gmail.com"  type="email" />
                      <FormField label="Other email"    value={form.email3} onChange={setF('email3')} placeholder="other@example.com"   type="email" />
                    </div>
                  </div>
                  <div className="pt-2 border-t border-border/30">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-3">Phone</p>
                    <div className="space-y-2">
                      <FormField label="Work phone"   value={form.phone}     onChange={setF('phone')}     placeholder="+1 555 0100" type="tel" />
                      <FormField label="Mobile"       value={form.mobile}    onChange={setF('mobile')}    placeholder="+1 555 0101" type="tel" />
                      <FormField label="Home phone"   value={form.homePhone} onChange={setF('homePhone')} placeholder="+1 555 0102" type="tel" />
                    </div>
                  </div>
                  <div className="pt-2 border-t border-border/30">
                    <FormField label="Notes" value={form.notes} onChange={setF('notes')} placeholder="Additional notes…" />
                  </div>
                </div>
              </ScrollArea>
            </div>
          ) : selectedContact ? (
            /* ── Contact detail view ── */
            <div className="flex flex-col h-full">
              <div className="px-6 py-4 border-b border-border/40 flex items-center gap-3">
                <h2 className="text-sm font-semibold text-foreground flex-1 truncate">
                  {contactDisplayName(selectedContact)}
                </h2>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => openEdit(selectedContact)}
                  className="h-8 px-3 text-xs text-muted-foreground/60 hover:text-foreground gap-1.5"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </Button>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => handleDelete(selectedContact)}
                  disabled={deleting}
                  className="h-8 px-3 text-xs text-muted-foreground/60 hover:text-destructive gap-1.5"
                >
                  {deleting
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5" />}
                  Delete
                </Button>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="px-6 py-6">
                  <div className="flex items-center gap-4 mb-6">
                    <Avatar contact={selectedContact} size="lg" />
                    <div>
                      <h3 className="text-xl font-semibold text-foreground">
                        {contactDisplayName(selectedContact)}
                      </h3>
                      {selectedContact.jobTitle && (
                        <p className="text-sm text-muted-foreground/60 mt-0.5">
                          {selectedContact.jobTitle}{selectedContact.company ? ` · ${selectedContact.company}` : ''}
                        </p>
                      )}
                      {!selectedContact.jobTitle && selectedContact.company && (
                        <p className="text-sm text-muted-foreground/60 mt-0.5">{selectedContact.company}</p>
                      )}
                    </div>
                  </div>

                  <div className="divide-y divide-border/30">
                    {selectedContact.emails.map((e, i) => (
                      <DetailField
                        key={i}
                        icon={Mail}
                        label={e.primary ? 'Work email' : e.type === 'personal' ? 'Personal email' : 'Email'}
                        value={e.email}
                      />
                    ))}
                    {selectedContact.phones.map((p, i) => (
                      <DetailField
                        key={i}
                        icon={Phone}
                        label={p.type === 'work' ? 'Work phone' : p.type === 'mobile' ? 'Mobile' : 'Home phone'}
                        value={p.number}
                      />
                    ))}
                    {selectedContact.company && (
                      <DetailField icon={Building2} label="Company" value={selectedContact.company} />
                    )}
                    {selectedContact.jobTitle && (
                      <DetailField icon={Briefcase} label="Job title" value={selectedContact.jobTitle} />
                    )}
                    {selectedContact.notes && (
                      <DetailField icon={User} label="Notes" value={selectedContact.notes} />
                    )}
                  </div>
                </div>
              </ScrollArea>
            </div>
          ) : (
            /* ── Empty state ── */
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
              <div className="w-16 h-16 rounded-2xl bg-muted/40 flex items-center justify-center">
                <User className="w-8 h-8 text-muted-foreground/25" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground/60">Select a contact</p>
                <p className="text-xs text-muted-foreground/40 mt-1">
                  or{' '}
                  <button onClick={openCreate} className="text-primary hover:underline">
                    create a new one
                  </button>
                </p>
              </div>
            </div>
          )
        ) : (
          /* ── Groups tab right panel ── */
          groupMode === 'create' || groupMode === 'edit' ? (
            /* Group form */
            <div className="flex flex-col h-full">
              <div className="px-6 py-4 border-b border-border/40 flex items-center gap-3">
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setGroupMode('view')}
                  className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <h2 className="text-sm font-semibold text-foreground">
                  {groupMode === 'create' ? 'New Group' : 'Edit Group'}
                </h2>
                <div className="flex-1" />
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setGroupMode('view')}
                  disabled={groupSaving}
                  className="text-muted-foreground/60 hover:text-foreground h-8 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveGroup}
                  disabled={groupSaving}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 text-xs gap-1.5"
                >
                  {groupSaving
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                    : <><Check className="w-3.5 h-3.5" /> Save</>}
                </Button>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="px-6 py-5 max-w-lg space-y-5">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Group name</Label>
                    <Input
                      value={groupName}
                      onChange={(e) => setGroupName(e.target.value)}
                      placeholder="e.g. Finance Team"
                      className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground/60 uppercase tracking-wider">Description <span className="normal-case text-muted-foreground/40">(optional)</span></Label>
                    <Input
                      value={groupDesc}
                      onChange={(e) => setGroupDesc(e.target.value)}
                      placeholder="What is this group for?"
                      className="h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
                    />
                  </div>

                  <div className="pt-1 border-t border-border/30">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-3">Members</p>

                    {/* Add member input */}
                    <div className="flex gap-2 mb-3">
                      <Input
                        value={memberInput}
                        onChange={(e) => setMemberInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMember(); } }}
                        placeholder="email@example.com"
                        type="email"
                        className="flex-1 h-8 text-sm bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={addMember}
                        className="h-8 px-3 shrink-0"
                        title="Add member (Enter)"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </Button>
                    </div>

                    {/* Member chips */}
                    {groupMembers.length === 0 ? (
                      <p className="text-xs text-muted-foreground/40 py-2">No members yet — add emails above.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {groupMembers.map((m) => (
                          <span
                            key={m.email}
                            className="flex items-center gap-1 px-2 py-1 rounded-full bg-muted/50 border border-border/50 text-[12px] text-foreground/80"
                          >
                            <Mail className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                            {m.email}
                            <button
                              onClick={() => removeMember(m.email)}
                              className="ml-0.5 text-muted-foreground/40 hover:text-destructive transition-colors"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </ScrollArea>
            </div>
          ) : selectedGroup ? (
            /* Group detail view */
            <div className="flex flex-col h-full">
              <div className="px-6 py-4 border-b border-border/40 flex items-center gap-3">
                <h2 className="text-sm font-semibold text-foreground flex-1 truncate">{selectedGroup.name}</h2>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => openEditGroup(selectedGroup)}
                  className="h-8 px-3 text-xs text-muted-foreground/60 hover:text-foreground gap-1.5"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </Button>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => handleDeleteGroup(selectedGroup)}
                  disabled={groupDeleting}
                  className="h-8 px-3 text-xs text-muted-foreground/60 hover:text-destructive gap-1.5"
                >
                  {groupDeleting
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5" />}
                  Delete
                </Button>
              </div>

              <ScrollArea className="flex-1 min-h-0">
                <div className="px-6 py-6">
                  {/* Group header */}
                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 rounded-2xl bg-violet-500/15 flex items-center justify-center shrink-0">
                      <UsersRound className="w-7 h-7 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div>
                      <h3 className="text-xl font-semibold text-foreground">{selectedGroup.name}</h3>
                      {selectedGroup.description && (
                        <p className="text-sm text-muted-foreground/60 mt-0.5">{selectedGroup.description}</p>
                      )}
                      <p className="text-[12px] text-muted-foreground/40 mt-1">
                        {selectedGroup.members.length} {selectedGroup.members.length === 1 ? 'member' : 'members'}
                      </p>
                    </div>
                  </div>

                  {/* Member list */}
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-3">Members</p>
                    {selectedGroup.members.length === 0 ? (
                      <p className="text-sm text-muted-foreground/40">No members in this group.</p>
                    ) : (
                      <div className="space-y-1">
                        {selectedGroup.members.map((m) => (
                          <div
                            key={m.email}
                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/30 transition-colors"
                          >
                            <div className="w-7 h-7 rounded-full bg-muted/60 flex items-center justify-center shrink-0">
                              <Mail className="w-3.5 h-3.5 text-muted-foreground/50" />
                            </div>
                            <div className="min-w-0">
                              {m.name && <p className="text-[13px] font-medium text-foreground truncate">{m.name}</p>}
                              <p className="text-[12px] text-muted-foreground/65 truncate">{m.email}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </ScrollArea>
            </div>
          ) : (
            /* Groups empty state */
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
              <div className="w-16 h-16 rounded-2xl bg-muted/40 flex items-center justify-center">
                <UsersRound className="w-8 h-8 text-muted-foreground/25" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground/60">Select a group</p>
                <p className="text-xs text-muted-foreground/40 mt-1">
                  or{' '}
                  <button onClick={openCreateGroup} className="text-primary hover:underline">
                    create a new one
                  </button>
                </p>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
