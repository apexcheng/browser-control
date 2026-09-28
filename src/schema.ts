import { z } from "zod";

const timeoutMs = z.number().int().positive().max(60_000).optional();

export const locatorSpecSchema = z.union([
  z.string().min(1),
  z.object({ by: z.literal("role"), role: z.string().min(1), name: z.string().optional(), exact: z.boolean().optional() }),
  z.object({ by: z.literal("text"), text: z.string(), exact: z.boolean().optional() }),
  z.object({ by: z.literal("label"), text: z.string(), exact: z.boolean().optional() }),
  z.object({ by: z.literal("testId"), value: z.string().min(1) }),
]);

export type LocatorSpec = z.infer<typeof locatorSpecSchema>;

const gotoAction = z.object({
  op: z.literal("goto"),
  url: z.string().url(),
  wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).default("domcontentloaded"),
  timeout_ms: timeoutMs,
});
const clickAction = z.object({ op: z.literal("click"), target: locatorSpecSchema, timeout_ms: timeoutMs });
const dblclickAction = z.object({ op: z.literal("dblclick"), target: locatorSpecSchema, timeout_ms: timeoutMs });
const fillAction = z.object({ op: z.literal("fill"), target: locatorSpecSchema, text: z.string(), timeout_ms: timeoutMs });
const pressAction = z.object({ op: z.literal("press"), key: z.string().min(1), target: locatorSpecSchema.optional(), timeout_ms: timeoutMs });
const hoverAction = z.object({ op: z.literal("hover"), target: locatorSpecSchema, timeout_ms: timeoutMs });
const dragAction = z.object({ op: z.literal("drag"), from: locatorSpecSchema, to: locatorSpecSchema, timeout_ms: timeoutMs });
const waitForAction = z.object({
  op: z.literal("wait_for"),
  target: locatorSpecSchema,
  state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
  timeout_ms: timeoutMs,
});
const textAction = z.object({ op: z.literal("text"), target: locatorSpecSchema, timeout_ms: timeoutMs });
const attrAction = z.object({ op: z.literal("attr"), target: locatorSpecSchema, name: z.string().min(1), timeout_ms: timeoutMs });
const countAction = z.object({ op: z.literal("count"), target: locatorSpecSchema, timeout_ms: timeoutMs });
const evaluateAction = z.object({ op: z.literal("evaluate"), expression: z.string().min(1).max(20_000), timeout_ms: timeoutMs });
const screenshotAction = z.object({
  op: z.literal("screenshot"),
  full_page: z.boolean().default(false),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
  timeout_ms: timeoutMs,
});
const clipboardAction = z.object({
  op: z.literal("clipboard"),
  action: z.enum(["read", "write"]),
  mode: z.enum(["system", "browser"]).default("system"),
  text: z.string().optional(),
  grant_permission: z.boolean().default(false),
  timeout_ms: timeoutMs,
}).refine((value) => value.action !== "write" || value.text !== undefined, "clipboard write requires text");

export const triggerActionSchema = z.discriminatedUnion("op", [gotoAction, clickAction, dblclickAction, fillAction, pressAction, evaluateAction]);

const dialogAction = z.object({
  op: z.literal("dialog"),
  action: z.enum(["accept", "dismiss"]),
  prompt_text: z.string().optional(),
  trigger: triggerActionSchema,
  timeout_ms: timeoutMs,
});
const waitResponseAction = z.object({
  op: z.literal("wait_response"),
  url_contains: z.string().min(1),
  method: z.string().min(1).optional(),
  body: z.enum(["none", "text", "json"]).default("none"),
  trigger: triggerActionSchema,
  timeout_ms: timeoutMs,
});

export const batchActionSchema = z.discriminatedUnion("op", [
  gotoAction, clickAction, dblclickAction, fillAction, pressAction, hoverAction, dragAction,
  waitForAction, textAction, attrAction, countAction, evaluateAction, screenshotAction,
  dialogAction, waitResponseAction, clipboardAction,
]);

export type BatchAction = z.infer<typeof batchActionSchema>;
export type TriggerAction = z.infer<typeof triggerActionSchema>;
