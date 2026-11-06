import assert from "node:assert/strict";
import test from "node:test";
import { formatResetTime, formatSyncTime, formatUsageWindow, renderUsageMeter } from "../public/usage-meter.mjs";

function documentStub() {
  return { createElement: (tag) => ({ tag, children: [], dataset: {}, style: {}, attributes: {}, textContent: "",
    append(...children) { this.children.push(...children); }, setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener() {}, classList: { add() {}, remove() {} },
  }) };
}
const text = node => [node.textContent, ...node.children.map(text)].join(" ");

test("Claude quota renders provider identity, source and measured windows without inventing missing percentages", t => {
  const original = globalThis.document;
  globalThis.document = documentStub();
  t.after(() => { globalThis.document = original; });
  const ready = renderUsageMeter({ viewType: "claude-quota", providerId: "claude", displayName: "Claude Code", status: "ready", source: "statusline",
    windows: [{ windowMinutes: 300, usedPercent: 35, remainingPercent: 65 }], syncedAt: new Date().toISOString() }, { onRefresh() {} });
  assert.match(text(ready), /Claude Code/);
  assert.match(text(ready), /剩余 65%/);
  assert.match(text(ready), /statusline/);
  const unavailable = renderUsageMeter({ viewType: "claude-quota", status: "ready", windows: [{ windowMinutes: 300, usedPercent: null, remainingPercent: null }] }, { onRefresh() {} });
  assert.doesNotMatch(text(unavailable), /0%/);
  assert.match(text(unavailable), /未知|暂无/);
  const stale = renderUsageMeter({ viewType: "claude-quota", status: "stale", message: "数据已过期", windows: [{ usedPercent: 20, remainingPercent: 80 }] }, { onRefresh() {} });
  assert.match(text(stale), /过期/);
  assert.doesNotMatch(text(stale), /80%/);
});

test("missing quota timestamps never render an epoch time as successfully synced", () => {
  assert.equal(formatSyncTime(null), "等待同步");
  assert.equal(formatSyncTime(undefined), "等待同步");
  assert.equal(formatSyncTime(""), "等待同步");
  assert.equal(formatResetTime(null), "重置时间未知");
});

test("usage meter formats provider windows for compact cards", () => {
  assert.equal(formatUsageWindow(10_080), "每周使用限额");
  assert.equal(formatUsageWindow(300), "5 小时使用限额");
  assert.match(formatResetTime("2026-08-17T07:00:00.000Z"), /^重置于 /);
  assert.match(formatSyncTime("2026-08-17T07:00:00.000Z"), /^已同步 · /);
});
