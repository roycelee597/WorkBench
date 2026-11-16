import { useRef, useState } from "react";
import { Button, Dialog } from "@workbench/ui";
import type { AiTarget } from "../../../../apps/desktop/src/core/ai/action-types";
import type { AiCreateDraft } from "../ai-create-model";
import { generalAiActions } from "../ai-actions";
import { AiCreateFields } from "./AiCreatePreview";

const operations = {
  event: "calendar_create_event",
  reminder: "reminders_create",
  memo: "memos_create",
};
const titles = { event: "新建日程", reminder: "新建提醒", memo: "新建备忘录" };

// 与卡片共用字段和本地校验；进入表单本身不会创建任何记录。
export function CreateDraftDialog({
  initial,
  open,
  onClose,
  onSaved,
}: {
  initial: AiCreateDraft;
  open: boolean;
  onClose: () => void;
  onSaved: (target?: AiTarget) => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const writing = useRef(false);
  async function save() {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setErrors([]);
    await Promise.resolve();
    let target: AiTarget | undefined;
    try {
      const action = generalAiActions.actions.find((item) => item.name === operations[draft.type]);
      if (!action?.validate || !action.execute) throw new Error("新建表单尚未就绪");
      const issues = action.validate(draft);
      if (issues.length) {
        setErrors(issues);
        writing.current = false;
        setBusy(false);
        return;
      }
      const result = await action.execute(structuredClone(draft));
      target = result.target;
    } catch {
      setErrors(["本地保存失败，草稿仍保留，请重试保存。"]);
      writing.current = false;
      setBusy(false);
      return;
    }
    // 写入成功后保持终态锁；定位失败只能重试查看，不能再次创建。
    setSaved(true);
    setBusy(false);
    try {
      onSaved(target);
    } catch {
      setErrors(["内容已保存，暂时无法打开。请到对应页面查看。"]);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
      title={titles[draft.type]}
      description={
        saved ? "内容已保存，可关闭表单。" : "草稿尚未保存。修改后点击保存，才会写入工作台。"
      }
      className="calendar-form-dialog"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {saved ? "关闭" : "取消"}
          </Button>
          <Button type="submit" form="create-draft-form" disabled={busy || saved}>
            {saved ? "已保存" : busy ? "正在保存…" : "保存"}
          </Button>
        </>
      }
    >
      <form
        id="create-draft-form"
        className="event-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <AiCreateFields draft={draft} onChange={setDraft} readOnly={busy || saved} autoFocus />
        {errors.length > 0 && (
          <ul className="text-destructive" role="alert">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
      </form>
    </Dialog>
  );
}
