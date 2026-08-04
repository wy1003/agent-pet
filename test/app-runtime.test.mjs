import test from "node:test";
import assert from "node:assert/strict";
import { resolveAppRuntime } from "../desktop/app-runtime.mjs";

test("renamed Electron development executable stays in development mode", () => {
  assert.deepEqual(resolveAppRuntime({
    appIsPackaged: true,
    appVersion: "43.2.0",
    packageVersion: "0.1.1",
    explicitDevelopment: true,
  }), {
    development: true,
    packaged: false,
    version: "0.1.1",
  });
});

test("packaged application keeps its release version and updater capability", () => {
  assert.deepEqual(resolveAppRuntime({
    appIsPackaged: true,
    appVersion: "0.1.1",
    packageVersion: "0.1.1",
  }), {
    development: false,
    packaged: true,
    version: "0.1.1",
  });
});

test("ordinary Electron development launch uses the package version", () => {
  assert.deepEqual(resolveAppRuntime({
    appIsPackaged: false,
    appVersion: "43.2.0",
    packageVersion: "v0.1.1",
    defaultApp: true,
  }), {
    development: true,
    packaged: false,
    version: "0.1.1",
  });
});
