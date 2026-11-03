import { BUILTIN_LIBRARY_PET } from "./pet-library-controller.js";

export function petPreview(pet) {
  if (pet.id === BUILTIN_LIBRARY_PET.id) {
    return { url: "/assets/pets/builtin-default/builtin-default-idle.gif", rows: 1, columns: 1 };
  }
  const file = pet.format === "spritesheet"
    ? pet.spritesheetPath
    : pet.states?.idle || Object.values(pet.states || {})[0];
  if (!file) return null;
  return {
    url: `pet-asset://library/${encodeURIComponent(pet.id)}/${encodeURIComponent(file)}`,
    rows: pet.format === "spritesheet" ? (Number(pet.spriteVersionNumber) === 2 ? 11 : 9) : 1,
    columns: pet.format === "spritesheet" ? 8 : 1,
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export class PetLibraryView {
  constructor({ grid, status, importButton, onSelect, onRemove }) {
    this.grid = grid;
    this.statusNode = status;
    this.importButton = importButton;
    this.onSelect = onSelect;
    this.onRemove = onRemove;
    this.busy = false;
    this.focusTarget = null;
    grid.addEventListener("click", event => {
      const action = event.target.closest("[data-pet-action]");
      if (!action || this.busy) return;
      if (action.dataset.petAction === "select") this.onSelect(action.dataset.petId);
      if (action.dataset.petAction === "remove") this.onRemove(action.dataset.petId);
    });
    document.addEventListener("click", event => {
      for (const menu of grid.querySelectorAll("details[open]")) {
        if (!menu.contains(event.target)) menu.open = false;
      }
    });
    grid.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      const menu = event.target.closest("details[open]");
      if (menu) {
        menu.open = false;
        menu.querySelector("summary").focus();
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }

  status(state, message) {
    this.statusNode.dataset.state = state || "";
    this.statusNode.textContent = message;
  }

  render(state) {
    this.selectedId = state.selectedPetId || BUILTIN_LIBRARY_PET.id;
    const top = this.grid.scrollTop;
    this.grid.replaceChildren(...[BUILTIN_LIBRARY_PET, ...(state.pets || [])]
      .map(pet => this.createCard(pet)));
    this.grid.scrollTop = top;
    this.statusNode.title = state.rootPath || "";
    this.setBusy(this.busy);
  }

  createCard(pet) {
    const name = pet.displayName || pet.id;
    const selected = this.selectedId === pet.id;
    const builtin = pet.id === BUILTIN_LIBRARY_PET.id;
    const card = element("article", "pet-card");
    card.dataset.petId = pet.id;
    card.dataset.selected = String(selected);
    const select = element("button", "pet-card-select");
    select.type = "button";
    select.dataset.petAction = "select";
    select.dataset.petId = pet.id;
    select.setAttribute("aria-label", `${selected ? "正在使用" : "使用"}“${name}”${builtin ? "（内置）" : ""}`);
    select.setAttribute("aria-pressed", String(selected));
    const preview = element("span", "pet-card-preview");
    preview.setAttribute("aria-hidden", "true");
    const source = petPreview(pet);
    if (source) {
      const img = element("img", "pet-card-image");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.style.width = `${source.columns * 100}%`;
      img.style.height = `${source.rows * 100}%`;
      img.addEventListener("error", () => {
        preview.replaceChildren(element("span", "pet-preview-unavailable", "预览不可用"));
      }, { once: true });
      img.src = source.url;
      preview.append(img);
    } else {
      preview.append(element("span", "pet-preview-unavailable", "暂无预览"));
    }
    const title = element("strong", "pet-card-name", name);
    title.title = name;
    select.append(preview, title);
    card.append(select);
    if (selected || builtin) {
      card.append(element("span", `pet-card-badge${selected ? " is-current" : ""}`, selected ? "✓ 使用中" : "内置"));
    }
    if (!builtin) {
      const menu = element("details", "pet-card-menu");
      const toggle = element("summary", "pet-card-more", "⋯");
      toggle.setAttribute("aria-label", `管理“${name}”`);
      toggle.title = `管理“${name}”`;
      toggle.addEventListener("click", event => {
        if (this.busy) event.preventDefault();
        for (const other of this.grid.querySelectorAll("details[open]")) {
          if (other !== menu) other.open = false;
        }
      });
      const remove = element("button", "pet-card-delete", "删除宠物");
      remove.type = "button";
      remove.dataset.petAction = "remove";
      remove.dataset.petId = pet.id;
      remove.setAttribute("aria-label", `删除“${name}”`);
      menu.append(toggle, remove);
      card.append(menu);
    }
    return card;
  }

  setBusy(busy) {
    if (busy && !this.busy && this.grid.contains(document.activeElement)) {
      const active = document.activeElement;
      this.focusTarget = { id: active.dataset.petId, action: active.dataset.petAction };
    }
    this.busy = busy;
    this.grid.setAttribute("aria-busy", String(busy));
    this.importButton.disabled = busy;
    for (const button of this.grid.querySelectorAll("button")) button.disabled = busy;
    for (const summary of this.grid.querySelectorAll("summary")) {
      summary.tabIndex = busy ? -1 : 0;
      summary.setAttribute("aria-disabled", String(busy));
    }
    if (busy) {
      for (const menu of this.grid.querySelectorAll("details[open]")) menu.open = false;
    } else if (this.focusTarget) {
      const buttons = [...this.grid.querySelectorAll('[data-pet-action="select"]')];
      const target = buttons.find(button => button.dataset.petId === this.focusTarget.id)
        || buttons.find(button => button.dataset.petId === this.selectedId);
      target?.focus({ preventScroll: true });
      this.focusTarget = null;
    }
  }
}
