import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { BrowserRuntime } from "../src/runtime.js";

test("page_close rejects while browser_batch is running on the same page", async () => {
  const runtime = new BrowserRuntime() as any;
  const action = deferred<void>();
  const started = deferred<void>();
  let closeCalled = false;
  const page = fakeRuntimePage({
    evaluate: async () => {
      started.resolve();
      await action.promise;
      return 1;
    },
    close: async () => { closeCalled = true; },
  });
  runtime.requirePage = async () => ({ id: "p_0001", page });

  const batch = runtime.batch({
    page: "app",
    actions: [{ op: "evaluate", expression: "1" }],
    diagnostics: { on_error: false },
  });
  await started.promise;

  await assert.rejects(runtime.pageClose("app"), /running browser_batch/);
  assert.equal(closeCalled, false);

  action.resolve();
  assert.equal((await batch).ok, true);
});

test("context reset rejects while any browser_batch is running", async () => {
  const runtime = new BrowserRuntime() as any;
  const action = deferred<void>();
  const started = deferred<void>();
  const page = fakeRuntimePage({
    evaluate: async () => {
      started.resolve();
      await action.promise;
      return 1;
    },
  });
  runtime.requirePage = async () => ({ id: "p_0001", page });
  let stopCalled = false;
  runtime.stopContext = async () => { stopCalled = true; };

  const batch = runtime.batch({
    page: "app",
    actions: [{ op: "evaluate", expression: "1" }],
    diagnostics: { on_error: false },
  });
  await started.promise;

  await assert.rejects(runtime.reset("context"), /while browser_batch is running/);
  assert.equal(stopCalled, false);

  action.resolve();
  await batch;
});

test("browser_batch may run concurrently on different pages", async () => {
  const runtime = new BrowserRuntime() as any;
  const actionA = deferred<void>();
  const startedA = deferred<void>();
  const pageA = fakeRuntimePage({
    evaluate: async () => {
      startedA.resolve();
      await actionA.promise;
      return "A";
    },
  });
  const pageB = fakeRuntimePage({ evaluate: async () => "B" });
  runtime.requirePage = async (ref?: string) => ref === "b"
    ? { id: "p_0002", page: pageB }
    : { id: "p_0001", page: pageA };

  const batchA = runtime.batch({
    page: "a",
    actions: [{ op: "evaluate", expression: "1" }],
    diagnostics: { on_error: false },
  });
  await startedA.promise;

  const batchB = await runtime.batch({
    page: "b",
    actions: [{ op: "evaluate", expression: "1" }],
    diagnostics: { on_error: false },
  });
  assert.equal(batchB.ok, true);
  assert.equal(batchB.results[0].value, "B");

  actionA.resolve();
  assert.equal((await batchA).ok, true);
});

test("browser_batch rejects while the same page is being reloaded", async () => {
  const runtime = new BrowserRuntime() as any;
  const reload = deferred<void>();
  const reloadStarted = deferred<void>();
  let evaluateCalled = false;
  const page = fakeRuntimePage({
    reload: async () => {
      reloadStarted.resolve();
      await reload.promise;
    },
    evaluate: async () => {
      evaluateCalled = true;
      return 1;
    },
  });
  runtime.requirePage = async () => ({ id: "p_0001", page });

  const resetting = runtime.reset("page", "app");
  await reloadStarted.promise;

  await assert.rejects(runtime.batch({
    page: "app",
    actions: [{ op: "evaluate", expression: "1" }],
    diagnostics: { on_error: false },
  }), /undergoing a lifecycle operation/);
  assert.equal(evaluateCalled, false);

  reload.resolve();
  assert.equal((await resetting).ok, true);
});

test("failure diagnostics stay bounded when page evaluation never settles", async () => {
  const runtime = new BrowserRuntime() as any;
  let evaluateCalls = 0;
  const never = new Promise<never>(() => undefined);
  const page = fakeRuntimePage({
    evaluate: async () => {
      evaluateCalls += 1;
      return never;
    },
  });
  runtime.requirePage = async () => ({ id: "p_0001", page });

  const started = performance.now();
  const result = await runtime.batch({
    page: "app",
    actions: [{ op: "evaluate", expression: "while (true) {}", timeout_ms: 20 }],
  });
  const duration = performance.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.failed_step, 0);
  assert.match(result.results[0].error, /timed out/);
  assert.deepEqual(result.diagnostics.active_element, null);
  assert.deepEqual(result.diagnostics.selection, null);
  assert.equal(evaluateCalls, 2);
  assert.ok(duration < 1_000, `diagnostics took too long: ${duration}ms`);
});

test("diagnostics failure does not replace the original batch error", async () => {
  const runtime = new BrowserRuntime() as any;
  const page = fakeRuntimePage({
    evaluate: async () => { throw new Error("original action failure"); },
  });
  runtime.requirePage = async () => ({ id: "p_0001", page });
  runtime.failureDiagnostics = async () => { throw new Error("diagnostics failure"); };

  const result = await runtime.batch({
    page: "app",
    actions: [{ op: "evaluate", expression: "1" }],
  });

  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /original action failure/);
  assert.deepEqual(result.diagnostics, { unavailable: true, error: "diagnostics failure" });
});

function fakeRuntimePage(overrides: Record<string, unknown> = {}) {
  return {
    url: () => "https://example.test/",
    evaluate: async () => 1,
    reload: async () => undefined,
    close: async () => undefined,
    ...overrides,
  } as unknown as Page;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
