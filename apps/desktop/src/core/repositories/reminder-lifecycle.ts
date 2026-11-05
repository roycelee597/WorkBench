import type { SqlValue } from "../db/database";
import type { RepositoryContext } from "./models";
import { updateStatement } from "./sql-statements";
export function retireReminder(id: string, context: RepositoryContext) {
  const now = context.now();
  const fields: Record<string, SqlValue> = {
    deleted_at: now,
    deletion_group_id: context.newId(),
    updated_at: now,
    device_id: context.deviceId,
  };
  return [
    updateStatement("reminders", fields, "id = ? AND deleted_at IS NULL", [id]),
    updateStatement("reminder_occurrences", fields, "reminder_id = ? AND deleted_at IS NULL", [id]),
  ];
}
