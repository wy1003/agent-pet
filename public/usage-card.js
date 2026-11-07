import { renderUsageMeter } from "./usage-meter.mjs";

const root = document.querySelector("#usage-card-root");
const sources = [
  { providerId: "codex", displayName: "Codex", viewType: "codex-quota" },
  { providerId: "claude", displayName: "Claude Code", viewType: "claude-quota" },
];
let loading = false;

function reportSize() {
  requestAnimationFrame(() => {
    window.companion?.resizeUsageCard?.({
      width: Math.ceil(document.documentElement.scrollWidth),
      // Measure content, not the viewport: the facade may clamp height on small screens.
      height: Math.ceil(root.getBoundingClientRect().height) + 14,
    });
  });
}

function renderProviders(providers) {
  if (!providers.length) {
    const empty = document.createElement('p');
    empty.textContent = '尚未连接智能体，请在设置中连接后查看额度。';
    root.replaceChildren(empty);
    return;
  }
  root.replaceChildren(...providers.map(snapshot => {
    const source = sources.find(item => item.providerId === snapshot.providerId);
    // The quota renderers keep provider identity and retry controls even when unavailable.
    return renderUsageMeter({ ...snapshot, ...(source || {}) }, {
      onRefresh: () => loadUsage({ force: true }),
    });
  }));
}

async function loadUsage({ force = false } = {}) {
  if (loading || !window.companion?.getAllUsage) return;
  loading = true;
  root.setAttribute("aria-busy", "true");
  try {
    const snapshot = await window.companion.getAllUsage({ force });
    renderProviders(snapshot.providers);
  } catch {
    renderProviders(sources.map(source => ({
      ...source,
      status: "unavailable",
      message: "暂时无法读取该来源额度，请稍后刷新。",
    })));
  } finally {
    root.setAttribute("aria-busy", "false");
    loading = false;
    reportSize();
  }
}

window.companion?.onUsageCardShown?.(() => loadUsage());
if ("ResizeObserver" in window) new ResizeObserver(reportSize).observe(root);
