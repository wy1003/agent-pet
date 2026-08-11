import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pet window waits for the first rendered asset before its initial reveal", async () => {
  const [main, preload, badge] = await Promise.all([
    readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../public/companion-badge.js", import.meta.url), "utf8"),
  ]);

  assert.match(preload, /petRendered:.*pet-renderer:ready/);
  assert.match(badge, /await waitForPetAsset\(rendered\.assetUrl\)/);
  assert.match(badge, /await waitForPetPaint\(\)/);
  assert.match(badge, /petRendered\(\{/);
  assert.match(main, /ipcMain\.on\("pet-renderer:ready"/);
  assert.match(main, /finishInitialPetReveal\("first pet frame ready"\)/);
  assert.match(main, /badgeWindow\.hide\(\);\s+badgeWindow\.setOpacity\(1\);\s+sendPetState\(\)/);
  assert.match(main, /badgeWindow\.setBounds\(bounds, false\);\s+sendPetState\(\);\s+badgeWindow\.showInactive\(\)/);

  const createWindows = main.slice(
    main.indexOf("async function createWindows()"),
    main.indexOf("function isTrustedSender"),
  );
  assert.match(createWindows, /badgeWindow\.setOpacity\(0\);\s+badgeWindow\.showInactive\(\)/);
  assert.match(createWindows, /finishInitialPetReveal\("render timeout fallback"\)/);
});
