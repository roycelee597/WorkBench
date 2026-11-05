import { validate, version } from "uuid";
import type { SqlDatabase, SqlStatement } from "../db/database";
import { BaseRepository } from "./base-repository";
import type { JsonValue, RepositoryContext, Setting, SettingFields } from "./models";
import { isJsonValue, settingDefinition } from "./record-codecs";
import { insertStatement } from "./sql-statements";

export class SettingsRepository extends BaseRepository<Setting, SettingFields> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, settingDefinition);
  }
  async getValue(key: string): Promise<JsonValue | undefined> {
    return (await this.read('"key" = ? AND deleted_at IS NULL AND purged_at IS NULL', [key]))[0]
      ?.value;
  }
  valueStatement(key: string, value: JsonValue, now: number): SqlStatement {
    if (!key || !isJsonValue(value)) throw new Error("设置键或 JSON 值无效");
    const statement = insertStatement("settings", {
      id: this.context.newId(),
      created_at: now,
      updated_at: now,
      deleted_at: null,
      device_id: this.context.deviceId,
      deletion_group_id: null,
      purged_at: null,
      key,
      value: JSON.stringify(value),
    });
    statement.query +=
      ' ON CONFLICT("key") DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, device_id = excluded.device_id, deleted_at = NULL, deletion_group_id = NULL, purged_at = NULL';
    return statement;
  }
  async setValue(key: string, value: JsonValue): Promise<void> {
    if (key === "device_id") throw new Error("设备标识不能通过普通设置修改");
    await this.db.batch([this.valueStatement(key, value, this.context.now())]);
  }
  async claimAutostartPrompt(): Promise<boolean> {
    const statement = this.valueStatement("autostart_prompted", true, this.context.now());
    statement.query +=
      " WHERE settings.value != 'true' OR settings.deleted_at IS NOT NULL OR settings.purged_at IS NOT NULL";
    return ((await this.db.batch([statement]))[0] ?? 0) > 0;
  }
  async ensureDeviceId(): Promise<string> {
    const statement = this.valueStatement("device_id", this.context.deviceId, this.context.now());
    statement.query =
      statement.query.slice(0, statement.query.indexOf(" ON CONFLICT")) +
      ' ON CONFLICT("key") DO NOTHING';
    await this.db.batch([statement]);
    const id = await this.getValue("device_id");
    if (typeof id !== "string" || !validate(id) || version(id) !== 7)
      throw new Error("持久化设备标识无效");
    return id;
  }
  override async softDelete(id: string): Promise<boolean> {
    const record = await this.findAny(id);
    if (record?.key === "device_id") throw new Error("设备标识不能删除");
    return super.softDelete(id);
  }
  override async purgeContent(id: string): Promise<boolean> {
    const record = await this.findAny(id);
    if (record?.key === "device_id") throw new Error("设备标识不能清空");
    return super.purgeContent(id);
  }
}
