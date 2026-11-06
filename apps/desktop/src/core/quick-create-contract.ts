import { z } from "zod";

const title = z.string().trim().min(1, "请填写标题").max(200, "标题最多 200 字");
const notes = z.string().max(20000, "内容最多 20000 字");
const timestamp = z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000);
const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "时区无效");
export const quickInputSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("memo"), title: z.string().trim().max(200), content: notes })
    .strict()
    .refine((value) => Boolean(value.title || value.content.trim()), "请填写标题或正文"),
  z
    .object({
      type: z.literal("event"),
      title,
      notes,
      start_at: timestamp,
      end_at: timestamp,
      timezone,
      all_day: z.boolean(),
    })
    .strict()
    .refine((value) => value.end_at > value.start_at, "结束时间必须晚于开始时间"),
  z
    .object({ type: z.literal("reminder"), title, notes, due_at: timestamp.nullable(), timezone })
    .strict(),
]);
export type QuickInput = z.infer<typeof quickInputSchema>;
export const quickRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("preferences") }).strict(),
  z.object({ type: z.literal("create"), input: quickInputSchema }).strict(),
]);
export const quickEnvelopeSchema = z
  .object({ id: z.string().uuid(), payload: z.unknown() })
  .strict();
export const quickPreferencesSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]),
    defaultReminder: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type QuickPreferences = z.infer<typeof quickPreferencesSchema>;
export const quickReplySchema = z
  .object({
    id: z.string().uuid(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
      z.object({ ok: z.literal(false), error: z.string().max(500) }).strict(),
    ]),
  })
  .strict();
