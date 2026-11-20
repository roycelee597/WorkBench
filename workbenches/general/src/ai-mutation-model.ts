import type {
  AiTarget,
  DiffRow,
  SeriesScope,
} from "../../../apps/desktop/src/core/ai/action-types";
import { parseLocalTime } from "../../../apps/desktop/src/core/ai/local-time";
import { aiRepeatSummary, type AiCreateDraft } from "./ai-create-model";
import { reminderChoices } from "./calendar-model";
import { priorities } from "./reminder-model";

export type AiMutationKind =
  "event-update" | "event-delete" | "reminder-update" | "reminder-delete";
export interface AiMutationItem {
  id: string;
  target: AiTarget;
  title: string;
  when: string;
  repeating: boolean;
  first: boolean;
}
export interface AiMutationDraft {
  kind: AiMutationKind;
  token: string;
  items: AiMutationItem[];
  selectedIds: string[];
  initial?: AiCreateDraft;
  next?: AiCreateDraft;
}
export function aiMutationWhen(value: string, zone: string): string {
  try {
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: zone }).format(
      parseLocalTime(value, zone),
    );
    return `${value.slice(0, 10)} ${weekday}${value.length > 10 ? ` ${value.slice(11)}` : ""}`;
  } catch {
    return value || "无到期时间";
  }
}
export const selectedMutationItems = (draft: AiMutationDraft) =>
  draft.items.filter((item) => draft.selectedIds.includes(item.id));

export function aiMutationDiff(draft: AiMutationDraft): DiffRow[] {
  const before = draft.initial;
  const after = draft.next;
  if (!before || !after) return [];
  const rows: DiffRow[] = [];
  const add = (field: string, label: string, left: string, right: string) => {
    if (left !== right) rows.push({ field, label, before: left || "无", after: right || "无" });
  };
  if (before.type === "event" && after.type === "event") {
    const a = before.form,
      b = after.form;
    add("title", "标题", a.title, b.title);
    add("notes", "备注", a.notes, b.notes);
    add("start", "开始", aiMutationWhen(a.start, a.zone), aiMutationWhen(b.start, b.zone));
    add("end", "结束", aiMutationWhen(a.end, a.zone), aiMutationWhen(b.end, b.zone));
    add("allDay", "全天", a.allDay ? "是" : "否", b.allDay ? "是" : "否");
    const remind = (value: number | null) =>
      reminderChoices.find((choice) => choice.value === value)?.label ?? "不提醒";
    add("reminder", "提前提醒", remind(a.reminder), remind(b.reminder));
    add("repeat", "重复", aiRepeatSummary(a.repeat), aiRepeatSummary(b.repeat));
  }
  if (before.type === "reminder" && after.type === "reminder") {
    const a = before.form,
      b = after.form;
    add("title", "标题", a.title, b.title);
    add("notes", "备注", a.notes, b.notes);
    add(
      "due",
      "到期时间",
      a.timed ? aiMutationWhen(a.due, a.zone) : "无到期时间",
      b.timed ? aiMutationWhen(b.due, b.zone) : "无到期时间",
    );
    add("priority", "优先级", priorities[a.priority] ?? "无", priorities[b.priority] ?? "无");
    add(
      "repeat",
      "重复",
      a.timed ? aiRepeatSummary(a.repeat) : "不重复",
      b.timed ? aiRepeatSummary(b.repeat) : "不重复",
    );
  }
  return rows;
}

export function aiDeleteDestination(draft: AiMutationDraft, scope?: SeriesScope): string[] {
  return [
    ...new Set(
      selectedMutationItems(draft).map((item) => {
        if (draft.kind === "reminder-delete")
          return item.repeating
            ? "将删除整个重复提醒及其实例，进入回收站，30 天内可恢复。"
            : "提醒及其实例将进入回收站，30 天内可恢复。";
        if (!item.repeating) return "日程和关联的提前提醒将进入回收站，30 天内可恢复。";
        if (!scope) return "请选择重复日程的删除范围。";
        if (scope === "all" || (scope === "following" && item.first))
          return "将删除整个系列，进入回收站；已有例外和关联提醒一起进入回收站，30 天内可恢复。";
        if (scope === "this")
          return "将在规则中跳过这一次，原系列不进回收站；对应的已有例外及关联提醒会软删除、进入回收站。";
        return "原规则将截断，不进回收站；受影响的已有例外及关联提醒进入回收站。";
      }),
    ),
  ];
}
