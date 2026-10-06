import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BrowserRuntime } from "../src/runtime.js";

const idleMs = 30_000;

function setup(t: TestContext, urls: string[] = ["about:blank"], timeoutMs = idleMs) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const runtime = new BrowserRuntime(timeoutMs) as any;
  const pages = urls.map((url) => ({
    url: () => url,
    isClosed: () => false,
    evaluate: async () => true,
  }));
  const context = { pages: () => pages };
  runtime.context = context;
  let closes = 0;
  runtime.stopContext = async () => {
    closes += 1;
    runtime.context = undefined;
  };
  runtime.noteActivity();
  t.after(() => runtime.clearIdleTimer());
  return { runtime, pages, context, closes: () => closes };
}

async function flush() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const urls of [["about:blank"], []]) {
  test(`idle recycling closes ${urls.length ? "empty blank pages" : "a context with no pages"} after the timeout`, async (t) => {
    const state = setup(t, urls);
    t.mock.timers.tick(idleMs - 1);
    await flush();
    assert.equal(state.closes(), 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.closes(), 1);
    assert.equal((await state.runtime.status()).running, false);
    t.mock.timers.tick(idleMs * 10);
    await flush();
    assert.equal(state.closes(), 1);
  });
}

for (const url of ["https://example.test/app", "chrome://newtab/", "data:text/html,form"]) {
  test(`idle recycling preserves ${url}`, async (t) => {
    const state = setup(t, [url]);
    t.mock.timers.tick(idleMs);
    await flush();
    assert.equal(state.closes(), 0);
    assert.equal(state.runtime.context, state.context);
  });
}

test("about:blank containing DOM content is preserved", async (t) => {
  const state = setup(t);
  state.pages[0].evaluate = async () => false;
  t.mock.timers.tick(idleMs);
  await flush();
  assert.equal(state.closes(), 0);
});

test("zero disables idle recycling", async (t) => {
  const state = setup(t, ["about:blank"], 0);
  t.mock.timers.tick(idleMs * 10);
  await flush();
  assert.equal(state.closes(), 0);
});

const operations: Array<[string, unknown[]]> = [
  ["reset", ["soft"]], ["pageList", []], ["pageCreate", [{}]],
  ["pageClose", ["p_0001"]], ["pageAlias", ["p_0001", "app"]],
  ["clipboardRead", ["browser"]], ["clipboardWrite", ["browser", "value"]],
  ["batch", [{ actions: [] }]],
];
for (const [name, args] of operations) {
  test(`idle recycling waits for the entire ${name} operation`, async (t) => {
    const state = setup(t);
    const work = deferred<void>();
    state.runtime[`${name}Operation`] = () => work.promise;
    const operation = state.runtime[name](...args);
    t.mock.timers.tick(idleMs * 2);
    await flush();
    assert.equal(state.closes(), 0);
    work.resolve();
    await operation;
    t.mock.timers.tick(idleMs - 1);
    await flush();
    assert.equal(state.closes(), 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(state.closes(), 1);
  });
}

test("a request arriving during the blank-page check prevents recycling", async (t) => {
  const state = setup(t);
  const empty = deferred<boolean>();
  state.pages[0].evaluate = () => empty.promise;
  t.mock.timers.tick(idleMs);
  await flush();
  let called = false;
  state.runtime.pageListOperation = async () => { called = true; return []; };
  const operation = state.runtime.pageList();
  assert.equal(called, false);
  empty.resolve(true);
  await operation;
  assert.equal(called, true);
  assert.equal(state.closes(), 0);
});

test("navigation during the blank-page check prevents recycling", async (t) => {
  const state = setup(t);
  const empty = deferred<boolean>();
  state.pages[0].evaluate = () => empty.promise;
  t.mock.timers.tick(idleMs);
  await flush();
  state.runtime.noteActivity();
  empty.resolve(true);
  await flush();
  assert.equal(state.closes(), 0);
});

test("a request arriving during close waits, then can start a new context", async (t) => {
  const state = setup(t);
  const closing = deferred<void>();
  state.runtime.stopContext = async () => {
    state.runtime.context = undefined;
    await closing.promise;
  };
  t.mock.timers.tick(idleMs);
  await flush();
  let started = false;
  state.runtime.pageListOperation = async () => {
    started = true;
    state.runtime.context = state.context;
    return [];
  };
  const operation = state.runtime.pageList();
  await flush();
  assert.equal(started, false);
  closing.resolve();
  await operation;
  assert.equal(started, true);
  assert.equal((await state.runtime.status()).running, true);
});

test("failed blank-page checks preserve Chrome and do not retry in a tight loop", async (t) => {
  const state = setup(t);
  let checks = 0;
  state.pages[0].evaluate = async () => { checks += 1; throw new Error("page unavailable"); };
  t.mock.timers.tick(idleMs);
  await flush();
  assert.equal(checks, 1);
  assert.equal(state.closes(), 0);
  t.mock.timers.tick(idleMs - 1);
  await flush();
  assert.equal(checks, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(checks, 2);
  assert.equal(state.closes(), 0);
});

test("status probes do not postpone idle recycling", async (t) => {
  const state = setup(t);
  t.mock.timers.tick(idleMs - 1);
  await state.runtime.status();
  t.mock.timers.tick(1);
  await flush();
  assert.equal(state.closes(), 1);
});

test("a timed-out close prevents a second Chrome launch until the old close completes", async (t) => {
  const state = setup(t);
  state.runtime.clearIdleTimer();
  const closing = deferred<void>();
  state.runtime.context.close = () => closing.promise;
  delete state.runtime.stopContext;
  state.runtime.releaseOwner = async () => undefined;
  const stopped = state.runtime.stopContext({ timeoutMs: 20 });
  const rejected = assert.rejects(stopped, /did not close/);
  t.mock.timers.tick(20);
  await rejected;
  let launched = false;
  state.runtime.launch = async () => { launched = true; return state.context; };
  const restarted = state.runtime.ensureContext();
  await flush();
  assert.equal(launched, false);
  assert.equal((await state.runtime.status()).closing, true);
  closing.resolve();
  assert.equal(await restarted, state.context);
  assert.equal(launched, true);
  assert.equal((await state.runtime.status()).closing, false);
});
