/* SensualXcape atelier: small, original CPU stable-fluid solver and smoke renderer.
 * The colour field is advected by a projected velocity field. This is Web Canvas,
 * independent of HTML-in-Canvas availability; it never captures private files.
 */

  'use strict';

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const PALETTES = {
    noir: [[1, .035, .19], [.76, .055, .91], [.28, .32, .64]],
    rose: [[.9, .035, .23], [.69, .08, .65], [.26, .27, .73]],
    neon: [[1, .1, .67], [.44, .1, 1], [.03, .82, 1]]
  };

export class SXFluid {
    constructor({host, onStatus = () => {}, onFrame = () => {}, palette = 'noir'} = {}) {
      if (!host) throw new TypeError('SXFluid needs a host element.');
      this.host = host; this.d = host.ownerDocument; this.w = this.d.defaultView; this.onStatus = onStatus; this.onFrame = onFrame; this.enabled = true;
      this.ready = false;
      this.destroyed = false; this.visible = true; this.frame = 0;
      this.activeUntil = 0; this.lastFrame = 0; this.hue = 0;
      this.palette = PALETTES[palette] ? palette : 'noir';
      this.previous = new Map(); this.cleanup = [];
      this.oldPosition = host.style.position;
      if (this.w.getComputedStyle(host).position === 'static') host.style.position = 'relative';
      this.canvas = this.d.createElement('canvas');
      this.canvas.className = 'sx-liquid-smoke';
      this.canvas.setAttribute('aria-hidden', 'true');
      Object.assign(this.canvas.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '2', borderRadius: 'inherit'
      });
      host.append(this.canvas);
      this.context = (typeof this.w.CanvasRenderingContext2D === 'function' ? this.canvas.getContext('2d', {alpha: true, desynchronized: true}) : null);
      if (!this.context) { this.canvas.hidden = true; this._status('static', 'Canvas 2D no disponible; se conserva la imagen.'); return; }
      this.texture = this.d.createElement('canvas');
      this.textureContext = this.texture.getContext('2d', {alpha: true});
      this.flowCanvas = this.d.createElement('canvas');
      this.flowContext = this.flowCanvas.getContext('2d', {alpha: false});
      this.motion = (this.w.matchMedia?.('(prefers-reduced-motion: reduce)') || {matches:false,addEventListener(){},removeEventListener(){}});
      this._listen(this.motion, 'change', () => this._visibility());
      this._listen(this.d, 'visibilitychange', () => this._visibility());
      this._listen(host, 'pointerdown', event => this._pointer(event), {passive: true});
      this._listen(host, 'pointermove', event => this._pointer(event), {passive: true});
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
        this._listen(host, type, event => this.previous.delete(event.pointerId), {passive: true});
      }
      this.resizeObserver = this.w.ResizeObserver ? new this.w.ResizeObserver(() => this._resize()) : null;
      this.resizeObserver?.observe(host);
      if ('IntersectionObserver' in this.w) {
        this.intersectionObserver = new this.w.IntersectionObserver(entries => {
          this.visible = entries[0].isIntersecting;
          this._visibility();
        });
        this.intersectionObserver.observe(host);
      }
      this._resize();
      if (!this.context || !this.textureContext) {
        this._status('static', 'Este navegador no permite el renderizado Canvas 2D.');
        return;
      }
      this._status(this.motion.matches ? 'static' : 'fluid', this.motion.matches
        ? 'Humo estático por tu preferencia de movimiento reducido.'
        : 'Fluido 2D: advección, presión y vorticidad; independiente de HIC.');
      this.ready = true;
      this._seedRibbon();
}
    _status(mode, reason) {
      try { this.onStatus({mode, reason}); } catch (_) {}
    }

    _listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      this.cleanup.push(() => target.removeEventListener(type, handler, options));
    }

    _resize() {
      if (this.destroyed || !this.context) return;
      const rect = this.host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const cssWidth = Math.max(1, rect.width), cssHeight = Math.max(1, rect.height);
      const dpr = Math.min(this.w.devicePixelRatio || 1, 1.5);
      const pixelWidth = Math.round(cssWidth * dpr), pixelHeight = Math.round(cssHeight * dpr);
      const width = clamp(Math.round(cssWidth / 6), 48, 100);
      const height = clamp(Math.round(cssHeight * width / cssWidth), 42, 132);
      if (width === this.width && height === this.height && this.canvas.width === pixelWidth && this.canvas.height === pixelHeight) return;
      this.width = width; this.height = height; this.size = width * height;
      this.canvas.width = pixelWidth; this.canvas.height = pixelHeight;
      this.texture.width = width; this.texture.height = height;
      this.flowCanvas.width = width; this.flowCanvas.height = height;
      const array = () => new Float32Array(this.size);
      this.u = array(); this.v = array(); this.u0 = array(); this.v0 = array();
      this.r = array(); this.g = array(); this.b = array();
      this.r0 = array(); this.g0 = array(); this.b0 = array();
      this.pressure = array(); this.pressure0 = array();
      this.divergence = array(); this.curl = array();
      if (this.textureContext) this.pixels = this.textureContext.createImageData(width, height);
      if (this.flowContext) this.flowPixels = this.flowContext.createImageData(width, height);
      if (this.ready && this.enabled) this._seedRibbon();
    }

    _pointer(event) {
      if (!this.enabled || this.destroyed || !this.width) return;
      const target = event.target?.closest ? event.target : event.target?.parentElement;
      const control = target?.closest('button,a,input,textarea,select,summary,[role="button"]');
      if (target?.closest('[data-sx-fluid-ignore]') || (control && !target.closest('.sx-cofre-chest-touch,.vo-card'))) {
        this.previous.delete(event.pointerId); return;
      }
      if (event.pointerType === 'touch' && event.type === 'pointermove' && !this.previous.has(event.pointerId)) return;
      const rect = this.host.getBoundingClientRect();
      const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
      const previous = this.previous.get(event.pointerId);
      this.previous.set(event.pointerId, {x, y});
      if (event.type === 'pointerdown') this.burst(x, y);
      else if (previous) {
        const dx = x - previous.x, dy = y - previous.y;
        if (Math.abs(dx) + Math.abs(dy) > .0007) this.splat(x, y, dx, dy, 1);
      }
    }

    _inject(x, y, dx, dy, power, hue, radius = 1.85) {
      if (!this.width || !Number.isFinite(x + y + dx + dy + power)) return;
      const width = this.width, height = this.height;
      const px = clamp(x, 0, 1) * (width - 1), py = clamp(y, 0, 1) * (height - 1);
      const velocityX = clamp(dx * width * 42, -100, 100);
      const velocityY = clamp(dy * height * 42, -100, 100);
      const colour = PALETTES[this.palette][hue % 3];
      const reach = Math.ceil(radius * 2.7), radiusSquared = radius * radius;
      const left = Math.max(1, Math.floor(px) - reach), right = Math.min(width - 2, Math.ceil(px) + reach);
      const top = Math.max(1, Math.floor(py) - reach), bottom = Math.min(height - 2, Math.ceil(py) + reach);
      // One coherent handedness: crossing colour sources must not cancel the curl.
      const spin = 2.6;
      for (let iy = top; iy <= bottom; iy++) {
        for (let ix = left; ix <= right; ix++) {
          const ox = ix - px, oy = iy - py;
          const weight = Math.exp(-(ox * ox + oy * oy) / radiusSquared) * power;
          const index = ix + iy * width;
          this.u[index] = clamp(this.u[index] + (velocityX - oy * spin) * weight, -130, 130);
          this.v[index] = clamp(this.v[index] + (velocityY + ox * spin) * weight, -130, 130);
          const existing = Math.max(this.r[index], this.g[index], this.b[index]);
          const saturation = 1 - Math.min(.84, existing / 1.05);
          const accentWeight = this.palette === 'noir' && hue % 3 === 2 ? .5 : 1;
          const amount = weight * .58 * saturation * accentWeight;
          this.r[index] = Math.min(1.65, this.r[index] + colour[0] * amount);
          this.g[index] = Math.min(1.65, this.g[index] + colour[1] * amount);
          this.b[index] = Math.min(1.65, this.b[index] + colour[2] * amount);
        }
      }
    }

    _seedRibbon() {
      if (!this.enabled || this.destroyed || !this.context || !this.width) return;
      for (let i = 0; i < 28; i++) {
        const t = i / 27;
        const x = .07 + t * .86;
        const y = .66 - t * .23 + Math.sin(t * Math.PI * 2.8) * .085;
        const dx = .022 + Math.cos(t * 10) * .015;
        const dy = Math.cos(t * Math.PI * 2.8) * .025;
        const hue = i % 8 === 0 ? 2 : i % 2;
        this._inject(x, y, dx, dy, .43, hue, 1.6);
      }
      for (let i = 0; i < 3; i++) this._step(1 / 30);
      this._draw();
      this._wake(6500);
    }

    _advect(destination, source, u, v, dt, decay) {
      const width = this.width, height = this.height;
      for (let y = 1; y < height - 1; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
          const index = row + x;
          const px = clamp(x - dt * u[index], .5, width - 1.5);
          const py = clamp(y - dt * v[index], .5, height - 1.5);
          const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0;
          const i0 = y0 * width + x0, i1 = i0 + width;
          destination[index] = ((source[i0] * (1 - tx) + source[i0 + 1] * tx) * (1 - ty)
            + (source[i1] * (1 - tx) + source[i1 + 1] * tx) * ty) * decay;
        }
      }
    }

    _step(dt) {
      const width = this.width, height = this.height;
      const {u, v, curl, divergence} = this;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          curl[i] = (v[i + 1] - v[i - 1] - u[i + width] + u[i - width]) * .5;
        }
      }
      for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
          const i = y * width + x;
          const gx = (Math.abs(curl[i + 1]) - Math.abs(curl[i - 1])) * .5;
          const gy = (Math.abs(curl[i + width]) - Math.abs(curl[i - width])) * .5;
          const inverseLength = 1 / (Math.sqrt(gx * gx + gy * gy) + .001);
          const strength = curl[i] * 14 * dt;
          u[i] = clamp(u[i] + gy * inverseLength * strength, -130, 130);
          v[i] = clamp(v[i] - gx * inverseLength * strength - .4 * dt, -130, 130);
        }
      }

      this._advect(this.u0, u, u, v, dt, Math.exp(-dt * .58));
      this._advect(this.v0, v, u, v, dt, Math.exp(-dt * .58));
      this.u = this.u0; this.u0 = u; this.v = this.v0; this.v0 = v;
      const velocityX = this.u, velocityY = this.v;
      this.pressure.fill(0); this.pressure0.fill(0);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          divergence[i] = -.5 * (velocityX[i + 1] - velocityX[i - 1] + velocityY[i + width] - velocityY[i - width]);
        }
      }
      for (let iteration = 0; iteration < 10; iteration++) {
        const current = this.pressure, next = this.pressure0;
        for (let y = 1; y < height - 1; y++) {
          for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            next[i] = (divergence[i] + current[i - 1] + current[i + 1] + current[i - width] + current[i + width]) * .25;
          }
        }
        this.pressure = next; this.pressure0 = current;
      }
      const pressure = this.pressure;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          velocityX[i] -= .5 * (pressure[i + 1] - pressure[i - 1]);
          velocityY[i] -= .5 * (pressure[i + width] - pressure[i - width]);
        }
      }
      const dissipation = Math.exp(-dt * .88);
      this._advect(this.r0, this.r, velocityX, velocityY, dt, dissipation);
      this._advect(this.g0, this.g, velocityX, velocityY, dt, dissipation);
      this._advect(this.b0, this.b, velocityX, velocityY, dt, dissipation);
      let swap = this.r; this.r = this.r0; this.r0 = swap;
      swap = this.g; this.g = this.g0; this.g0 = swap;
      swap = this.b; this.b = this.b0; this.b0 = swap;
    }

    _draw() {
      if (!this.context || !this.pixels || this.destroyed) return;
      const rgba = this.pixels.data, flow = this.flowPixels?.data;
      const width = this.width, height = this.height;
      const strength = this.palette === 'rose' ? .87 : 1;
      for (let y = 0; y < height; y++) {
        const ey = Math.max(0, Math.min(1, y / (height * .12), (height - 1 - y) / (height * .12)));
        const edgeY = ey * ey * (3 - 2 * ey);
        for (let x = 0; x < width; x++) {
          const i = y * width + x, p = i * 4;
          const r = this.r[i], g = this.g[i], b = this.b[i];
          const density = Math.max(r, g, b);
          if (flow) {
            // RG: .5 is still; +/-50 cells/second covers the unit range.
            // B: local smoke concentration. A: opaque texture for a flow shader.
            flow[p] = Math.round(clamp(.5 + this.u[i] / 100, 0, 1) * 255);
            flow[p + 1] = Math.round(clamp(.5 + this.v[i] / 100, 0, 1) * 255);
            flow[p + 2] = Math.round(Math.min(1, density * 1.8) * 255);
            flow[p + 3] = 255;
          }
          const ex = Math.max(0, Math.min(1, x / (width * .12), (width - 1 - x) / (width * .12)));
          const edge = edgeY * ex * ex * (3 - 2 * ex);
          if (density < .006) { rgba[p + 3] = 0; continue; }
          const inverse = 1 / Math.max(density, .001);
          const left = x > 0 ? Math.max(this.r[i - 1], this.g[i - 1], this.b[i - 1]) : 0;
          const right = x < width - 1 ? Math.max(this.r[i + 1], this.g[i + 1], this.b[i + 1]) : 0;
          const top = y > 0 ? Math.max(this.r[i - width], this.g[i - width], this.b[i - width]) : 0;
          const bottom = y < height - 1 ? Math.max(this.r[i + width], this.g[i + width], this.b[i + width]) : 0;
          const gx = (right - left) * .5, gy = (bottom - top) * .5;
          const gradient = Math.sqrt(gx * gx + gy * gy);
          const curvature = Math.abs(density - (left + right + top + bottom) * .25);
          const detail = clamp((gradient - .002) * 24 + curvature * 12 + Math.min(.5,Math.abs(this.curl[i])*.045), 0, 1);
          const filament = detail * detail * (3 - 2 * detail);
          const contour = filament * .17;
          const luminance = .75 + .25 * Math.min(1, density);
          rgba[p] = Math.min(255, (Math.pow(r * inverse, .76) * luminance + contour) * 255);
          rgba[p + 1] = Math.min(255, (Math.pow(g * inverse, .76) * luminance + contour * .65) * 255);
          rgba[p + 2] = Math.min(255, (Math.pow(b * inverse, .76) * luminance + contour) * 255);
          // A flat concentration has only a trace of haze. Density gradients
          // carry the luminous silk, leaving the inside of a curl transparent.
          const body = 1 - Math.exp(-density * 3.1);
          rgba[p + 3] = Math.min(235, body * (52 + 190 * filament)) * edge * strength;
        }
      }
      this.textureContext.putImageData(this.pixels, 0, 0);
      const context = this.context, targetWidth = this.canvas.width, targetHeight = this.canvas.height;
      context.clearRect(0, 0, targetWidth, targetHeight);
      context.imageSmoothingEnabled = true;
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = .55;
      context.filter = 'blur(9px)';
      context.drawImage(this.texture, 0, 0, targetWidth, targetHeight);
      context.filter = 'none';
      context.globalAlpha = 1;
      context.drawImage(this.texture, 0, 0, targetWidth, targetHeight);
      if (this.flowContext && this.flowPixels) this.flowContext.putImageData(this.flowPixels, 0, 0);
      try { this.onFrame(this.flowCanvas); } catch (_) {}
    }

    _canRun() {
      return this.enabled && !this.destroyed && this.visible && !this.d.hidden && !this.motion.matches && this.context && this.width;
    }

    _wake(duration = 7000) {
      this.activeUntil = this.w.performance.now() + duration;
      if (this._canRun() && !this.frame) {
        this.lastFrame = 0;
        this.frame = this.w.requestAnimationFrame(now => this._tick(now));
      }
    }

    _tick(now) {
      this.frame = 0;
      if (!this._canRun()) return;
      if (!this.lastFrame || now - this.lastFrame >= 31) {
        const dt = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, .045) : 1 / 30;
        this.lastFrame = now;
        this._step(dt); this._draw();
      }
      if (now < this.activeUntil) this.frame = this.w.requestAnimationFrame(time => this._tick(time));
    }

    _visibility() {
      if (!this._canRun()) {
        this.w.cancelAnimationFrame(this.frame); this.frame = 0; this.previous.clear();
      } else if (this.w.performance.now() < this.activeUntil) this._wake(Math.min(6500, this.activeUntil - this.w.performance.now()));
      this._status(this.motion.matches ? 'static' : 'fluid', this.motion.matches
        ? 'Humo estático por tu preferencia de movimiento reducido.'
        : 'Fluido 2D: advección, presión y vorticidad; independiente de HIC.');
    }

    splat(x, y, dx, dy, power = 1) {
      if (!this.enabled || this.destroyed || !this.context) return;
      this._inject(x, y, dx, dy, clamp(power, .05, 2), Math.floor(this.hue++ / 3) % 3);
      if (this.motion.matches) this._draw();
      else this._wake();
    }

    burst(x = .5, y = .55) {
      if (!this.enabled || this.destroyed || !this.context) return;
      for (let i = 0; i < 14; i++) {
        const angle = i / 14 * Math.PI * 2;
        const radius = .067 + Math.sin(angle * 3) * .013;
        const hue = i % 7 === 0 ? 2 : i % 2;
        this._inject(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius,
          -Math.sin(angle) * .038, Math.cos(angle) * .038, .35, hue, 1.65);
      }
      this._draw();
      if (!this.motion.matches) this._wake();
    }

    setEnabled(value) {
      if (this.destroyed || this.enabled === Boolean(value)) return;
      this.enabled = Boolean(value); this.canvas.hidden = !this.enabled || !this.context; if (!this.context) return;
      if (this.enabled) { this._resize(); this._seedRibbon(); this._visibility(); }
      else { this.w.cancelAnimationFrame(this.frame); this.frame = 0; this.previous.clear(); }
    }

    setPalette(palette) {
      if (!PALETTES[palette] || this.destroyed || this.palette === palette) return;
      this.palette = palette;
      if (this.r) { this.r.fill(0); this.g.fill(0); this.b.fill(0); }
      if (this.enabled) this._seedRibbon();
    }

    getFlowCanvas() { return this.flowCanvas; }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.enabled = false;
      this.w.cancelAnimationFrame(this.frame); this.frame = 0;
      this.resizeObserver?.disconnect(); this.intersectionObserver?.disconnect();
      this.cleanup.splice(0).forEach(remove => remove());
      this.previous.clear(); this.canvas.remove();
      this.host.style.position = this.oldPosition;
    }
  }
