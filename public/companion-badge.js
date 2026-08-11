const badge = document.querySelector("#badge");
const count = document.querySelector("#count");
const sprite = document.querySelector("#pet-sprite");
let activePointerId = null;
let petRenderSequence = 0;

const renderer = new window.PetRenderer({
  root: badge,
  count,
  sprite,
  onAnimationEnd: (value) => window.companion?.petAnimationEnd(value),
});

function pointerPayload(event) {
  return {
    pointerId: event.pointerId,
    screenX: event.screenX,
    screenY: event.screenY,
    time: Date.now(),
  };
}

badge.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || activePointerId !== null) return;
  event.preventDefault();
  activePointerId = event.pointerId;
  badge.setPointerCapture(event.pointerId);
  window.companion?.petPointerDown(pointerPayload(event));
});

badge.addEventListener("pointermove", (event) => {
  if (event.pointerId !== activePointerId) return;
  window.companion?.petPointerMove(pointerPayload(event));
});

function finishPointer(event, cancelled) {
  if (event.pointerId !== activePointerId) return;
  const payload = pointerPayload(event);
  activePointerId = null;
  if (badge.hasPointerCapture(event.pointerId)) badge.releasePointerCapture(event.pointerId);
  if (cancelled) window.companion?.petPointerCancel(payload);
  else window.companion?.petPointerUp(payload);
}

badge.addEventListener("pointerup", (event) => finishPointer(event, false));
badge.addEventListener("pointercancel", (event) => finishPointer(event, true));
badge.addEventListener("lostpointercapture", (event) => {
  if (event.pointerId !== activePointerId) return;
  const payload = pointerPayload(event);
  activePointerId = null;
  window.companion?.petPointerCancel(payload);
});
badge.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.companion?.showBadgeMenu();
});
window.addEventListener("beforeunload", () => {
  if (activePointerId !== null) {
    window.companion?.petPointerCancel({ pointerId: activePointerId, screenX: 0, screenY: 0, time: Date.now() });
  }
});
function waitForPetAsset(assetUrl, timeoutMs = 4_000) {
  if (!assetUrl) return Promise.resolve();
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    image.onload = finish;
    image.onerror = finish;
    image.src = assetUrl;
    if (image.complete && image.naturalWidth > 0) finish();
  });
}

function waitForPetPaint(timeoutMs = 250) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

window.companion?.onPetState?.(async (payload) => {
  const sequence = ++petRenderSequence;
  const rendered = renderer.apply(payload);
  await waitForPetAsset(rendered.assetUrl);
  await waitForPetPaint();
  if (sequence !== petRenderSequence) return;
  window.companion?.petRendered({
    generation: rendered.generation,
    petId: payload?.pet?.id || "builtin-default",
  });
});
