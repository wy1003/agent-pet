export function parseEventBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join("\n")) };
}

export class TaskEventClient {
  constructor(baseUrl, handlers = {}, options = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.handlers = handlers;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.retryMs = Math.max(250, Number(options.retryMs || 1_500));
    this.logger = options.logger || console;
    this.controller = null;
    this.running = null;
    this.stopped = true;
  }

  start() {
    if (this.running) return this.running;
    this.stopped = false;
    this.running = this.#run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async #run() {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/api/v1/events`, {
          headers: { Accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`任务事件流连接失败（HTTP ${response.status}）`);
        await this.#consume(response.body);
      } catch (error) {
        if (!this.stopped && error?.name !== "AbortError") {
          this.logger.warn("[notifications] task event stream disconnected", error);
        }
      } finally {
        this.controller = null;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.retryMs));
    }
  }

  async #consume(body) {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of body) {
      if (this.stopped) return;
      pending += decoder.decode(chunk, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (!block || block.startsWith(":")) continue;
        try {
          const message = parseEventBlock(block);
          if (message) this.handlers.onEvent?.(message.event, message.data);
        } catch (error) {
          this.logger.warn("[notifications] ignored malformed task event", error);
        }
      }
    }
  }

  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.running?.catch(() => {});
  }
}
