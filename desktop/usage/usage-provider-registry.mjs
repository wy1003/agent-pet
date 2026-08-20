export class UsageProviderRegistry {
  constructor({ activeProviderId = "codex" } = {}) {
    this.activeProviderId = activeProviderId;
    this.providers = new Map();
  }

  register(provider) {
    const id = String(provider?.id || "").trim();
    if (!id || typeof provider?.getUsage !== "function") {
      throw new TypeError("A usage provider needs an id and getUsage() method");
    }
    if (this.providers.has(id)) throw new Error(`Usage provider already registered: ${id}`);
    this.providers.set(id, provider);
    return this;
  }

  setActiveProvider(id) {
    const value = String(id || "").trim();
    this.activeProviderId = value;
  }

  async getCurrentUsage(options = {}) {
    const provider = this.providers.get(this.activeProviderId);
    if (!provider) {
      return {
        providerId: this.activeProviderId || "unknown",
        viewType: "unavailable",
        status: "unavailable",
        message: "当前连接尚未提供额度信息。",
      };
    }
    return provider.getUsage(options);
  }
}
