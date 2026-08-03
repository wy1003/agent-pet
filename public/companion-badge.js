const badge = document.querySelector("#badge");
const count = document.querySelector("#count");
const sprite = document.querySelector("#pet-sprite");
let activePointerId = null;

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
window.companion?.onPetState?.((payload) => renderer.apply(payload));
