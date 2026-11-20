import type {
  AiCardPatch,
  AiCardStatus,
  AiMessageInput,
} from "../../../apps/desktop/src/core/repositories/ai-messages";
import type { AiProposal, AiMessage } from "./ai-store";

const labels: Readonly<Record<string, string>> = {
  calendar_create_event: "新建日程",
  calendar_update_event: "修改日程",
  calendar_delete_event: "删除日程",
  reminders_create: "新建提醒",
  reminders_update: "修改提醒",
  reminders_delete: "删除提醒",
  memos_create: "新建备忘录",
};

function cardKind(name: string) {
  if (name.endsWith("_delete") || name.includes("_delete_")) return "delete";
  if (name.endsWith("_update") || name.includes("_update_")) return "update";
  return "create";
}

function storedStatus(status: AiProposal["status"]): AiCardStatus {
  switch (status) {
    case "saving":
    case "transferring":
      return "pending";
    case "transferred":
      return "expired";
    default:
      return status;
  }
}

export function historyCard(proposal: AiProposal): AiCardPatch {
  const status = storedStatus(proposal.status);
  const target = status === "saved" ? proposal.result?.target : undefined;
  return {
    status,
    payload: { kind: cardKind(proposal.actionName), ...(target ? { target } : {}) },
  };
}

export function historyInput(message: AiMessage): AiMessageInput | null {
  if (message.role === "user") return { role: "user", text: message.text };
  const event = message.event;
  switch (event.type) {
    case "archived":
      return null;
    case "text":
      return { role: "assistant", text: event.text };
    case "results":
      return { role: "results" };
    case "warning":
    case "error":
      return { role: "error", text: event.message };
    case "prepared":
      if (event.prepared.type !== "proposal" && event.prepared.type !== "choose") return null;
      return {
        role: "card",
        text: labels[event.actionName] ?? "AI 操作",
        status: "pending",
        payload: {
          kind: event.prepared.type === "choose" ? "candidate" : cardKind(event.actionName),
        },
      };
  }
}
