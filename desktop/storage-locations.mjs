import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

export const STORAGE_LOCATION_IDS = Object.freeze({
  APP_DATA: "app-data",
  NOTIFICATION_HISTORY: "notification-history",
});

function resolvedDirectory(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty path`);
  }
  return path.resolve(value);
}

function isStrictDescendant(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function createStorageLocations({
  appDataPath,
  managedDataPath,
  notificationHistoryPath,
}) {
  const appData = resolvedDirectory(appDataPath, "appDataPath");
  const managedData = resolvedDirectory(managedDataPath, "managedDataPath");
  const notificationHistory = resolvedDirectory(
    notificationHistoryPath,
    "notificationHistoryPath",
  );

  if (!isStrictDescendant(managedData, notificationHistory)) {
    throw new Error("Notification history must be inside the managed data directory");
  }

  return Object.freeze({
    appData: Object.freeze({
      id: STORAGE_LOCATION_IDS.APP_DATA,
      path: appData,
    }),
    notificationHistory: Object.freeze({
      id: STORAGE_LOCATION_IDS.NOTIFICATION_HISTORY,
      path: notificationHistory,
    }),
  });
}

export function storageLocationById(locations, id) {
  if (typeof id !== "string") throw new TypeError("Unknown storage location");
  const location = Object.values(locations).find((candidate) => candidate.id === id);
  if (!location) throw new TypeError("Unknown storage location");
  return location;
}

export async function ensureStorageLocationDirectory(location) {
  await mkdir(location.path, { recursive: true });
  const information = await stat(location.path);
  if (!information.isDirectory()) throw new Error("Storage location is not a directory");
  return location.path;
}
