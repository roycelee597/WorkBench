import type { AiTarget, RefEntry, RefTable } from "./action-types";

export const REF_TTL_MS = 30 * 60 * 1_000;
const prefixes: Record<AiTarget["kind"], string> = { event: "e", reminder: "r", memo: "m" };

export class MemoryRefTable implements RefTable {
  private readonly entries = new Map<string, RefEntry>();
  private readonly counts: Record<AiTarget["kind"], number> = { event: 0, reminder: 0, memo: 0 };
  private readonly now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.now = now;
  }

  issue(target: AiTarget, snapshot: Pick<RefEntry, "updatedAt" | "related">): string {
    const issuedAt = this.now();
    if (
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(snapshot.updatedAt) ||
      !Object.hasOwn(prefixes, target.kind)
    )
      throw new Error("AI 引用时间或类型无效");
    for (const [ref, entry] of this.entries) {
      if (issuedAt < entry.issuedAt || issuedAt - entry.issuedAt >= REF_TTL_MS)
        this.entries.delete(ref);
    }
    const ref = `${prefixes[target.kind]}${++this.counts[target.kind]}`;
    this.entries.set(ref, {
      ref,
      target: structuredClone(target),
      ...structuredClone(snapshot),
      issuedAt,
    });
    return ref;
  }

  resolve(ref: string, kind: AiTarget["kind"]): RefEntry | null {
    const entry = this.entries.get(ref);
    if (!entry) return null;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < entry.issuedAt || now - entry.issuedAt >= REF_TTL_MS) {
      this.entries.delete(ref);
      return null;
    }
    return entry.target.kind === kind ? structuredClone(entry) : null;
  }

  clear(): void {
    this.entries.clear();
    // 不回退计数，避免仍显示在旧消息里的 ref 被新目标复用。
  }
}
