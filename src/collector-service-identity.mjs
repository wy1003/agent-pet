export const COLLECTOR_SERVICE = "agent-pet-collector";
export const COLLECTOR_PROTOCOL_VERSION = 1;

export const DESKTOP_COLLECTOR_IDENTITY = Object.freeze({
  service: COLLECTOR_SERVICE,
  protocolVersion: COLLECTOR_PROTOCOL_VERSION,
  owner: "desktop",
  stateNamespace: "agent-pet-user-data-v1",
});

export const CLI_COLLECTOR_IDENTITY = Object.freeze({
  service: COLLECTOR_SERVICE,
  protocolVersion: COLLECTOR_PROTOCOL_VERSION,
  owner: "cli",
  stateNamespace: "agent-pet-cli-v1",
});

export const STANDALONE_COLLECTOR_IDENTITY = Object.freeze({
  service: COLLECTOR_SERVICE,
  protocolVersion: COLLECTOR_PROTOCOL_VERSION,
  owner: "standalone",
  stateNamespace: "standalone",
});

export function isCompatibleCollectorHealth(value, expected = DESKTOP_COLLECTOR_IDENTITY) {
  if (!value || value.ok !== true) return false;
  return ["service", "protocolVersion", "owner", "stateNamespace"]
    .every((key) => value[key] === expected[key]);
}
