function cleanVersion(value) {
  return String(value || "").trim().replace(/^v/i, "").slice(0, 64);
}

export function resolveAppRuntime(options = {}) {
  const development = options.explicitDevelopment === true
    || options.defaultApp === true
    || options.appIsPackaged !== true;
  const packaged = options.appIsPackaged === true && !development;
  const version = cleanVersion(packaged ? options.appVersion : options.packageVersion) || "0.0.0";
  return { development, packaged, version };
}
