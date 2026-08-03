import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PRODUCT_NAME = "Agent Pet";
export const MANAGED_DATA_DIRECTORY = "AgentPet";
export const LEGACY_MANAGED_DATA_DIRECTORY = "CodexTaskCompanion";
export const DATA_LOCATION_FILE = "data-location.json";
export const OWNED_USER_DATA_FILES = Object.freeze([
  "preferences.json",
  "companion-window.json",
  "collector-state.json",
]);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function productUserDataPath(appDataPath) {
  return path.join(path.resolve(appDataPath), PRODUCT_NAME);
}

async function rootScore(root, pathExists) {
  const signals = [
    [path.join(root, "engines", "GPT-SoVITS", "installation.json"), 100],
    [path.join(root, "voices"), 20],
    [path.join(root, "pets"), 10],
    [path.join(root, "notification-history"), 5],
    [path.join(root, "copywriter", "phrase-pool.json"), 3],
  ];
  let score = 0;
  for (const [candidate, weight] of signals) {
    if (await pathExists(candidate)) score += weight;
  }
  return score;
}

async function readRecordedDataRoot(userDataPath, candidates, pathExists) {
  try {
    const record = JSON.parse(await readFile(path.join(userDataPath, DATA_LOCATION_FILE), "utf8"));
    const recorded = path.resolve(String(record?.localRoot || ""));
    if (record?.version === 1 && candidates.includes(recorded) && await pathExists(recorded)) {
      return recorded;
    }
  } catch {}
  return "";
}

async function writeDataLocation(userDataPath, localRoot, mode) {
  await mkdir(userDataPath, { recursive: true });
  const destination = path.join(userDataPath, DATA_LOCATION_FILE);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const value = {
    version: 1,
    localRoot,
    mode,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function resolveManagedDataRoot({ localAppData, userDataPath, pathExists = exists }) {
  if (!localAppData) return path.join(path.resolve(userDataPath), "managed");
  const preferred = path.join(path.resolve(localAppData), MANAGED_DATA_DIRECTORY);
  const legacy = path.join(path.resolve(localAppData), LEGACY_MANAGED_DATA_DIRECTORY);
  const candidates = [preferred, legacy];
  const recorded = await readRecordedDataRoot(userDataPath, candidates, pathExists);
  if (recorded) return recorded;

  const [preferredScore, legacyScore] = await Promise.all([
    rootScore(preferred, pathExists),
    rootScore(legacy, pathExists),
  ]);
  const selected = legacyScore > preferredScore ? legacy : preferred;
  await writeDataLocation(
    path.resolve(userDataPath),
    selected,
    selected === legacy ? "legacy-in-place" : "product-root",
  );
  return selected;
}

export async function migrateLegacyUserData({ targetRoot, legacyRoots, logger = console }) {
  const destinationRoot = path.resolve(targetRoot);
  await mkdir(destinationRoot, { recursive: true });
  const candidates = [...new Set((legacyRoots || [])
    .filter(Boolean)
    .map((value) => path.resolve(value)))]
    .filter((value) => value !== destinationRoot);
  const migrated = [];

  for (const fileName of OWNED_USER_DATA_FILES) {
    const destination = path.join(destinationRoot, fileName);
    if (await exists(destination)) continue;
    for (const root of candidates) {
      const source = path.join(root, fileName);
      if (!(await exists(source))) continue;
      try {
        const raw = await readFile(source, "utf8");
        JSON.parse(raw);
        const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(temporary, raw, { encoding: "utf8", flag: "wx" });
        try {
          await rename(temporary, destination);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
        migrated.push(fileName);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          logger.warn?.(`[agent-pet] unable to migrate ${fileName}`, error);
        }
      }
      break;
    }
  }

  return migrated;
}
