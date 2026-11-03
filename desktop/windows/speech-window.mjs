import { WindowFacade, isolatedWebPreferences } from "./window-facade.mjs";

/** Hidden rendering host for speech; it is not a desktop display option. */
export class SpeechWindowFacade extends WindowFacade {
  constructor({ createWindow, preload, getServiceUrl, onClosed }) {
    super({
      createWindow, onClosed,
      getUrl: () => `${getServiceUrl()}/speech.html`,
      getOptions: () => ({
        width: 320, height: 180, show: false, skipTaskbar: true,
        webPreferences: isolatedWebPreferences(preload, { backgroundThrottling: false }),
      }),
    });
  }
}
