import { renderUsageMeter } from "./usage-meter.mjs";

const root = document.querySelector("#usage-card-root");
let loading = false;

function reportSize() {
  requestAnimationFrame(() => {
    window.companion?.resizeUsageCard?.({
      width: Math.ceil(document.documentElement.scrollWidth),
      height: Math.ceil(document.documentElement.scrollHeight),
    });
  });
}

async function loadUsage({ force = false } = {}) {
  if (loading || !window.companion?.getUsage) return;
  loading = true;
  root.setAttribute("aria-busy", "true");
  try {
    const snapshot = await window.companion.getUsage({ force });
    root.replaceChildren(renderUsageMeter(snapshot, {
      onRefresh: () => loadUsage({ force: true }),
    }));
  } catch {
    root.replaceChildren(renderUsageMeter({
      providerId: "codex",
      viewType: "unavailable",
      status: "error",
      message: "暂时无法读取通用额度。",
    }, { onRefresh: () => loadUsage({ force: true }) }));
  } finally {
    root.setAttribute("aria-busy", "false");
    loading = false;
    reportSize();
  }
}

window.companion?.onUsageCardShown?.(() => loadUsage());
if ("ResizeObserver" in window) new ResizeObserver(reportSize).observe(root);
