import type { AiTarget } from "../../../apps/desktop/src/core/ai/action-types";
import { generalApi, type GeneralApi } from "./api";
import { workspace, type createWorkspace } from "./workspace-store";

export function createAiTargetNavigation(
  api: Pick<GeneralApi, "eventTarget" | "reminderRecordTarget">,
  targetWorkspace: ReturnType<typeof createWorkspace>,
) {
  return async (target: AiTarget) => {
    if (targetWorkspace.useWorkspace.getState().createDraft)
      throw new Error("请先保存或关闭已打开的新建表单");
    await targetWorkspace.flush();
    const state = targetWorkspace.useWorkspace.getState();
    if (target.kind === "memo") await state.openMemo(target.memoId);
    else if (target.kind === "event")
      await state.openCalendar(await api.eventTarget(target.eventId, target.originalStart));
    else {
      const resolved = await api.reminderRecordTarget(
        target.reminderId,
        target.occurrenceId ?? undefined,
      );
      await state.openReminder(resolved);
    }
    const failure = targetWorkspace.useWorkspace.getState().error;
    if (failure) throw new Error(failure);
  };
}

export const openAiTarget = createAiTargetNavigation(generalApi, workspace);
