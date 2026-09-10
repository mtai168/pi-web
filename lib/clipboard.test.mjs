import assert from "node:assert/strict";
import test from "node:test";

const { copyText } = await import("./clipboard.ts");

function installFallbackDocument(t, execCommandImpl) {
  const removed = [];
  const attempts = [];
  const ta = { value: "", style: {}, parentNode: null, select() {} };
  const document = {
    body: {
      appendChild(node) { node.parentNode = document.body; },
      removeChild(node) {
        attempts.push(node);
        if (node.parentNode !== document.body) throw new Error("not inserted");
        node.parentNode = null;
        removed.push(node);
      },
    },
    createElement() { return ta; },
    execCommand: execCommandImpl,
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: document });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else delete globalThis.document;
  });
  return { document, ta, removed, attempts };
}

function installNavigator(t, navigator) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: navigator });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  });
}

test("uses navigator.clipboard.writeText when available and never touches the DOM fallback", async (t) => {
  const writes = [];
  installNavigator(t, { clipboard: { writeText: async (text) => { writes.push(text); } } });
  installFallbackDocument(t, () => { throw new Error("fallback must not run"); });
  await copyText("hello");
  assert.deepEqual(writes, ["hello"]);
});

test("rejects with the writeText failure when navigator.clipboard.writeText rejects", async (t) => {
  installNavigator(t, { clipboard: { writeText: async () => { throw new Error("denied by browser"); } } });
  installFallbackDocument(t, () => { throw new Error("fallback must not run"); });
  await assert.rejects(copyText("hello"), /denied by browser/);
});

test("truthy non-callable writeText falls back and resolves when execCommand succeeds", async (t) => {
  installNavigator(t, { clipboard: { writeText: "not-a-function" } });
  const { ta, removed } = installFallbackDocument(t, () => true);
  await copyText("hello");
  assert.equal(ta.value, "hello");
  assert.deepEqual(removed, [ta]);
  assert.equal(ta.parentNode, null);
});

test("truthy non-callable writeText falls back and rejects when execCommand fails", async (t) => {
  installNavigator(t, { clipboard: { writeText: {} } });
  const { ta, removed } = installFallbackDocument(t, () => false);
  await assert.rejects(copyText("hello"), /returned false/);
  assert.deepEqual(removed, [ta]);
  assert.equal(ta.parentNode, null);
});

test("navigator missing returns a rejected Promise instead of throwing synchronously", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  delete globalThis.navigator;
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  });
  const { document } = installFallbackDocument(t, () => true);
  document.createElement = () => { throw new Error("no DOM"); };
  const result = copyText("hello");
  assert.ok(result instanceof Promise);
  await assert.rejects(result, /no DOM/);
});

test("fallback resolves when execCommand returns true and removes the textarea", async (t) => {
  installNavigator(t, {});
  const { ta, removed } = installFallbackDocument(t, () => true);
  await copyText("hello");
  assert.equal(ta.value, "hello");
  assert.equal(ta.style.position, "fixed");
  assert.equal(ta.style.opacity, "0");
  assert.deepEqual(removed, [ta]);
  assert.equal(ta.parentNode, null);
});

test("fallback resolves when execCommand returns undefined (legacy success) and removes the textarea", async (t) => {
  installNavigator(t, {});
  const { ta, removed } = installFallbackDocument(t, () => undefined);
  await copyText("hello");
  assert.deepEqual(removed, [ta]);
  assert.equal(ta.parentNode, null);
});

test("fallback rejects when execCommand returns false and removes the textarea", async (t) => {
  installNavigator(t, {});
  const { ta, removed } = installFallbackDocument(t, () => false);
  await assert.rejects(copyText("hello"), /returned false/);
  assert.deepEqual(removed, [ta]);
  assert.equal(ta.parentNode, null);
});

test("fallback rejects when execCommand throws and still removes the textarea", async (t) => {
  installNavigator(t, {});
  const { ta, removed } = installFallbackDocument(t, () => { throw new Error("denied"); });
  await assert.rejects(copyText("hello"), /denied/);
  assert.deepEqual(removed, [ta]);
  assert.equal(ta.parentNode, null);
});

test("fallback rejects when select throws and still removes the textarea", async (t) => {
  installNavigator(t, {});
  const { ta, removed } = installFallbackDocument(t, () => true);
  ta.select = () => { throw new Error("not focusable"); };
  await assert.rejects(copyText("hello"), /not focusable/);
  assert.deepEqual(removed, [ta]);
});

test("fallback rejects when appendChild throws before inserting and still attempts removal", async (t) => {
  installNavigator(t, {});
  const { document, ta, removed, attempts } = installFallbackDocument(t, () => true);
  document.body.appendChild = () => { throw new Error("no body"); };
  await assert.rejects(copyText("hello"), /no body/);
  // Cleanup is attempted but the never-inserted node cannot be removed; the
  // swallowed cleanup failure must not mask the original error.
  assert.deepEqual(attempts, [ta]);
  assert.deepEqual(removed, []);
  assert.equal(ta.parentNode, null);
});

test("fallback removes the textarea when appendChild inserts then throws", async (t) => {
  installNavigator(t, {});
  const { document, ta, removed } = installFallbackDocument(t, () => true);
  document.body.appendChild = (node) => { node.parentNode = document.body; throw new Error("insert failed"); };
  await assert.rejects(copyText("hello"), /insert failed/);
  assert.deepEqual(removed, [ta]);
  assert.equal(ta.parentNode, null);
});

test("fallback rejects when createElement throws instead of throwing synchronously", async (t) => {
  installNavigator(t, {});
  const { document } = installFallbackDocument(t, () => true);
  document.createElement = () => { throw new Error("no DOM"); };
  await assert.rejects(copyText("hello"), /no DOM/);
});

test("cleanup failure never masks a successful copy", async (t) => {
  installNavigator(t, {});
  const { document, ta } = installFallbackDocument(t, () => true);
  document.body.removeChild = () => { throw new Error("detach failed"); };
  await copyText("hello");
  assert.equal(ta.parentNode, document.body);
});

test("cleanup failure never masks a rejected copy", async (t) => {
  installNavigator(t, {});
  const { document } = installFallbackDocument(t, () => false);
  document.body.removeChild = () => { throw new Error("detach failed"); };
  await assert.rejects(copyText("hello"));
});
