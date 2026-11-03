const menu = document.querySelector("#pet-menu");
const buttons = [...menu.querySelectorAll("button")];
let revision = null;
function focusItem(index) {
  for (const [position, button] of buttons.entries()) button.tabIndex = position === index ? 0 : -1;
  buttons[index].focus({ preventScroll: true });
}
window.companion.onPetMenuState(state => {
  revision = state.revision;
  document.querySelector("#notebook-label").textContent = state.notebookVisible ? "隐藏记事板" : "显示记事板";
  focusItem(0);
  requestAnimationFrame(() => window.companion.petMenuReady(state.revision));
});
function dismiss() {
  if (revision === null) return;
  const current = revision; revision = null;
  window.companion.dismissPetMenu(current);
}
menu.addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button || revision === null) return;
  const current = revision; revision = null;
  window.companion.selectPetMenuAction({ action: button.dataset.action, revision: current }).catch(console.error);
});
window.addEventListener("keydown", event => {
  const index = Math.max(0, buttons.indexOf(document.activeElement));
  if (["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab", "Enter", " "].includes(event.key)) event.preventDefault();
  if (event.key === "ArrowDown") focusItem((index + 1) % buttons.length);
  else if (event.key === "ArrowUp") focusItem((index + buttons.length - 1) % buttons.length);
  else if (event.key === "Home") focusItem(0);
  else if (event.key === "End") focusItem(buttons.length - 1);
  else if (event.key === "Escape" || event.key === "Tab") dismiss();
  else if ((event.key === "Enter" || event.key === " ") && !event.repeat) buttons[index].click();
});
window.addEventListener("pointerdown", event => { if (!event.target.closest("#pet-menu")) dismiss(); });
window.addEventListener("contextmenu", event => event.preventDefault());
