const ACTIVE_STATUSES = new Set(["submitted", "queued", "running"]);
const TERMINAL_FEEDBACK = Object.freeze({
  completed: "waving",
  failed: "failed",
});

function valuesOf(tasks) {
  return tasks instanceof Map ? [...tasks.values()] : [...(tasks || [])];
}

function normalizedAvailableStates(states) {
  if (states == null) return null;
  return [...new Set([...states].map((state) => String(state || "").trim()).filter(Boolean))];
}

export function resolveAvailablePetState(state, availableStates = null) {
  const requested = String(state || "idle");
  const available = normalizedAvailableStates(availableStates);
  if (available === null || available.includes(requested)) return requested;
  if (available.includes("idle")) return "idle";
  return available[0] || "idle";
}

export function aggregatePetState(tasks) {
  const values = valuesOf(tasks);
  if (values.some((task) => task?.status === "needs_input" && task?.phase === "waiting_approval")) {
    return "review";
  }
  if (values.some((task) => task?.status === "needs_input")) return "waiting";
  if (values.some((task) => task?.status === "failed")) return "failed";
  if (values.some((task) => task?.status === "running")) return "running";
  if (values.some((task) => ["submitted", "queued"].includes(task?.status))) return "waiting";
  if (values.some((task) => ["interrupted", "unknown"].includes(task?.status))) return "waiting";
  return "idle";
}

function transitionPriority(status) {
  if (status === "failed") return 2;
  if (status === "completed") return 1;
  return 0;
}

export class PetStateController {
  constructor(options = {}) {
    this.onState = options.onState || (() => {});
    this.availableStates = normalizedAvailableStates(options.availableStates);
    this.tasks = new Map();
    this.statusByTask = new Map();
    this.feedbackKeys = new Set();
    this.initialized = false;
    this.generation = 0;
    this.current = { state: "idle", generation: 0, oneShot: false, count: 0 };
  }

  snapshot() {
    return { ...this.current };
  }

  setAvailableStates(states = null) {
    const next = normalizedAvailableStates(states);
    const previousKey = this.availableStates === null ? "*" : this.availableStates.join("\0");
    const nextKey = next === null ? "*" : next.join("\0");
    if (previousKey === nextKey) return false;
    this.availableStates = next;
    this.#publishBaseState();
    return true;
  }

  handleEvent(event, value) {
    if (event === "snapshot") {
      this.#handleSnapshot(value?.tasks || []);
      return;
    }
    if (event === "task.removed") {
      this.removeTask(value?.taskId);
      return;
    }
    if (["task.created", "task.updated"].includes(event)) this.updateTask(value);
  }

  #handleSnapshot(tasks) {
    if (!this.initialized) {
      this.tasks.clear();
      this.statusByTask.clear();
      for (const task of tasks) {
        if (!task?.taskId || task.threadSource === "subagent") continue;
        this.tasks.set(task.taskId, task);
        this.statusByTask.set(task.taskId, task.status);
      }
      this.initialized = true;
      this.#publishBaseState();
      return;
    }

    const incomingIds = new Set();
    let feedbackStatus = "";
    let feedbackKey = "";
    for (const task of tasks) {
      if (!task?.taskId || task.threadSource === "subagent") continue;
      incomingIds.add(task.taskId);
      const previousStatus = this.statusByTask.get(task.taskId);
      this.tasks.set(task.taskId, task);
      this.statusByTask.set(task.taskId, task.status);
      const candidateKey = `${task.taskId}:${task.status}`;
      if (previousStatus && previousStatus !== task.status
        && !this.feedbackKeys.has(candidateKey)
        && transitionPriority(task.status) > transitionPriority(feedbackStatus)) {
        feedbackStatus = task.status;
        feedbackKey = candidateKey;
      }
    }
    for (const taskId of this.tasks.keys()) {
      if (!incomingIds.has(taskId)) {
        this.tasks.delete(taskId);
        this.statusByTask.delete(taskId);
      }
    }
    if (TERMINAL_FEEDBACK[feedbackStatus]) {
      this.feedbackKeys.add(feedbackKey);
      this.#publishFeedback(TERMINAL_FEEDBACK[feedbackStatus]);
    }
    else if (this.current.oneShot) this.#refreshFeedbackCount();
    else this.#publishBaseState();
  }

  updateTask(task) {
    if (!task?.taskId || task.threadSource === "subagent") return;
    const previousStatus = this.statusByTask.get(task.taskId);
    this.tasks.set(task.taskId, task);
    this.statusByTask.set(task.taskId, task.status);
    const feedbackKey = `${task.taskId}:${task.status}`;
    if (this.initialized && previousStatus && previousStatus !== task.status
      && TERMINAL_FEEDBACK[task.status] && !this.feedbackKeys.has(feedbackKey)) {
      this.feedbackKeys.add(feedbackKey);
      this.#publishFeedback(TERMINAL_FEEDBACK[task.status]);
      return;
    }
    this.initialized = true;
    if (this.current.oneShot) {
      this.#refreshFeedbackCount();
      return;
    }
    this.#publishBaseState();
  }

  removeTask(taskId) {
    if (!taskId) return;
    this.tasks.delete(taskId);
    this.statusByTask.delete(taskId);
    if (this.current.oneShot) {
      this.#refreshFeedbackCount();
      return;
    }
    this.#publishBaseState();
  }

  acknowledgeAnimation(generation) {
    if (!this.current.oneShot || Number(generation) !== this.current.generation) return false;
    this.#publishBaseState();
    return true;
  }

  #publishFeedback(state) {
    if (this.availableStates !== null && !this.availableStates.includes(state)) {
      this.#publishBaseState();
      return;
    }
    this.generation += 1;
    this.#publish({ state, generation: this.generation, oneShot: true, count: this.tasks.size });
  }

  #publishBaseState() {
    this.#publish({
      state: resolveAvailablePetState(aggregatePetState(this.tasks), this.availableStates),
      generation: this.generation,
      oneShot: false,
      count: this.tasks.size,
    });
  }

  #refreshFeedbackCount() {
    this.#publish({ ...this.current, count: this.tasks.size });
  }

  #publish(next) {
    const unchanged = this.current.state === next.state
      && this.current.generation === next.generation
      && this.current.oneShot === next.oneShot
      && this.current.count === next.count;
    this.current = next;
    if (!unchanged) this.onState(this.snapshot());
  }
}

export { ACTIVE_STATUSES };
