import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCollectorServer } from "../src/server.mjs";
import { petPreview } from "../public/pet-library-view.js";

for (const pageName of ["settings", "notebook", "pet-menu"]) {
test(`the real HTTP service serves ${pageName} and every transitive static module import`, async t => {
  const service = createCollectorServer(new EventEmitter(), { port: 0 });
  const address = await service.start();
  t.after(() => service.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(`${base}/${pageName}.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  const html = await page.text();
  const entries = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.ok(entries.length > 0, "the settings page loads scripts");
  const visited = new Set();
  async function visit(url) {
    if (visited.has(url)) return;
    visited.add(url);
    const response = await fetch(url);
    assert.equal(response.status, 200, `settings module is reachable: ${url}`);
    assert.match(response.headers.get("content-type"), /(?:text|application)\/javascript/, url);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const source = await response.text();
    for (const match of source.matchAll(/^\s*import\s+(?:[\w*{},\s]+?\s+from\s+)?["']([^"']+)["']/gm)) {
      assert.match(match[1], /^\.{1,2}\//, "browser modules use relative imports");
      await visit(new URL(match[1], url).href);
    }
    for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      await visit(new URL(match[1], url).href);
    }
  }
  for (const entry of entries) await visit(new URL(entry, base).href);
  if (pageName === "settings") {
    for (const id of ["claude-status", "claude-install", "claude-remove", "claude-preview"]) {
      assert.ok(html.includes(`id="${id}"`), `Claude settings exposes ${id}`);
    }
    assert.doesNotMatch(html, /data-claude-setting="usageProviderId"/);
    assert.match(html, /生命周期 Hook 自动确认完成/);
    assert.match(html, /data-claude-setting="autoLifecycleHooks"/);
    assert.match(html, /可选增强/);
    for (const key of ["executablePath", "nodePath", "defaultProviderId", "enableStatusline"]) {
      assert.ok(html.includes(`data-claude-setting="${key}"`));
    }
    assert.ok(visited.has(`${base}/pet-library-controller.js`));
    assert.ok(visited.has(`${base}/pet-library-view.js`));
    assert.ok(visited.has(`${base}/ai-settings.js`));
  } else if (pageName === "notebook") {
    assert.ok(visited.has(`${base}/notebook-source.mjs`));
    assert.equal(visited.has(`${base}/notebook-demo-source.mjs`), false, "production notebook does not import fake data");
  }
  for (const match of html.matchAll(/<link[^>]*href="([^"]+)"/g)) {
    assert.equal((await fetch(new URL(match[1], base))).status, 200);
  }

  const preview = await fetch(new URL(petPreview({ id: "builtin-default" }).url, base));
  assert.equal(preview.status, 200, "built-in pet preview is reachable");
  assert.equal(preview.headers.get("content-type"), "image/gif");
  const bytes = Buffer.from(await preview.arrayBuffer());
  assert.match(bytes.subarray(0, 6).toString("ascii"), /^GIF8[79]a$/);
  assert.ok(bytes.length > 100);

  // Registering UI dependencies must not turn the public folder into an unrestricted file server.
  for (const pathname of ["/package.json", "/desktop/preload.cjs", "/assets/pets/builtin-default/pet.json"]) {
    assert.equal((await fetch(base + pathname)).status, 404, pathname);
  }
});
}
