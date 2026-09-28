import { z } from "zod";

export const locatorSpecSchema = z.union([
  z.string().min(1),
  z.object({ selector: z.string().min(1) }),
  z.object({ text: z.string().min(1), exact: z.boolean().optional() }),
  z.object({ role: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional() }),
  z.object({ label: z.string().min(1), exact: z.boolean().optional() }),
  z.object({ testId: z.string().min(1) }),
]);

export type LocatorSpec = z.infer<typeof locatorSpecSchema>;

export const pointSchema = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof pointSchema>;

export const targetSchema = z.union([locatorSpecSchema, pointSchema]);
export type Target = z.infer<typeof targetSchema>;

const actionBase = {
  timeout_ms: z.number().int().positive().optional(),
};

const responseTriggerSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("navigate"), url: z.string().min(1), wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).optional(), ...actionBase }),
  z.object({ op: z.literal("click"), target: locatorSpecSchema, button: z.enum(["left", "right", "middle"]).optional(), force: z.boolean().optional(), no_wait_after: z.boolean().optional(), ...actionBase }),
  z.object({ op: z.literal("press"), key: z.string().min(1), target: locatorSpecSchema.optional(), ...actionBase }),
  z.object({ op: z.literal("eval"), expression: z.string().min(1), arg: z.any().optional(), ...actionBase }),
]);

export const batchActionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("navigate"), url: z.string().min(1), wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).optional(), ...actionBase }),
  z.object({ op: z.literal("reload"), wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).optional(), ...actionBase }),
  z.object({ op: z.literal("click"), target: locatorSpecSchema, button: z.enum(["left", "right", "middle"]).optional(), force: z.boolean().optional(), no_wait_after: z.boolean().optional(), ...actionBase }),
  z.object({ op: z.literal("dblclick"), target: locatorSpecSchema, button: z.enum(["left", "right", "middle"]).optional(), force: z.boolean().optional(), no_wait_after: z.boolean().optional(), ...actionBase }),
  z.object({ op: z.literal("fill"), target: locatorSpecSchema, value: z.string(), ...actionBase }),
  z.object({ op: z.literal("focus"), target: locatorSpecSchema, ...actionBase }),
  z.object({ op: z.literal("press"), key: z.string().min(1), target: locatorSpecSchema.optional(), ...actionBase }),
  z.object({ op: z.literal("hover"), target: locatorSpecSchema, ...actionBase }),
  z.object({ op: z.literal("wait"), ms: z.number().int().nonnegative().max(30000) }),
  z.object({ op: z.literal("wait_for"), target: locatorSpecSchema, state: z.enum(["attached", "detached", "visible", "hidden"]).optional(), ...actionBase }),
  z.object({ op: z.literal("scroll_into_view"), target: locatorSpecSchema, ...actionBase }),
  z.object({ op: z.literal("scroll"), dx: z.number().default(0), dy: z.number().default(0) }),
  z.object({ op: z.literal("mouse_move"), x: z.number(), y: z.number(), steps: z.number().int().positive().max(100).optional() }),
  z.object({ op: z.literal("mouse_down"), button: z.enum(["left", "right", "middle"]).optional() }),
  z.object({ op: z.literal("mouse_up"), button: z.enum(["left", "right", "middle"]).optional() }),
  z.object({ op: z.literal("drag"), from: targetSchema, to: targetSchema, steps: z.number().int().positive().max(100).optional(), ...actionBase }),
  z.object({ op: z.literal("text"), target: locatorSpecSchema, ...actionBase }),
  z.object({ op: z.literal("html"), target: locatorSpecSchema.optional(), ...actionBase }),
  z.object({ op: z.literal("attr"), target: locatorSpecSchema, name: z.string().min(1), ...actionBase }),
  z.object({ op: z.literal("count"), target: locatorSpecSchema, ...actionBase }),
  z.object({ op: z.literal("bounding_box"), target: locatorSpecSchema, ...actionBase }),
  z.object({ op: z.literal("screenshot"), full_page: z.boolean().optional() }),
  z.object({ op: z.literal("eval"), expression: z.string().min(1), arg: z.any().optional(), ...actionBase }),
  z.object({
    op: z.literal("wait_response"),
    url_contains: z.string().min(1),
    method: z.string().optional(),
    body: z.enum(["json", "text", "none"]).default("json"),
    trigger: responseTriggerSchema,
    ...actionBase,
  }),
  z.object({ op: z.literal("local_storage_get"), key: z.string() }),
  z.object({ op: z.literal("local_storage_set"), key: z.string(), value: z.string() }),
  z.object({ op: z.literal("local_storage_remove"), key: z.string() }),
  z.object({ op: z.literal("local_storage_clear") }),
  z.object({ op: z.literal("clipboard_read"), mode: z.enum(["browser", "system"]).default("system"), grant_permission: z.boolean().optional() }),
  z.object({ op: z.literal("clipboard_write"), mode: z.enum(["browser", "system"]).default("system"), text: z.string(), grant_permission: z.boolean().optional() }),
  z.object({ op: z.literal("dialog_accept"), prompt_text: z.string().optional() }),
  z.object({ op: z.literal("dialog_dismiss") }),
]);

export type BatchAction = z.infer<typeof batchActionSchema>;

