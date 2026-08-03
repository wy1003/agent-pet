import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SecureCredentials } from "../desktop/secure-credentials.mjs";

function xorBackend(available = true) {
  const key = 0xa7;
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Buffer.from(value, "utf8").map((byte) => byte ^ key);
    },
    decryptString(value) {
      return Buffer.from(value).map((byte) => byte ^ key).toString("utf8");
    },
  };
}

async function fixture(t, backend = xorBackend()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "secure-credentials-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "credentials.json");
  return { filePath, store: new SecureCredentials(filePath, backend) };
}

test("secure credentials round-trip without exposing values or namespaces on disk", async (t) => {
  const { filePath, store } = await fixture(t);
  const value = {
    botToken: "plain-secret-token",
    accountId: "wechat-account-123",
    contextTokens: { user: "plain-context-token" },
  };

  await store.save("wechat.primary", value);
  assert.deepEqual(await store.load("wechat.primary"), value);
  assert.equal(await store.has("wechat.primary"), true);

  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /plain-secret-token|wechat-account-123|plain-context-token/);
  assert.doesNotMatch(raw, /wechat\.primary|botToken|accountId|contextTokens/);
  const envelope = JSON.parse(raw);
  assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "version"]);
  assert.match(envelope.ciphertext, /^[A-Za-z0-9+/]+={0,2}$/);
});

test("clear removes one namespace without losing the others", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.save("wechat.primary", { token: "first" });
  await store.save("wechat.secondary", { token: "second" });

  assert.equal(await store.clear("wechat.primary"), true);
  assert.equal(await store.load("wechat.primary"), null);
  assert.deepEqual(await store.load("wechat.secondary"), { token: "second" });
  assert.equal(await store.clear("wechat.primary"), false);
  assert.equal(await store.clear("wechat.secondary"), true);
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
});

test("has distinguishes a stored JSON null from a missing namespace", async (t) => {
  const { store } = await fixture(t);
  await store.save("wechat.nullable", null);
  assert.equal(await store.load("wechat.nullable"), null);
  assert.equal(await store.has("wechat.nullable"), true);
  assert.equal(await store.has("wechat.missing"), false);
});

test("concurrent saves are serialized without dropping namespaces", async (t) => {
  const { store } = await fixture(t);
  await Promise.all(
    Array.from({ length: 24 }, (_, index) => (
      store.save(`wechat.session-${index}`, { token: `token-${index}`, index })
    )),
  );

  const values = await Promise.all(
    Array.from({ length: 24 }, (_, index) => store.load(`wechat.session-${index}`)),
  );
  assert.deepEqual(
    values,
    Array.from({ length: 24 }, (_, index) => ({ token: `token-${index}`, index })),
  );
});

test("unavailable OS encryption rejects saves and never falls back to plaintext", async (t) => {
  const { filePath, store } = await fixture(t, xorBackend(false));
  await assert.rejects(
    store.save("wechat.primary", { token: "must-not-be-written" }),
    { code: "secure_storage_unavailable" },
  );
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
  assert.equal(await store.load("wechat.primary"), null);
});

test("corrupt or undecryptable files read as empty and can be safely replaced", async (t) => {
  const { filePath, store } = await fixture(t);
  await writeFile(filePath, "{not-json and contains old junk", "utf8");
  assert.equal(await store.load("wechat.primary"), null);

  await store.save("wechat.primary", { token: "replacement-secret" });
  assert.deepEqual(await store.load("wechat.primary"), { token: "replacement-secret" });
  assert.doesNotMatch(await readFile(filePath, "utf8"), /replacement-secret/);

  const envelope = JSON.parse(await readFile(filePath, "utf8"));
  envelope.ciphertext = Buffer.from("not decryptable JSON", "utf8").toString("base64");
  await writeFile(filePath, JSON.stringify(envelope), "utf8");
  assert.equal(await store.load("wechat.primary"), null);
  await store.save("wechat.primary", { token: "second-replacement" });
  assert.deepEqual(await store.load("wechat.primary"), { token: "second-replacement" });
});

test("namespace and JSON payload limits are enforced", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.save("contains spaces", { token: "x" }), {
    code: "secure_credentials_invalid_namespace",
  });
  await assert.rejects(store.save("wechat.primary", "x".repeat(70 * 1024)), {
    code: "secure_credentials_payload_too_large",
  });
});
