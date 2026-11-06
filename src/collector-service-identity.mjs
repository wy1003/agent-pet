import { readFileSync } from "node:fs";

export const COLLECTOR_SERVICE = "agent-pet-collector";
export const COLLECTOR_PROTOCOL_VERSION = 1;
// The server keeps its route map in memory but reads HTML/modules from disk.
// A new desktop must not attach to a server from an older application build.
export const COLLECTOR_APP_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const DESKTOP_COLLECTOR_IDENTITY = Object.freeze({
  service: COLLECTOR_SERVICE,
  protocolVersion: COLLECTOR_PROTOCOL_VERSION,
  appVersion: COLLECTOR_APP_VERSION,
  owner: "desktop",
  stateNamespace: "agent-pet-user-data-v1",
});

export const CLI_COLLECTOR_IDENTITY = Object.freeze({
  service: COLLECTOR_SERVICE,
  protocolVersion: COLLECTOR_PROTOCOL_VERSION,
  appVersion: COLLECTOR_APP_VERSION,
  owner: "cli",
  stateNamespace: "agent-pet-cli-v1",
});

export const STANDALONE_COLLECTOR_IDENTITY = Object.freeze({
  service: COLLECTOR_SERVICE,
  protocolVersion: COLLECTOR_PROTOCOL_VERSION,
  appVersion: COLLECTOR_APP_VERSION,
  owner: "standalone",
  stateNamespace: "standalone",
});

export function isCompatibleCollectorHealth(value, expected = DESKTOP_COLLECTOR_IDENTITY) {
  if (!value || value.ok !== true) return false;
  return ["service", "protocolVersion", "appVersion", "owner", "stateNamespace"]
    .every((key) => value[key] === expected[key])
    && (expected.capabilities || []).every((capability) => Array.isArray(value.capabilities) && value.capabilities.includes(capability));
}
