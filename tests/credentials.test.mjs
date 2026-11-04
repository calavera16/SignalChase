import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createCredentials } from "../signaltrace/web/credentials.js";

const html = await readFile(
  new URL("../signaltrace/web/index.html", import.meta.url),
  "utf8",
);
// Deliberately fake; never use real credentials in browser tests or receipts.
const CANARY = "FAKE_TEST_KEY_not_a_credential_79281";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const response = (configured = false, source = "none") => ({
  ok: true,
  json: async () => ({ configured, source }),
});
function setup(handle = () => response(), native = false) {
  const dom = new JSDOM(html, { url: "http://localhost:8765" });
  const doc = dom.window.document;
  const $ = (id) => doc.getElementById(id);
  let storageAccess = 0;
  for (const storage of ["localStorage", "sessionStorage"])
    Object.defineProperty(dom.window, storage, {
      get() {
        storageAccess++;
        throw new Error("storage forbidden");
      },
    });
  Object.defineProperty(doc, "cookie", {
    get() {
      storageAccess++;
      throw new Error("cookie forbidden");
    },
    set() {
      storageAccess++;
      throw new Error("cookie forbidden");
    },
  });
  if (native) {
    $("meta-credentials-dialog").showModal = function () {
      this.setAttribute("open", "");
    };
    $("meta-credentials-dialog").close = function () {
      this.removeAttribute("open");
      this.dispatchEvent(new dom.window.Event("close"));
    };
  }
  const calls = [],
    changes = [];
  const controller = createCredentials(
    doc,
    (path, options = {}) => {
      // The harness retains only method/headers; production never keeps payloads.
      calls.push({
        path,
        method: options.method || "GET",
        headers: options.headers,
      });
      return Promise.resolve(handle(path, options));
    },
    { onChange: (presence) => changes.push(presence) },
  );
  const submit = () =>
    $("meta-credentials-form").dispatchEvent(
      new dom.window.Event("submit", { cancelable: true }),
    );
  const safe = () => {
    assert.equal(storageAccess, 0);
    assert.equal($("meta-api-key").value, "");
    assert.ok(!doc.documentElement.outerHTML.includes(CANARY));
    assert.ok(!dom.window.location.href.includes(CANARY));
    assert.ok(!JSON.stringify(changes).includes(CANARY));
  };
  return { dom, doc, $, controller, calls, changes, submit, safe };
}

for (const native of [false, true]) {
  test(`first-use prompt is keyboard dismissible and offline-safe (${native ? "native" : "fallback"})`, async () => {
    const h = setup(undefined, native);
    h.$("meta-credentials-open").focus();
    await h.controller.init();
    assert.equal(h.$("meta-credentials-dialog").open, true);
    assert.equal(h.doc.activeElement, h.$("meta-api-key"));
    for (const [attribute, expected] of [
      ["type", "password"],
      ["autocomplete", "off"],
      ["spellcheck", "false"],
      ["autocapitalize", "off"],
    ])
      assert.equal(h.$("meta-api-key").getAttribute(attribute), expected);
    h.$("meta-api-key").value = CANARY;
    h.$("meta-credentials-dialog").dispatchEvent(
      new h.dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        cancelable: true,
      }),
    );
    assert.equal(h.$("meta-credentials-dialog").open, false);
    assert.equal(h.doc.activeElement, h.$("meta-credentials-open"));
    assert.deepEqual(
      h.calls.map((c) => c.method),
      ["GET"],
    );
    h.safe();
    h.$("meta-credentials-open").click();
    h.$("meta-api-key").value = CANARY;
    h.$("meta-credentials-skip").click();
    h.safe();
    h.controller.destroy();
  });
}

test("save sends only a bounded local body, clears input synchronously, and never calls a model", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = setup((path, options) => {
    assert.equal(path, "/api/credentials/meta");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    if (!options.method) return response();
    assert.equal(options.method, "PUT");
    assert.deepEqual(options.headers, {
      "Content-Type": "application/json",
      "x-signaltrace-request": "1",
    });
    assert.deepEqual(JSON.parse(options.body), { api_key: CANARY });
    return pending;
  });
  await h.controller.init();
  h.$("meta-api-key").value = CANARY;
  h.submit();
  h.safe();
  h.$("meta-credentials-clear").click();
  h.submit();
  assert.deepEqual(
    h.calls.map((c) => c.method),
    ["GET", "PUT"],
  );
  assert.equal(h.$("meta-credentials-save").disabled, true);
  h.$("meta-credentials-skip").click();
  release(response(true, "browser"));
  await tick();
  assert.deepEqual(h.changes, [{ configured: true, source: "browser" }]);
  assert.match(
    h.$("meta-credentials-summary").textContent,
    /connection unverified/,
  );
  h.safe();
  h.controller.destroy();
});

