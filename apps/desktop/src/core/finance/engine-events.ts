import { z } from "zod";

const day = z.string().regex(/^\d{8}$/);
const stage = z.enum(["calendar", "stock_basic", "index", "recent", "backfill", "compute"]);
const diagnostic = { code: z.string(), message: z.string(), retryable: z.boolean() };

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), engine_version: z.string(), schema_version: z.int() }),
  z.object({ type: z.literal("stage"), stage }),
  z
    .object({
      type: z.literal("progress"),
      stage,
      done: z.int().nonnegative(),
      total: z.int().nonnegative(),
      current: day,
      eta_seconds: z.int().nonnegative(),
    })
    .refine((event) => event.done <= event.total),
  z.object({ type: z.literal("indicator_updated"), indicator: z.string(), through: day }),
  z.object({
    type: z.literal("warning"),
    ...diagnostic,
    dataset: z.string().optional(),
    trade_date: day.optional(),
  }),
  z.object({ type: z.literal("error"), ...diagnostic }),
  z.object({
    type: z.literal("done"),
    status: z.enum(["ok", "partial", "failed"]),
    new_dates: z.record(z.string(), z.array(day)),
    through: z.record(z.string(), day),
  }),
  z.object({ type: z.literal("engine_exit"), code: z.int().nullable(), cancelled: z.boolean() }),
]);

export type EngineEvent = z.infer<typeof eventSchema>;
export type FinanceDone = Extract<EngineEvent, { type: "done" }>;
export type FinanceStage = z.infer<typeof stage>;

export function parseEngineEvent(payload: unknown): EngineEvent | undefined {
  if (typeof payload !== "string") return undefined;
  try {
    const data: unknown = JSON.parse(payload);
    const result = eventSchema.safeParse(data);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
