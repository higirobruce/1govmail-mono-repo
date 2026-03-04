'use client';

import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import Sidebar from './Sidebar';

interface MobileSidebarSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders?: any[];
  activeFolderId?: string;
  onFolderSelect: (folderId: string) => void;
  onCompose?: () => void;
  onCreateFolder?: (name: string) => Promise<void>;
  onDeleteFolder?: (folderId: string) => Promise<void>;
}

export function MobileSidebarSheet({
  open,
  onOpenChange,
  ...sidebarProps
}: MobileSidebarSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="p-0 w-[260px] [&>button]:hidden"
      >
        <SheetTitle className="sr-only">Navigation menu</SheetTitle>
        <Sidebar
          {...sidebarProps}
          onClose={() => onOpenChange(false)}
          className="flex! w-full"
        />
      </SheetContent>
    </Sheet>
  );
}
