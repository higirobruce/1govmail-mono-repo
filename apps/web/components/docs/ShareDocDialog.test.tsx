import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { ShareDocDialog } from './ShareDocDialog';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    docs: {
      getOne: vi.fn(),
      update: vi.fn(),
      invites: { list: vi.fn() },
      share: { enable: vi.fn(), disable: vi.fn() },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const getOne = api.docs.getOne as unknown as ReturnType<typeof vi.fn>;
const update = api.docs.update as unknown as ReturnType<typeof vi.fn>;
const listInvites = api.docs.invites.list as unknown as ReturnType<typeof vi.fn>;

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', title: 'Q4 plan', emoji: null, parentId: null, position: 0,
  isFavorite: false, tags: [], coverColor: null, shareToken: null,
  isShared: false, orgVisible: true,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

const renderDialog = (props: Record<string, unknown> = {}) =>
  render(
    <ShareDocDialog
      docId="d1"
      open
      onOpenChange={() => {}}
      isShared={false}
      shareToken={null}
      onShareChange={() => {}}
      {...props}
    />,
  );

const orgSwitch = () => screen.getByRole('switch', { name: /organisation digest/i });

describe('ShareDocDialog — organisation digest toggle', () => {
  beforeEach(() => {
    getOne.mockReset(); update.mockReset(); listInvites.mockReset();
    getOne.mockResolvedValue(doc());
    update.mockResolvedValue(doc());
    listInvites.mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it('reflects the saved visibility, including when it is off', async () => {
    getOne.mockResolvedValue(doc({ orgVisible: false }));
    renderDialog();
    // Must read the server's value, not assume the default-on.
    await waitFor(() => expect(orgSwitch()).toHaveAttribute('aria-checked', 'false'));
  });

  it('loads visibility even when the document has no public link', async () => {
    // The fetch used to be gated on isShared, which left the switch stuck on
    // its default for every unshared document.
    renderDialog({ isShared: false });
    await waitFor(() => expect(getOne).toHaveBeenCalledWith('d1'));
  });

  it('saves the inverted value when toggled off', async () => {
    renderDialog();
    await waitFor(() => expect(orgSwitch()).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(orgSwitch());

    // Pin the argument: a mock that ignores its input would pass a bare
    // "was called" assertion no matter which value the component sent.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('d1', { orgVisible: false }),
    );
    expect(orgSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('rolls the switch back when the save fails', async () => {
    update.mockRejectedValue(new Error('offline'));
    renderDialog();
    await waitFor(() => expect(orgSwitch()).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(orgSwitch());

    await waitFor(() => expect(orgSwitch()).toHaveAttribute('aria-checked', 'true'));
    expect(update).toHaveBeenCalledWith('d1', { orgVisible: false });
  });

  it('does not let a non-owner change it', async () => {
    renderDialog({ isOwner: false });
    await waitFor(() => expect(orgSwitch()).toBeDisabled());

    fireEvent.click(orgSwitch());
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the switch on when the endpoint omits the field', async () => {
    // List endpoints do not select orgVisible; an undefined must not be read
    // as "hidden" and silently show the owner a switch that is off.
    const { orgVisible: _omitted, ...withoutField } = doc();
    getOne.mockResolvedValue(withoutField);
    renderDialog();
    await waitFor(() => expect(getOne).toHaveBeenCalled());
    expect(orgSwitch()).toHaveAttribute('aria-checked', 'true');
  });
});
