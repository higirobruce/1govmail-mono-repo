import { create } from 'zustand';

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  confirm: (opts: ConfirmOptions) => void;
  close: () => void;
}

export const useConfirmStore = create<ConfirmState>((set) => ({
  open: false,
  title: '',
  onConfirm: () => {},
  confirm: (opts) => set({ ...opts, open: true }),
  close: () => set({ open: false }),
}));
