import { create } from "zustand";
import type { NotificationMessage } from "../core/scheduler/scheduler";

export interface ReminderNotice extends NotificationMessage {
  key: string;
}
interface NoticeState {
  notices: ReminderNotice[];
  push: (message: NotificationMessage) => void;
  dismiss: (key: string) => void;
}
export const useReminderNotices = create<NoticeState>((set) => ({
  notices: [],
  push: (message) =>
    set((state) => {
      const key = `${message.kind}:${message.occurrenceIds.join(":")}`;
      const notice = { ...message, occurrenceIds: [...message.occurrenceIds], key };
      return { notices: [...state.notices.filter((row) => row.key !== key), notice] };
    }),
  dismiss: (key) => set((state) => ({ notices: state.notices.filter((row) => row.key !== key) })),
}));
