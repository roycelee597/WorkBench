import { z } from "zod";
import type { SqlDatabase, SqlRow, SqlStatement } from "../db/database";
import { BaseRepository } from "./base-repository";
import type { RecordMetadata, RepositoryContext } from "./models";
import { metadata, text, type RecordDefinition } from "./record-codecs";
import { updateStatement } from "./sql-statements";

export const AI_HISTORY_ENABLED_KEY = "ai.history_enabled";
const HISTORY_LIMIT = 200;
const RESULTS_SUMMARY = "读取结果仅保留在当时的对话中，请重新查询。";
const enabledCondition = `NOT EXISTS (SELECT 1 FROM settings WHERE "key" = ? AND value = 'false' AND deleted_at IS NULL AND purged_at IS NULL)`;
const active = "deleted_at IS NULL AND purged_at IS NULL";

const cardStatus = z.enum(["pending", "saved", "cancelled", "failed", "expired"]);
const messageRole = z.enum(["user", "assistant", "card", "results", "error"]);
const target = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("event"),
    eventId: z.uuidv7(),
    originalStart: z.number().int().nullable(),
  }),
  z.strictObject({
    kind: z.literal("reminder"),
    reminderId: z.uuidv7(),
    occurrenceId: z.uuidv7().nullable(),
  }),
  z.strictObject({ kind: z.literal("memo"), memoId: z.uuidv7() }),
]);
const cardPayload = z.strictObject({
  kind: z.enum(["create", "update", "delete", "candidate"]),
  target: target.optional(),
});
const messageInput = z.union([
  z.strictObject({ role: z.enum(["user", "assistant", "error"]), text: z.string() }),
  z.strictObject({ role: z.literal("results") }),
  z.strictObject({
    role: z.literal("card"),
    text: z.string(),
    status: cardStatus,
    payload: cardPayload,
  }),
]);
const cardPatch = z.strictObject({
  text: z.string().optional(),
  status: cardStatus,
  payload: cardPayload,
});

export type AiMessageInput = z.input<typeof messageInput>;
export type AiCardStatus = z.infer<typeof cardStatus>;
export type AiCardPayload = z.infer<typeof cardPayload>;
export type AiCardPatch = z.input<typeof cardPatch>;
type AiMessageRole = AiMessageInput["role"];
interface MessageFields {
  role: AiMessageRole;
  text: string;
  payload: string;
  status: AiCardStatus | null;
}
type PlainMessage<Role> = {
  role: Role;
  text: string;
  status: null;
  payload: Record<string, never>;
};
export type AiMessageRecord = RecordMetadata &
  (
    | PlainMessage<Exclude<AiMessageRole, "card">>
    | { role: "card"; text: string; status: AiCardStatus; payload: AiCardPayload }
  );
type MessageRow = AiMessageRecord | (RecordMetadata & PlainMessage<"card">);

const definition: RecordDefinition<MessageRow> = {
  table: "ai_messages",
  columns: ["role", "text", "payload", "status"],
  order: "created_at, id",
  cleared: { text: "", payload: "{}", status: null },
  decode(row) {
    const fields = metadata(row);
    const role = messageRole.parse(text(row, "role"));
    const content = text(row, "text");
    if (role !== "card" || fields.purged_at !== null)
      return { ...fields, role, text: content, status: null, payload: {} };
    return {
      ...fields,
      role,
      text: content,
      status: cardStatus.parse(text(row, "status")),
      payload: cardPayload.parse(JSON.parse(text(row, "payload"))),
    };
  },
};

function liveRecord(row: MessageRow): AiMessageRecord {
  if (row.role === "card" && row.status === null) throw new Error("这张对话卡片已清空");
  return row;
}

export class AiMessagesRepository extends BaseRepository<MessageRow, MessageFields> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, definition);
  }

  override list(): Promise<AiMessageRecord[]> {
    return this.listRecent();
  }

  override async get(id: string): Promise<AiMessageRecord | null> {
    const row = await super.get(id);
    return row && liveRecord(row);
  }

  async listRecent(): Promise<AiMessageRecord[]> {
    const rows = await this.db.select<SqlRow>(
      `SELECT * FROM ai_messages WHERE ${active} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [HISTORY_LIMIT],
    );
    return rows.reverse().map((row) => liveRecord(definition.decode(row)));
  }

  async append(value: AiMessageInput): Promise<AiMessageRecord | null> {
    const input = messageInput.parse(value);
    const fields: MessageFields = {
      role: input.role,
      text: input.role === "results" ? RESULTS_SUMMARY : input.text,
      payload: JSON.stringify(input.role === "card" ? input.payload : {}),
      status: input.role === "card" ? input.status : null,
    };
    const { id, statement } = this.prepareInsert(fields, {
      where: enabledCondition,
      values: [AI_HISTORY_ENABLED_KEY],
    });
    const [changed] = await this.db.batch([statement]);
    return changed ? this.get(id) : null;
  }

  async updateCard(id: string, value: AiCardPatch): Promise<boolean> {
    const patch = cardPatch.parse(value);
    const [changed] = await this.db.batch([
      updateStatement(
        definition.table,
        {
          ...(patch.text === undefined ? {} : { text: patch.text }),
          status: patch.status,
          payload: JSON.stringify(patch.payload),
          updated_at: this.context.now(),
          device_id: this.context.deviceId,
        },
        `id = ? AND role = 'card' AND ${active} AND ${enabledCondition}`,
        [id, AI_HISTORY_ENABLED_KEY],
      ),
    ]);
    return Boolean(changed);
  }

  async clear(): Promise<number> {
    const [changed] = await this.db.batch([this.tombstone("1 = 1", [], this.context.now())]);
    return changed ?? 0;
  }

  override async softDelete(id: string): Promise<boolean> {
    const [changed] = await this.db.batch([this.tombstone("id = ?", [id], this.context.now())]);
    return Boolean(changed);
  }

  purgeExpiredStatement(cutoff: number, now: number): SqlStatement {
    return this.tombstone("created_at < ?", [cutoff], now);
  }

  private tombstone(where: string, values: Array<string | number>, now: number): SqlStatement {
    // 对话没有恢复入口，软删除和清空内容在同一条语句里完成。
    return updateStatement(
      definition.table,
      {
        ...definition.cleared,
        deleted_at: now,
        purged_at: now,
        updated_at: now,
        device_id: this.context.deviceId,
      },
      `purged_at IS NULL AND (${where})`,
      values,
    );
  }
}
