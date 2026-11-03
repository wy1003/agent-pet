import { WindowFacade, isolatedWebPreferences } from "./window-facade.mjs";

export class DailyReportWindowFacade extends WindowFacade {
  constructor({ createWindow, preload, getServiceUrl, productName, getIcon, isDark }) {
    super({
      createWindow,
      getUrl: () => `${getServiceUrl()}/daily-report.html`,
      getOptions: () => ({
        width: 500, height: 560, minWidth: 400, minHeight: 420, show: false,
        title: `今日工作日报 · ${productName}`, icon: getIcon(),
        backgroundColor: isDark() ? "#1e221f" : "#f3f2ed", autoHideMenuBar: true,
        webPreferences: isolatedWebPreferences(preload),
      }),
    });
  }
}
