import { Button, Dialog } from "@workbench/ui";
import type { AiStore } from "../ai-store";

export function ClearHistoryDialog({
  store,
  open,
  setOpen,
  onCleared,
}: {
  store: AiStore;
  open: boolean;
  setOpen: (open: boolean) => void;
  onCleared?: () => void;
}) {
  const clearing = store((state) => state.clearingHistory);
  const busy = store((state) => state.pending || state.proposalBusy);
  const error = store((state) => state.historyError);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!clearing) setOpen(next);
      }}
      title="清空对话记录？"
      description="本机保存的对话和当前对话都会清空，无法恢复。"
      footer={
        <>
          <Button variant="outline" disabled={clearing} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            disabled={busy || clearing}
            onClick={async () => {
              if (!(await store.getState().clear())) return;
              setOpen(false);
              onCleared?.();
            }}
          >
            {clearing ? "正在清空…" : "确认清空"}
          </Button>
        </>
      }
    >
      {open && error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </Dialog>
  );
}
