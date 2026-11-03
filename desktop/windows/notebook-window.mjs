import { WindowFacade, isolatedWebPreferences } from "./window-facade.mjs";
import { NOTEBOOK_WINDOW_SIZE, NOTEBOOK_ORB_SIZE } from "./window-contracts.mjs";

/**
 * Owns the notebook surface; local data is accessed through the authorized repository interface.
 * @implements {import('./window-contracts.mjs').NotebookWindowPort}
 */
export class NotebookWindowFacade extends WindowFacade {
  #applyAppearance = null;
  #appearance = { style: "classic" };
  #readBackground = null;
  #collapsed = false;
  constructor({ createWindow, preload, getServiceUrl, getPreferences, getWorkArea,
    isQuitting, onHide, onMoved = () => {}, onBlur = () => {}, getBackgroundSource = async () => null,
    toScreenRect = bounds => bounds }) {
    super({
      createWindow,
      getUrl: () => `${getServiceUrl()}/notebook.html`,
      getOptions: () => ({
        title: "记事板 · Agent Pet",
        width: Math.min((this.#collapsed ? NOTEBOOK_ORB_SIZE : NOTEBOOK_WINDOW_SIZE).width, getWorkArea().width - 24),
        height: Math.min((this.#collapsed ? NOTEBOOK_ORB_SIZE : NOTEBOOK_WINDOW_SIZE).height, getWorkArea().height - 24),
        // The page owns the entire visible surface, including its rounded corners.
        show: false, frame: false, hasShadow: false, transparent: true,
        backgroundColor: "#00000000", alwaysOnTop: getPreferences().appearance.notebookAlwaysOnTop !== false,
        skipTaskbar: true, resizable: false, maximizable: false, fullscreenable: false,
        webPreferences: isolatedWebPreferences(preload),
      }),
      configure: (window) => {
        const viewport = () => toScreenRect(window.getBounds());
        this.#readBackground = () => getBackgroundSource(viewport());
        const sendPosition = () => this.send("notebook:background-position", viewport());
        window.on("move", sendPosition);
        window.on("resize", sendPosition);
        window.on("show", () => { sendPosition(); this.send("notebook:visibility-changed", true); });
        window.on("hide", () => this.send("notebook:visibility-changed", false));
        this.#applyAppearance = () => {
          const style = getPreferences().appearance.notebookStyle === "glass" ? "glass" : "classic";
          this.#appearance = { style };
          this.send("notebook:appearance-changed", this.getAppearance());
        };
        this.applyAppearance();
        window.setAlwaysOnTop(getPreferences().appearance.notebookAlwaysOnTop !== false, "floating");
        window.on("move", onMoved);
        window.on("blur", onBlur);
        window.on("close", (event) => {
          if (isQuitting()) return;
          event.preventDefault();
          onHide();
        });
      },
      onClosed: () => { this.#applyAppearance = null; this.#readBackground = null; },
    });
  }
  applyAppearance() { this.#applyAppearance?.(); }
  getAppearance() { return { ...this.#appearance }; }
  setCollapsed(value) {
    this.#collapsed = value === true;
    this.send("notebook:presentation-changed", this.getPresentation());
  }
  getPresentation() { return { collapsed: this.#collapsed }; }
  async getBackground() {
    if (!this.isVisible() || this.#collapsed || this.#appearance.style !== "glass") return null;
    const read = this.#readBackground, result = await read?.();
    return this.isVisible() && !this.#collapsed && this.#appearance.style === "glass" && read === this.#readBackground ? result : null;
  }
}
