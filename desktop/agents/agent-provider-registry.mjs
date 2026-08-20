function normalizeProvider(provider) {
  const id = String(provider?.id || "").trim().toLowerCase();
  const displayName = String(provider?.displayName || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !displayName) {
    throw new TypeError("An agent provider needs a stable id and display name");
  }
  return Object.freeze({
    id,
    displayName,
    description: String(provider.description || "").trim(),
    badge: String(provider.badge || "").trim().slice(0, 12),
    iconUrl: String(provider.iconUrl || "").trim(),
    accent: String(provider.accent || "").trim().slice(0, 32),
    taskSourceId: String(provider.taskSourceId || id).trim(),
    usageProviderId: String(provider.usageProviderId || id).trim(),
    remoteExecutorId: String(provider.remoteExecutorId || id).trim(),
    capabilities: Object.freeze({
      tasks: provider.capabilities?.tasks !== false,
      usage: provider.capabilities?.usage === true,
      remoteControl: provider.capabilities?.remoteControl === true,
    }),
  });
}

export class AgentProviderRegistry {
  constructor({ activeProviderId = "codex" } = {}) {
    this.activeProviderId = String(activeProviderId || "codex").trim().toLowerCase();
    this.providers = new Map();
  }

  register(provider) {
    const normalized = normalizeProvider(provider);
    if (this.providers.has(normalized.id)) {
      throw new Error(`Agent provider already registered: ${normalized.id}`);
    }
    this.providers.set(normalized.id, normalized);
    return this;
  }

  setActiveProvider(id) {
    const value = String(id || "").trim().toLowerCase();
    if (!this.providers.has(value)) throw new Error(`Unknown agent provider: ${value}`);
    this.activeProviderId = value;
    return this.current();
  }

  current() {
    return this.providers.get(this.activeProviderId) || null;
  }

  snapshot() {
    return {
      activeProviderId: this.activeProviderId,
      providers: [...this.providers.values()].map((provider) => ({
        ...provider,
        capabilities: { ...provider.capabilities },
        selected: provider.id === this.activeProviderId,
        state: provider.id === this.activeProviderId ? "connected" : "available",
      })),
    };
  }
}
