import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILTIN_PET_ID = "builtin-default";

export const BUILTIN_PET = Object.freeze({
  id: BUILTIN_PET_ID,
  displayName: "小团",
  description: "圆润、安静的极简小白猫",
  format: "state-gifs",
  spriteVersionNumber: 2,
  width: 192,
  height: 208,
  states: Object.freeze({
    idle: "builtin-default-idle.gif",
    "running-right": "builtin-default-running-right.gif",
    "running-left": "builtin-default-running-left.gif",
    waving: "builtin-default-waving.gif",
    jumping: "builtin-default-jumping.gif",
    failed: "builtin-default-failed.gif",
    waiting: "builtin-default-waiting.gif",
    running: "builtin-default-running.gif",
    review: "builtin-default-review.gif",
    "look-right-side": "builtin-default-look-right-side.gif",
    "look-left-side": "builtin-default-look-left-side.gif",
  }),
});

const BUILTIN_PET_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "public",
  "assets",
  "pets",
  BUILTIN_PET_ID,
);

const BUILTIN_PET_FILES = new Set(Object.values(BUILTIN_PET.states));

export function builtinPetStateUrls() {
  return Object.fromEntries(Object.entries(BUILTIN_PET.states).map(([state, fileName]) => [
    state,
    `pet-asset://${BUILTIN_PET_ID}/${encodeURIComponent(fileName)}`,
  ]));
}

export function builtinPetAssetPath(fileName) {
  if (!BUILTIN_PET_FILES.has(fileName)) throw new Error("Unknown built-in pet asset");
  return path.join(BUILTIN_PET_DIRECTORY, fileName);
}
