import { WindowFacade, isolatedWebPreferences } from "./window-facade.mjs";

export class SettingsWindowFacade extends WindowFacade {
  constructor({ createWindow, preload, getServiceUrl, productName, getIcon, isDark, showOpenDialog }) {
    super({
      createWindow, showOpenDialog,
      getUrl: () => `${getServiceUrl()}/settings.html`,
      getOptions: () => ({
        width: 620, height: 760, minWidth: 520, minHeight: 620, show: false,
        title: `设置 · ${productName}`, icon: getIcon(),
        backgroundColor: isDark() ? "#1e221f" : "#f3f2ed", autoHideMenuBar: true,
        webPreferences: isolatedWebPreferences(preload),
      }),
    });
  }
}
