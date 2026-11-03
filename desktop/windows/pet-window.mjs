import { WindowFacade, isolatedWebPreferences } from "./window-facade.mjs";

export class PetWindowFacade extends WindowFacade {
  constructor({ createWindow, preload, getServiceUrl, getPreferences, getInitialBounds,
    onCreated, onResize, onMoved, onVisibilityChanged }) {
    super({
      createWindow,
      getUrl: () => `${getServiceUrl()}/companion-badge.html`,
      getOptions: () => ({
        ...getInitialBounds(), show: false, frame: false, transparent: true,
        backgroundColor: "#00000000", alwaysOnTop: getPreferences().appearance.alwaysOnTop,
        skipTaskbar: true, resizable: false, movable: false, minimizable: false,
        maximizable: false, fullscreenable: false, hasShadow: false, focusable: false,
        webPreferences: isolatedWebPreferences(preload),
      }),
      configure: (window) => {
        window.setAlwaysOnTop(getPreferences().appearance.alwaysOnTop, "floating");
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.on("resize", onResize);
        window.on("moved", onMoved);
        window.on("show", onVisibilityChanged);
        window.on("hide", onVisibilityChanged);
        onCreated();
      },
    });
  }

  updateState(payload) { if (!this.isLoading()) this.send("pet:state", payload); }
}
