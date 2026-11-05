import type { Memo, MemoDraft } from "./api";

export type SaveStatus = "saved" | "pending" | "saving" | "error";
interface Pending {
  draft: MemoDraft;
  revision: number;
}
interface Callbacks {
  save: (id: string, draft: MemoDraft) => Promise<Memo>;
  saved: (memo: Memo, newerDraft: boolean) => void;
  status: (status: SaveStatus, error?: unknown) => void;
}

export class MemoAutosave {
  private pending = new Map<string, Pending>();
  private revisions = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly callbacks: Callbacks) {}
  schedule(id: string, draft: MemoDraft): void {
    const revision = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    this.pending.set(id, { draft: { ...draft, tags: [...draft.tags] }, revision });
    if (this.timer) clearTimeout(this.timer);
    this.callbacks.status("pending");
    this.timer = setTimeout(() => {
      void this.flush().catch(() => undefined);
    }, 500);
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) return this.running.then(() => this.flush());
    if (this.pending.size === 0) return Promise.resolve();
    const operation = this.drain();
    this.running = operation;
    void operation
      .finally(() => {
        this.running = undefined;
      })
      .catch(() => undefined);
    return operation;
  }
  private async drain(): Promise<void> {
    this.callbacks.status("saving");
    while (this.pending.size > 0) {
      const entries = [...this.pending];
      this.pending.clear();
      for (let index = 0; index < entries.length; index++) {
        const [id, pending] = entries[index]!;
        try {
          const memo = await this.callbacks.save(id, pending.draft);
          this.callbacks.saved(memo, this.revisions.get(id) !== pending.revision);
        } catch (error) {
          // 失败草稿保留；保存中发生的新输入优先，不被旧快照覆盖。
          for (const [remainingId, remaining] of entries.slice(index)) {
            if (!this.pending.has(remainingId)) this.pending.set(remainingId, remaining);
          }
          this.callbacks.status("error", error);
          throw error;
        }
      }
    }
    this.callbacks.status("saved");
  }
}
