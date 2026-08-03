import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createStorageLocations,
  ensureStorageLocationDirectory,
  STORAGE_LOCATION_IDS,
  storageLocationById,
} from "../desktop/storage-locations.mjs";

test("storage locations expose only the configured application and notification directories", () => {
  const root = path.join(os.tmpdir(), "agent-pet-storage-locations");
  const locations = createStorageLocations({
    appDataPath: path.join(root, "app-data", "..", "app-data"),
    managedDataPath: path.join(root, "managed"),
    notificationHistoryPath: path.join(root, "managed", "notification-history"),
  });

  assert.deepEqual(locations, {
    appData: {
      id: STORAGE_LOCATION_IDS.APP_DATA,
      path: path.resolve(root, "app-data"),
    },
    notificationHistory: {
      id: STORAGE_LOCATION_IDS.NOTIFICATION_HISTORY,
      path: path.resolve(root, "managed", "notification-history"),
    },
  });
  assert.equal(
    storageLocationById(locations, STORAGE_LOCATION_IDS.NOTIFICATION_HISTORY),
    locations.notificationHistory,
  );
});

test("storage locations reject notification history paths outside the managed directory", () => {
  const root = path.join(os.tmpdir(), "agent-pet-storage-boundary");
  const input = {
    appDataPath: path.join(root, "app-data"),
    managedDataPath: path.join(root, "managed"),
  };

  assert.throws(() => createStorageLocations({
    ...input,
    notificationHistoryPath: path.join(root, "elsewhere"),
  }), /inside the managed data directory/);
  assert.throws(() => createStorageLocations({
    ...input,
    notificationHistoryPath: input.managedDataPath,
  }), /inside the managed data directory/);
});

test("storage location lookup rejects unknown and path-like renderer input", () => {
  const root = path.join(os.tmpdir(), "agent-pet-storage-lookup");
  const locations = createStorageLocations({
    appDataPath: path.join(root, "app-data"),
    managedDataPath: path.join(root, "managed"),
    notificationHistoryPath: path.join(root, "managed", "notification-history"),
  });

  for (const value of ["", "../notification-history", path.resolve(root), null, {}]) {
    assert.throws(() => storageLocationById(locations, value), /Unknown storage location/);
  }
});

test("storage location directories are created and must remain directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-pet-storage-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locations = createStorageLocations({
    appDataPath: path.join(root, "app-data"),
    managedDataPath: path.join(root, "managed"),
    notificationHistoryPath: path.join(root, "managed", "notification-history"),
  });

  const directory = await ensureStorageLocationDirectory(locations.notificationHistory);
  assert.equal(directory, locations.notificationHistory.path);
  assert.equal((await stat(directory)).isDirectory(), true);

  const filePath = path.join(root, "not-a-directory");
  await writeFile(filePath, "file", "utf8");
  await assert.rejects(
    ensureStorageLocationDirectory({ id: STORAGE_LOCATION_IDS.APP_DATA, path: filePath }),
  );
});
