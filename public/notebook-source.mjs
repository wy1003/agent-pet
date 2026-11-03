/** Cached read model; mutations are acknowledged only after the main process writes the file. */
export function createNotebookSource(bridge) {
  let snapshot = { plans: [], ideas: [], warnings: [] };
  let issued = 0, applied = 0;
  async function accept(promise) {
    const sequence = ++issued;
    const reply = await promise;
    if (!reply?.ok) throw new Error(reply?.message || "无法读取本地记事板，请重试。");
    if (sequence >= applied) { snapshot = reply.snapshot; applied = sequence; }
    return reply.result;
  }
  const command = value => accept(bridge.updateNotebook(value));
  return {
    load: () => accept(bridge.getNotebook()),
    getSnapshot: () => structuredClone(snapshot),
    add: (kind, value) => command({ type: kind === "plans" ? "create-plan" : "create-idea", value }),
    updatePlan(id, value) {
      const revision = value.revision ?? snapshot.plans.find(plan => plan.id === id)?.revision;
      return command({ type: "edit-plan", id, value, revision });
    },
    updateIdea: (id, value, revision) => command({ type: "edit-idea", id, value, revision }),
    setCompleted: (id, done) => command({ type: "set-completed", id, done }),
    convertIdea: id => command({ type: "convert-idea", id }),
    archive: ids => command({ type: "archive", ids }),
    restore: (ids, batchId) => command({ type: "restore", ids, batchId }),
    remove: id => command({ type: "delete-plan", id }),
  };
}
