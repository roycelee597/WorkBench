import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { validate, version, v7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { AI_HISTORY_ENABLED_KEY } from "../src/core/repositories/ai-messages";
import { TRASH_RETENTION_MS } from "../src/core/repositories/trash-cleaner";
import { fixture, type MemoryDatabase } from "./memory-database";

const databases: MemoryDatabase[] = [];
async function setup() {
  const test = await fixture();
  databases.push(test.db);
  return test;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("AI 对话仓库", () => {
  it("保存受限的本机消息字段，卡片目标和状态可更新", async () => {
    const { data, db, clock } = await setup();
    const user = (await data.aiMessages.append({ role: "user", text: "创建一条日程" }))!;
    expect(validate(user.id) && version(user.id)).toBe(7);
    expect(user).toMatchObject({
      created_at: clock.now,
      updated_at: clock.now,
      deleted_at: null,
      device_id: data.deviceId,
      role: "user",
      text: "创建一条日程",
      payload: {},
      status: null,
    });
    const card = (await data.aiMessages.append({
      role: "card",
      text: "新建日程",
      payload: { kind: "create" },
      status: "pending",
    }))!;
    const target = { kind: "event" as const, eventId: v7(), originalStart: null };
    clock.now++;
    expect(
      await data.aiMessages.updateCard(card.id, {
        payload: { kind: "create", target },
        status: "saved",
      }),
    ).toBe(true);
    expect(await data.aiMessages.get(card.id)).toMatchObject({
      updated_at: clock.now,
      text: "新建日程",
      payload: { kind: "create", target },
      status: "saved",
    });
    expect(
      await data.aiMessages.updateCard(user.id, { payload: { kind: "create" }, status: "saved" }),
    ).toBe(false);
    await data.aiMessages.append({ role: "assistant", text: "纯文本 <b>不是标签</b>" });
    await data.aiMessages.append({ role: "error", text: "连接失败" });
    await data.aiMessages.append({ role: "results" });
    const unsafe = {
      role: "card" as const,
      text: "无效载荷",
      status: "pending" as const,
      payload: { kind: "create" as const, draft: { title: "禁止保存的草稿值" } },
    };
    await expect(data.aiMessages.append(unsafe)).rejects.toThrow();
    await expect(
      data.aiMessages.updateCard(card.id, {
        status: "saved",
        payload: { kind: "create", target: { ...target, eventId: "e1" } },
      }),
    ).rejects.toThrow();
    expect(
      await db.select(
        "SELECT role, text, payload, status FROM ai_messages ORDER BY created_at, id",
      ),
    ).toEqual([
      { role: "user", text: "创建一条日程", payload: "{}", status: null },
      {
        role: "card",
        text: "新建日程",
        payload: JSON.stringify({ kind: "create", target }),
        status: "saved",
      },
      { role: "assistant", text: "纯文本 <b>不是标签</b>", payload: "{}", status: null },
      { role: "error", text: "连接失败", payload: "{}", status: null },
      {
        role: "results",
        text: "读取结果仅保留在当时的对话中，请重新查询。",
        payload: "{}",
        status: null,
      },
    ]);
  });

  it("仅加载最新 200 条活跃消息，同毫秒保持 UUIDv7 写入顺序", async () => {
    const { data } = await setup();
    for (let i = 0; i < 203; i++) await data.aiMessages.append({ role: "user", text: String(i) });
    const last = (await data.aiMessages.append({ role: "assistant", text: "已清空" }))!;
    expect(await data.aiMessages.softDelete(last.id)).toBe(true);
    const messages = await data.aiMessages.listRecent();
    expect(messages).toHaveLength(200);
    expect(messages.map((row) => row.text)).toEqual(
      Array.from({ length: 200 }, (_, index) => String(index + 3)),
    );
  });

  it("关闭保存后拒绝追加和状态更新，保留已保存内容且仍可清空", async () => {
    const { data, clock, db } = await setup();
    const pending = (await data.aiMessages.append({
      role: "card",
      text: "删除提醒",
      payload: { kind: "delete" },
      status: "pending",
    }))!;
    await data.settings.setValue(AI_HISTORY_ENABLED_KEY, false);
    expect(await data.aiMessages.append({ role: "assistant", text: "关闭后的消息" })).toBeNull();
    expect(
      await data.aiMessages.updateCard(pending.id, {
        payload: { kind: "delete" },
        status: "cancelled",
      }),
    ).toBe(false);
    expect(await data.aiMessages.listRecent()).toEqual([pending]);
    clock.now += 2;
    expect(await data.aiMessages.clear()).toBe(1);
    expect(await data.aiMessages.listRecent()).toEqual([]);
    expect(await data.aiMessages.listDeleted()).toEqual([]);
    expect((await db.select("SELECT * FROM ai_messages"))[0]).toMatchObject({
      id: pending.id,
      role: "card",
      device_id: data.deviceId,
      created_at: pending.created_at,
      updated_at: clock.now,
      deleted_at: clock.now,
      purged_at: clock.now,
      text: "",
      payload: "{}",
      status: null,
    });
    await data.settings.setValue(AI_HISTORY_ENABLED_KEY, true);
    expect(
      await data.aiMessages.updateCard(pending.id, {
        payload: { kind: "delete" },
        status: "saved",
      }),
    ).toBe(false);
    expect(await data.aiMessages.clear()).toBe(0);
    expect(await data.aiMessages.append({ role: "assistant", text: "恢复保存" })).toMatchObject({
      text: "恢复保存",
    });
  });

  it("跟随回收站事务清理严格早于 30 天的记录并保留墓碑", async () => {
    const { data, clock, db } = await setup();
    const old = (await data.aiMessages.append({ role: "assistant", text: "过期对话" }))!;
    clock.now++;
    const boundary = (await data.aiMessages.append({ role: "user", text: "正好 30 天" }))!;
    clock.now = boundary.created_at + TRASH_RETENTION_MS;
    db.failAt = 5;
    await expect(data.trash.purgeExpired()).rejects.toThrow("模拟事务失败");
    expect(await data.aiMessages.listRecent()).toHaveLength(2);
    expect(await data.settings.getValue("last_trash_purge_at")).toBeUndefined();
    db.failAt = null;
    await data.trash.purgeExpired();
    expect((await data.aiMessages.listRecent()).map((row) => row.id)).toEqual([boundary.id]);
    expect((await db.select("SELECT * FROM ai_messages WHERE id = ?", [old.id]))[0]).toMatchObject({
      created_at: old.created_at,
      deleted_at: clock.now,
      purged_at: clock.now,
      text: "",
      payload: "{}",
      status: null,
    });
    expect(await data.settings.getValue("last_trash_purge_at")).toBe(clock.now);
  });
});

describe("0004 AI 对话迁移", () => {
  it("从 0003 升级后，保留原有业务记录并创建新表、索引和角色约束", () => {
    const db = new DatabaseSync(":memory:");
    const directory = new NodeURL("../src-tauri/migrations/", import.meta.url);
    const apply = (filename: string) =>
      db.exec(readFileSync(new NodeURL(filename, directory), "utf8"));
    try {
      db.exec("PRAGMA foreign_keys = ON");
      apply("0001_init.sql");
      apply("0002_reminder_scheduler.sql");
      apply("0003_finance.sql");
      db.exec(`INSERT INTO memos (id, created_at, updated_at, device_id, title)
        VALUES ('seed', 1, 1, 'local', '原有备忘');`);
      apply("0004_ai.sql");
      expect(db.prepare("SELECT id, title FROM memos").all()).toEqual([
        { id: "seed", title: "原有备忘" },
      ]);
      expect(
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_ai_messages_created'").get(),
      ).toEqual({ sql: expect.stringContaining("WHERE deleted_at IS NULL") });
      const insert = db.prepare(
        "INSERT INTO ai_messages (id, created_at, updated_at, device_id, role) VALUES (?, 1, 1, 'local', ?)",
      );
      expect(() => insert.run("invalid", "tool")).toThrow(/CHECK constraint failed/);
      insert.run("valid", "assistant");
      expect(
        db
          .prepare("SELECT role, text, payload, status, deleted_at, purged_at FROM ai_messages")
          .all(),
      ).toEqual([
        {
          role: "assistant",
          text: "",
          payload: "{}",
          status: null,
          deleted_at: null,
          purged_at: null,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
