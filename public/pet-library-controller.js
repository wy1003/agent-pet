export const BUILTIN_LIBRARY_PET = Object.freeze({
  id: "builtin-default",
  displayName: "小团",
  description: "内置宠物",
});

// The settings page supplies the IPC and view interfaces; pet operations never own a window.
export class PetLibraryController {
  constructor({ api, view, confirm }) {
    this.api = api;
    this.view = view;
    this.confirm = confirm;
    this.state = { selectedPetId: BUILTIN_LIBRARY_PET.id, pets: [] };
    this.busy = false;
  }

  render(state) {
    this.state = state;
    this.view.render(state);
  }

  async load() {
    this.render(await this.api.getPetLibrary());
    this.view.status("", this.state.pets.length
      ? `已导入 ${this.state.pets.length} 个宠物，点击卡片即可切换。`
      : "点击卡片使用宠物，或在下方导入新的 ZIP。");
  }

  async perform(action, success, failure, progress = "") {
    if (this.busy) return false;
    this.busy = true;
    this.view.setBusy(true);
    if (progress) this.view.status("", progress);
    try {
      const state = await action();
      if (!state) return false; // File picker canceled.
      this.render(state);
      this.view.status("success", success(state));
      return true;
    } catch (error) {
      // Reconcile if the host completed an operation before its response failed.
      try { this.render(await this.api.getPetLibrary()); } catch {}
      this.view.status("error", `${failure}：${error.message || "请稍后重试"}`);
      return false;
    } finally {
      this.busy = false;
      this.view.setBusy(false);
    }
  }

  select(id) {
    const pet = id === BUILTIN_LIBRARY_PET.id ? BUILTIN_LIBRARY_PET : this.state.pets.find(pet => pet.id === id);
    if (!pet || this.busy || id === this.state.selectedPetId) return false;
    return this.perform(() => this.api.selectPet(id),
      () => `已切换为“${pet.displayName || pet.id}”。`, "切换失败", "正在切换宠物…");
  }

  remove(id) {
    const pet = this.state.pets.find(pet => pet.id === id);
    if (!pet || id === BUILTIN_LIBRARY_PET.id || this.busy) return false;
    const name = pet.displayName || pet.id;
    const isCurrent = id === this.state.selectedPetId;
    const message = isCurrent
      ? `“${name}”正在使用。删除后会切换为内置宠物“小团”。\n\n确定删除吗？`
      : `确定从宠物库删除“${name}”吗？`;
    if (!this.confirm(`${message}\n\n只删除应用管理的副本，原 ZIP 文件不受影响。`)) return false;
    return this.perform(() => this.api.removePet(id), state =>
      `已删除“${name}”。${isCurrent && state.selectedPetId === BUILTIN_LIBRARY_PET.id ? "已切换为内置宠物“小团”。" : ""}`,
    "删除失败", `正在删除“${name}”…`);
  }

  async importFile(filePath) {
    const archivePath = String(filePath || "");
    if (!archivePath.toLowerCase().endsWith(".zip")) throw new Error("请选择完整的 ZIP 宠物压缩包。");
    this.view.status("", "正在校验并复制宠物文件…");
    return this.api.importPetZip(archivePath);
  }

  importSuccess(state) {
    const pet = state.pets.find(pet => pet.id === state.selectedPetId);
    return `“${pet?.displayName || "宠物"}”已导入并启用。`;
  }

  importArchive(filePath) {
    return this.perform(() => this.importFile(filePath), state => this.importSuccess(state), "导入失败");
  }

  chooseArchive() {
    return this.perform(async () => {
      const result = await this.api.selectPetZip();
      return result?.canceled || !result?.path ? null : this.importFile(result.path);
    }, state => this.importSuccess(state), "导入失败");
  }
}
