import { WindowFacade, isolatedWebPreferences } from "./window-facade.mjs";
import { PET_MENU_SIZE } from "./window-contracts.mjs";

/** Owns only the menu surface and its renderer handshake. */
export class PetMenuWindowFacade extends WindowFacade {
  #pending = null;
  constructor({ createWindow, preload, getServiceUrl, onDismiss }) {
    super({ createWindow,
      getUrl: () => `${getServiceUrl()}/pet-menu.html`,
      getOptions: () => ({ ...PET_MENU_SIZE, show: false, frame: false, transparent: true,
        title: "宠物菜单 · Agent Pet", backgroundColor: "#00000000", alwaysOnTop: true,
        skipTaskbar: true, resizable: false, movable: false, minimizable: false,
        maximizable: false, fullscreenable: false, hasShadow: false,
        webPreferences: isolatedWebPreferences(preload, { backgroundThrottling: false }),
      }),
      configure: window => {
        window.setAlwaysOnTop(true, "pop-up-menu");
        window.on("blur", onDismiss);
        window.on("close", event => { event.preventDefault(); onDismiss(); });
      },
    });
  }
  render(state) {
    this.#cancel();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(new Error("Pet menu renderer did not become ready"));
      }, 2_000);
      this.#pending = { revision: state.revision, resolve, timer };
      this.send("pet-menu:state", state);
    });
  }
  acknowledge(revision) {
    if (this.#pending?.revision !== revision) return;
    const pending = this.#pending; this.#pending = null;
    clearTimeout(pending.timer); pending.resolve(true);
  }
  #cancel() {
    if (!this.#pending) return;
    clearTimeout(this.#pending.timer); this.#pending.resolve(false); this.#pending = null;
  }
  hide() { this.#cancel(); super.hide(); }
  destroy() { this.#cancel(); super.destroy(); }
}
