import { Button } from "@workbench/ui";
import type { AiMessageRecord } from "../../../../apps/desktop/src/core/repositories/ai-messages";
import type { AiStore } from "../ai-store";

const labels = {
  pending: "已失效",
  saved: "已保存",
  cancelled: "已取消",
  failed: "保存失败",
  expired: "已失效",
};

export function ArchivedMessage({ record, store }: { record: AiMessageRecord; store: AiStore }) {
  const opening = store((state) => state.openingReference === record.id);
  if (record.role !== "card") return <p className="ai-response-text">{record.text}</p>;
  const target = record.status === "saved" ? record.payload.target : undefined;
  return (
    <section className="space-y-2 rounded-xl border border-border p-4" aria-label={record.text}>
      <h2 className="font-semibold">{record.text}</h2>
      <p>{labels[record.status]}</p>
      {record.status === "pending" && (
        <p className="ai-message-note">重启后无法继续确认这张卡片，请重新发起操作。</p>
      )}
      {target && (
        <Button
          size="sm"
          variant="outline"
          disabled={opening}
          onClick={() => void store.getState().openLocalTarget(target, record.id)}
        >
          查看
        </Button>
      )}
    </section>
  );
}
