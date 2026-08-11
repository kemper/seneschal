/**
 * Unit tests for the palette's pending state — the spinner shown while an
 * action (as opposed to a plain jump) is in flight.
 *   node --test test/pending.test.mjs
 *
 * These drive the REAL _runAction off SEN.Palette.prototype against stub DOM
 * nodes, rather than re-implementing the state machine in the test. Building
 * a whole Palette needs a document; _runAction needs only a handful of
 * properties, so we hand it exactly those.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = {
  globalThis: null,
  Date,
  // Shared with the host realm so node:test's mock timers can drive them.
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(here, "..", "src", "palette.js"), "utf8"), sandbox);
const { Palette } = sandbox.SEN;

/** A stand-in palette carrying only what _runAction touches. */
function stub() {
  const el = () => {
    const attrs = {};
    return {
      attrs,
      textContent: "",
      setAttribute: (k, v) => (attrs[k] = v),
      removeAttribute: (k) => delete attrs[k],
    };
  };
  const p = Object.create(Palette.prototype);
  Object.assign(p, {
    status: el(),
    statusText: el(),
    statusMark: el(),
    modal: el(),
    input: { disabled: false, focused: 0, focus() { this.focused++; } },
    busy: null,
    runId: 0,
    open: true,
    hidden: 0,
    hide() {
      this.hidden++;
      this.runId++;
      this._clearBusy();
      this.open = false;
    },
  });
  return p;
}

const state = (p) => p.status.attrs["data-state"];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

test("shows a busy state for the duration of the action", async () => {
  const p = stub();
  const d = deferred();
  const running = p._runAction({ label: "Heal Krogdolf", run: () => d.promise });

  assert.equal(state(p), "busy");
  assert.equal(p.modal.attrs["aria-busy"], "true");
  assert.equal(p.input.disabled, true, "input is disabled while busy");
  assert.ok(p.busy, "busy holds the running item");

  d.resolve();
  await running;
});

test("uses pendingLabel for the in-flight wording when given", async () => {
  const p = stub();
  const d = deferred();
  const running = p._runAction({
    label: "Heal Krogdolf",
    pendingLabel: "Healing Krogdolf…",
    run: () => d.promise,
  });
  assert.equal(p.statusText.textContent, "Healing Krogdolf…");
  d.resolve();
  await running;
});

test("falls back to the label when no pendingLabel is set", async () => {
  const p = stub();
  const d = deferred();
  const running = p._runAction({ label: "Heal", run: () => d.promise });
  assert.equal(p.statusText.textContent, "Heal…");
  d.resolve();
  await running;
});

test("success clears busy and reports the action's own message", async () => {
  const p = stub();
  await p._runAction({ label: "Heal", run: async () => ({ message: "Healed 3 heroes" }) });

  assert.equal(state(p), "done");
  assert.equal(p.statusText.textContent, "Healed 3 heroes");
  assert.equal(p.statusMark.textContent, "✓");
  assert.equal(p.busy, null);
  assert.equal(p.input.disabled, false, "input is usable again");
  assert.equal(p.modal.attrs["aria-busy"], undefined);
});

test("failure surfaces the real error and keeps the palette open", async () => {
  const p = stub();
  await p._runAction({
    label: "Heal",
    run: async () => {
      throw new Error("Not enough timber");
    },
  });

  assert.equal(state(p), "error");
  assert.equal(p.statusText.textContent, "Not enough timber", "no generic message");
  assert.equal(p.statusMark.textContent, "✕");
  assert.equal(p.hidden, 0, "a failed action must not close the palette");
  assert.equal(p.input.focused, 1, "focus returns so it can be retried");
  assert.equal(p.input.disabled, false);
});

test("a non-Error rejection still produces a readable message", async () => {
  const p = stub();
  await p._runAction({ label: "Heal", run: async () => Promise.reject("timed out") });
  assert.equal(state(p), "error");
  assert.equal(p.statusText.textContent, "timed out");
});

test("_activate is inert while an action is in flight (double-fire guard)", async () => {
  const p = stub();
  const d = deferred();
  let runs = 0;
  const item = { label: "Heal", run: () => (runs++, d.promise) };
  p.results = [{ item }];
  p.cursor = 0;
  p._bumpFrecency = () => {};

  const running = p._runAction(item);
  p._activate(0);
  p._activate(0);
  assert.equal(runs, 1, "a second Enter must not buy a second heal");

  d.resolve();
  await running;
});

test("dismissing mid-action leaves the palette usable, not stuck busy", async () => {
  const p = stub();
  const d = deferred();
  const running = p._runAction({ label: "Heal", run: () => d.promise });

  p.hide(); // user presses Escape while it is still running
  assert.equal(p.busy, null, "busy is released on dismiss");
  assert.equal(p.input.disabled, false, "input is not left disabled");

  d.resolve({ message: "Healed" });
  await running;
});

test("a superseded run cannot write its result over later state", async () => {
  const p = stub();
  const d = deferred();
  const running = p._runAction({ label: "Heal", run: () => d.promise });

  p.hide();
  p._setStatus(null); // palette reopened on something else
  d.resolve({ message: "Healed" });
  await running;

  assert.equal(state(p), undefined, "the stale run stayed quiet");
  assert.equal(p.statusText.textContent, "");
});

test("a slow action escalates its wording instead of sitting frozen", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = stub();
    const d = deferred();
    const running = p._runAction({
      label: "Heal",
      pendingLabel: "Healing…",
      run: () => d.promise,
    });
    assert.equal(p.statusText.textContent, "Healing…");

    mock.timers.tick(8000);
    assert.match(p.statusText.textContent, /still working/, "admits it is slow");
    assert.equal(state(p), "busy", "still busy, not failed");

    d.resolve();
    await running;
  } finally {
    mock.timers.reset();
  }
});

test("the success message lingers, then the palette closes itself", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = stub();
    await p._runAction({ label: "Heal", run: async () => ({ message: "Healed" }) });

    assert.equal(p.hidden, 0, "does not vanish the instant it succeeds");
    mock.timers.tick(900);
    assert.equal(p.hidden, 1, "closes once the confirmation has been seen");
  } finally {
    mock.timers.reset();
  }
});
