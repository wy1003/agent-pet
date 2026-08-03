import os from "node:os";
import path from "node:path";

export const COPYWRITER_PROJECT_NAME = "AgentPetCopywriter";
export const LEGACY_COPYWRITER_PROJECT_NAME = "CodexTaskCompanionCopywriter";

export function normalizeProjectPath(value) {
  return path.resolve(String(value || "")).replace(/\\/g, "/").toLowerCase();
}

export function copywriterWorkingDirectory(options = {}) {
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const fallbackRoot = options.fallbackRoot || path.join(os.homedir(), ".agent-pet");
  const root = options.managedRoot || (localAppData
    ? path.join(localAppData, "AgentPet")
    : fallbackRoot);
  return path.join(root, "internal", COPYWRITER_PROJECT_NAME);
}

export function defaultIgnoredProjectPaths(options = {}) {
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const fallbackRoot = options.fallbackRoot || path.join(os.homedir(), ".agent-pet");
  const roots = [
    options.managedRoot,
    localAppData ? path.join(localAppData, "AgentPet") : fallbackRoot,
    localAppData
      ? path.join(localAppData, "CodexTaskCompanion")
      : path.join(os.homedir(), ".codex-task-companion"),
  ].filter(Boolean);
  const uniqueRoots = [...new Set(roots.map((value) => path.resolve(value)))];
  return uniqueRoots.flatMap((root) => [
    path.join(root, "internal", COPYWRITER_PROJECT_NAME),
    path.join(root, "internal", LEGACY_COPYWRITER_PROJECT_NAME),
  ]);
}