test("clear is explicit DELETE with CSRF headers, no payload, and offline presence", async () => {
  const h = setup((path, options) => {
    if (!options.method) return response(true, "environment");
    assert.equal(options.method, "DELETE");
    assert.equal(options.headers["x-signaltrace-request"], "1");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.body, undefined);
    return response();
  });
  await h.controller.init();
  assert.equal(h.$("meta-credentials-dialog").open, false);
  h.$("meta-credentials-open").click();
  h.$("meta-api-key").value = CANARY;
  h.$("meta-credentials-clear").click();
  h.safe();
  await tick();
  assert.deepEqual(h.changes, [{ configured: false, source: "none" }]);
  assert.match(h.$("meta-credentials-summary").textContent, /Offline/);
  h.controller.destroy();
});

for (const failure of ["reflection", "throw", "invalid-presence"]) {
  test(`credential failure stays generic and clears secret (${failure})`, async () => {
    let parsed = false;
    const h = setup((path, options) => {
      if (!options.method) return response();
      if (failure === "throw") throw new Error(CANARY);
      return {
        ok: failure !== "reflection",
        json: async () => {
          parsed = true;
          return { detail: CANARY, configured: true, source: CANARY };
        },
      };
    });
    await h.controller.init();
    h.$("meta-api-key").value = CANARY;
    h.submit();
    h.safe();
    await tick();
    assert.match(
      h.$("meta-credentials-status").textContent,
      /Could not change/,
    );
    assert.equal(parsed, failure === "invalid-presence");
    assert.deepEqual(h.changes, []);
    h.safe();
    h.controller.destroy();
  });
}

for (const action of ["destroy", "pagehide"]) {
  test(`${action} clears input, aborts pending submission, and ignores late success`, async () => {
    let release, signal;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const h = setup((path, options) => {
      if (!options.method) return response();
      signal = options.signal;
      return pending;
    });
    await h.controller.init();
    h.$("meta-api-key").value = CANARY;
    h.submit();
    if (action === "pagehide")
      h.dom.window.dispatchEvent(new h.dom.window.Event("pagehide"));
    else h.controller.destroy();
    assert.equal(signal.aborted, true);
    release(response(true, "browser"));
    await tick();
    assert.deepEqual(h.changes, []);
    assert.equal(h.$("meta-credentials-dialog").open, false);
    h.safe();
    h.controller.destroy();
  });
}

test("cancel events, native close, empty submit, and unreadable startup all erase input", async () => {
  const h = setup(() => ({
    ok: false,
    json: () => {
      throw new Error("must not parse");
    },
  }));
  await h.controller.init();
  h.$("meta-credentials-open").click();
  h.$("meta-api-key").value = CANARY;
  h.$("meta-credentials-dialog").dispatchEvent(
    new h.dom.window.Event("cancel", { cancelable: true }),
  );
  h.safe();
  h.$("meta-credentials-open").click();
  h.$("meta-api-key").value = CANARY;
  h.$("meta-credentials-dialog").dispatchEvent(new h.dom.window.Event("close"));
  h.safe();
  h.$("meta-api-key").value = "   ";
  h.submit();
  h.safe();
  assert.equal(h.calls.length, 1);
  h.controller.destroy();
});

test("back/forward-cache restore rechecks presence and a stale save cannot erase new input", async () => {
  let release, signal;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = setup((path, options) => {
    if (!options.method) return response();
    signal = options.signal;
    return pending;
  });
  await h.controller.init();
  h.$("meta-api-key").value = CANARY;
  h.submit();
  h.dom.window.dispatchEvent(
    new h.dom.window.PageTransitionEvent("pagehide", { persisted: true }),
  );
  assert.equal(signal.aborted, true);
  h.safe();
  h.dom.window.dispatchEvent(
    new h.dom.window.PageTransitionEvent("pageshow", { persisted: true }),
  );
  await tick();
  assert.equal(h.$("meta-credentials-dialog").open, true);
  assert.equal(h.$("meta-api-key").disabled, false);
  assert.deepEqual(h.changes, [{ configured: false, source: "none" }]);
  h.$("meta-api-key").value = "new fake input";
  release(response(true, "browser"));
  await tick();
  assert.equal(h.$("meta-api-key").value, "new fake input");
  assert.equal(h.changes.length, 1);
  h.controller.destroy();
  h.safe();
});

test("a late startup read cannot replace a newer successful save or reopen setup", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = setup((path, options) =>
    options.method ? response(true, "browser") : pending,
  );
  const startup = h.controller.init();
  h.$("meta-credentials-open").click();
  h.$("meta-api-key").value = CANARY;
  h.submit();
  await tick();
  h.$("meta-credentials-skip").click();
  release(response());
  await startup;
  assert.equal(h.$("meta-credentials-dialog").open, false);
  assert.match(
    h.$("meta-credentials-summary").textContent,
    /configured.*unverified/,
  );
  assert.deepEqual(h.changes, [{ configured: true, source: "browser" }]);
  h.safe();
  h.controller.destroy();
});
