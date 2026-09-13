import { useEffect, useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import type { DroppedCsvItem, RendererWorkspace } from './renderer-workspace';

/** Capture file drags across the window, including portals, without intercepting text or grid drags. */
export function FileDropZone({ workspace }: { workspace: RendererWorkspace }) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let depth = 0;
    const reset = () => { depth = 0; setDragging(false); };
    const blocked = () => workspace.snapshot().fatalError !== null ||
      document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null;
    const isFileDrag = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true;
    const prevent = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); };

    function enter(event: DragEvent) {
      if (!isFileDrag(event)) return;
      prevent(event);
      depth += 1;
      setDragging(!blocked() && !workspace.snapshot().isOpening);
    }
    function over(event: DragEvent) {
      if (!isFileDrag(event)) return;
      prevent(event);
      const available = !blocked() && !workspace.snapshot().isOpening;
      if (event.dataTransfer) event.dataTransfer.dropEffect = blocked() ? 'none' : 'copy';
      setDragging(available);
    }
    function leave(event: DragEvent) {
      // Cancelled drags can lose their transfer types before the final leave event.
      if (depth === 0) return;
      prevent(event);
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    }
    function drop(event: DragEvent) {
      if (!isFileDrag(event)) return;
      prevent(event);
      reset();
      if (blocked()) return;
      if (workspace.snapshot().isOpening) {
        toast.add({ title: 'Files are still opening. Try again when finished.', type: 'info' });
        return;
      }
      if (event.dataTransfer) void workspace.openDroppedFiles(readDroppedItems(event.dataTransfer));
    }
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') reset();
    }

    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('dragend', reset, true);
    window.addEventListener('blur', reset);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('dragend', reset, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', keydown);
    };
  }, [workspace]);

  if (!dragging) return null;
  return (
    <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-background/90 p-6" role="status">
      <div className="grid max-w-md justify-items-center gap-3 rounded-xl border bg-card px-8 py-7 text-center shadow-sm">
        <FileSpreadsheet className="size-12 text-primary" aria-hidden="true" />
        <p className="text-2xl font-semibold">Drop files to open</p>
        <p className="text-sm text-muted-foreground">CSV, TSV, or TXT. Each file opens in its own tab.</p>
      </div>
    </div>
  );
}

/** Read the transfer synchronously: browsers hide its files after the drop event returns. */
function readDroppedItems(transfer: DataTransfer): DroppedCsvItem[] {
  const items = Array.from(transfer.items).filter((item) => item.kind === 'file');
  if (items.length === 0) return Array.from(transfer.files, (file) => ({ name: file.name, file }));
  return items.map((item) => {
    const entry = item.webkitGetAsEntry();
    const file = item.getAsFile();
    return { name: entry?.name ?? file?.name ?? 'Dropped item', file: entry?.isDirectory ? null : file };
  });
}
