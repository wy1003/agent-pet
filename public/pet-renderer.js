class PetRenderer {
  constructor(options) {
    this.root = options.root;
    this.sprite = options.sprite;
    this.count = options.count;
    this.onAnimationEnd = options.onAnimationEnd || (() => {});
    this.profile = {};
    this.frameRequest = null;
    this.fallbackTimer = null;
    this.startedAt = 0;
    this.payload = null;
    this.signature = "";
    this.reportedGeneration = null;
    this.isGifMode = false;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stopFrameLoop();
      else if (this.payload) this.restartAnimation();
    });
  }

  apply(payload) {
    if (!payload) return;
    this.payload = payload;
    this.profile = payload.animationProfile || this.profile;
    const signature = `${payload.pet?.id || "builtin-default"}:${payload.state}:${payload.generation}:${payload.oneShot}`;
    this.root.dataset.state = payload.state || "idle";
    this.renderCount(payload.count);
    this.configureSprite(payload.pet || {});
    if (signature !== this.signature) {
      this.signature = signature;
      this.reportedGeneration = null;
      this.restartAnimation();
    }
  }

  renderCount(value) {
    const size = Math.max(0, Number(value) || 0);
    this.count.hidden = size === 0;
    this.count.textContent = size > 99 ? "99+" : String(size);
    this.root.setAttribute("aria-label", size ? `打开任务列表，共 ${size} 项待处理` : "打开任务列表");
    window.companion?.updateSummary({ count: size, state: this.payload?.state || "idle" });
  }

  configureSprite(pet) {
    const stateUrls = pet?.format === "state-gifs" ? pet.stateUrls || {} : {};
    const stateUrl = String(stateUrls[this.payload?.state] || stateUrls.idle || "");
    if (stateUrl) {
      this.isGifMode = true;
      this.root.classList.add("has-sprite");
      this.sprite.hidden = false;
      this.sprite.removeAttribute("data-version");
      this.sprite.style.backgroundImage = `url("${stateUrl.replaceAll('"', "%22")}")`;
      this.sprite.style.backgroundSize = "contain";
      this.sprite.style.backgroundPosition = "center";
      this.sprite.style.imageRendering = pet.renderMode === "pixelated" ? "pixelated" : "auto";
      return;
    }

    this.isGifMode = false;
    const spriteUrl = String(pet.spriteUrl || "");
    const hasSprite = Boolean(spriteUrl);
    this.root.classList.toggle("has-sprite", hasSprite);
    this.sprite.hidden = !hasSprite;
    if (!hasSprite) {
      this.sprite.style.backgroundImage = "";
      return;
    }
    this.sprite.dataset.version = Number(pet.spriteVersionNumber) === 2 ? "2" : "1";
    this.sprite.style.backgroundImage = `url("${spriteUrl.replaceAll('"', "%22")}")`;
    this.sprite.style.imageRendering = pet.renderMode === "smooth" ? "auto" : "pixelated";
  }

  reducedMotion() {
    const setting = this.payload?.pet?.reducedMotion;
    if (setting === "reduce") return true;
    if (setting === "full") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  restartAnimation() {
    this.stopFrameLoop();
    clearTimeout(this.fallbackTimer);
    if (!this.payload) return;
    this.startedAt = performance.now();
    if (this.reducedMotion()) {
      if (!this.isGifMode) this.renderFrame(0);
      if (this.payload.oneShot) this.finishOneShot();
      return;
    }
    if (this.root.classList.contains("has-sprite") && !this.isGifMode) {
      this.frameRequest = requestAnimationFrame((time) => this.tick(time));
      return;
    }
    if (this.payload.oneShot) {
      const animation = this.profile[this.payload.state] || {};
      const cycle = (animation.durations || [600]).reduce((total, duration) => total + duration, 0);
      this.fallbackTimer = setTimeout(() => this.finishOneShot(), cycle * (animation.loops || 3));
    }
  }

  stopFrameLoop() {
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
  }

  tick(time) {
    const frame = this.renderFrame(time - this.startedAt);
    const animation = this.profile[this.payload?.state] || this.profile.idle || {};
    const requiredLoops = animation.loops || 3;
    if (this.payload?.oneShot && frame.completedLoops >= requiredLoops) {
      this.finishOneShot();
      return;
    }
    this.frameRequest = requestAnimationFrame((nextTime) => this.tick(nextTime));
  }

  renderFrame(elapsedMs) {
    const state = this.payload?.state || "idle";
    const animation = this.profile[state] || this.profile.idle || { row: 0, durations: [1000] };
    const multiplier = state === "idle" ? animation.idleMultiplier || 1 : 1;
    const durations = (animation.durations || [1000]).map((duration) => duration * multiplier);
    const cycleDuration = durations.reduce((total, duration) => total + duration, 0);
    const completedLoops = cycleDuration ? Math.floor(Math.max(0, elapsedMs) / cycleDuration) : 0;
    let remainder = cycleDuration ? Math.max(0, elapsedMs) % cycleDuration : 0;
    let column = durations.length - 1;
    for (let index = 0; index < durations.length; index += 1) {
      if (remainder < durations[index]) {
        column = index;
        break;
      }
      remainder -= durations[index];
    }
    const version = this.sprite.dataset.version === "2" ? 2 : 1;
    const rows = version === 2 ? 11 : 9;
    this.sprite.style.backgroundSize = `800% ${rows * 100}%`;
    this.sprite.style.backgroundPosition = `${column / 7 * 100}% ${animation.row / (rows - 1) * 100}%`;
    return { column, row: animation.row, completedLoops, cycleDuration };
  }

  finishOneShot() {
    this.stopFrameLoop();
    if (!this.payload?.oneShot || this.reportedGeneration === this.payload.generation) return;
    this.reportedGeneration = this.payload.generation;
    this.onAnimationEnd({ state: this.payload.state, generation: this.payload.generation });
  }
}

window.PetRenderer = PetRenderer;
