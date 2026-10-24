/* Movable representations of the Cofre's existing entries. No file data is stored here. */
const PLACES = [[.035, .07, -7], [.97, .025, 6], [.08, .78, -4], [.92, .73, 5]];
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export class SXVaultObjects {
  constructor({ host, items = [], onMove = () => {}, onOpen = () => {}, onChange = () => {} } = {}) {
    if (!host?.ownerDocument) throw new TypeError('SXVaultObjects needs a host element.');
    this.host = host; this.d = host.ownerDocument; this.w = this.d.defaultView;
    this.onMove = onMove; this.onOpen = onOpen; this.onChange = onChange;
    this.cards = []; this.layouts = new Map(); this.open = false; this.enabled = true; this.destroyed = false;
    this.drag = null; this.z = 4; this.cleanups = [];
    this.element = this.node('div', 'vo-layer');
    this.element.setAttribute('aria-label', 'Objetos de tu Cofre');
    this.zone = this.node('div', 'vo-drop-zone'); this.zone.setAttribute('aria-hidden', 'true');
    this.zone.append(this.node('span', 'vo-drop-icon', '◇'), this.node('span', 'vo-drop-label', 'Recoger en el cofre'));
    this.recover = this.node('button', 'vo-recover', 'Recuperar objetos'); this.recover.type = 'button';
    this.recover.hidden = true;
    this.status = this.node('span', 'sx-cofre-sr-only'); this.status.setAttribute('role', 'status');
    this.element.append(this.zone, this.recover, this.status); host.append(this.element);
    this.listen(this.recover, 'click', () => this.reset());
    this.listen(this.w, 'blur', () => this.cancelDrag());
    this.listen(this.d, 'visibilitychange', () => { if (this.d.hidden) this.cancelDrag(); });
    if (this.w.ResizeObserver) { this.observer = new this.w.ResizeObserver(() => this.resize()); this.observer.observe(host); }
    this.setItems(items); this.applyVisibility();
  }
  node(tag, cls, text) { const n = this.d.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  listen(n, type, fn, options, bucket = this.cleanups) { n.addEventListener(type, fn, options); bucket.push(() => n.removeEventListener(type, fn, options)); }
  now() { return this.w.performance.now(); }
  usable(card) { return this.enabled && this.open && !this.destroyed && !card.docked; }
  size(card) {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    const cw = card.node.offsetWidth || Math.min(148, width * .43), ch = card.node.offsetHeight || 132;
    return { width, height, minX: 12, minY: 12, maxX: Math.max(12, width - cw - 12), maxY: Math.max(12, height - ch - 82) };
  }
  place(card, x, y, angle = card.angle, remember = true) {
    const s = this.size(card); card.x = clamp(x, s.minX, s.maxX); card.y = clamp(y, s.minY, s.maxY);
    if (remember && s.maxX > s.minX) card.nx = (card.x - s.minX) / (s.maxX - s.minX);
    if (remember && s.maxY > s.minY) card.ny = (card.y - s.minY) / (s.maxY - s.minY);
    card.node.style.left = `${card.x}px`; card.node.style.top = `${card.y}px`; card.node.style.transform = `rotate(${angle}deg)`;
  }
  resize(force = false) {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (this.destroyed || !width || !height || (!force && width === this.width && height === this.height)) return;
    this.cancelDrag(false); this.width = width; this.height = height;
    for (const card of this.cards) { const s = this.size(card); this.place(card, s.minX + card.nx * (s.maxX - s.minX), s.minY + card.ny * (s.maxY - s.minY), card.angle, false); }
  }
  createCard(item, index) {
    const node = this.node('article', 'vo-card'); node.dataset.entryId = String(item.id);
    const top = this.node('div', 'vo-topline'), icon = this.node('span', 'vo-file-icon'); icon.setAttribute('aria-hidden', 'true');
    const handle = this.node('button', 'vo-handle', '⠿'); handle.type = 'button';
    const open = this.node('button', 'vo-open'); open.type = 'button';
    const title = this.node('strong', 'vo-title'), detail = this.node('small', 'vo-detail'); open.append(title, detail); top.append(icon, handle); node.append(top, open);
    const p = PLACES[index % PLACES.length], saved = this.layouts.get(String(item.id));
    const card = { item, node, handle, open, icon, title, detail, nx: p[0], ny: p[1], angle: p[2], x: 12, y: 12, docked: false, suppress: 0, cleanups: [] };
    if (saved) Object.assign(card, saved);
    const listen = (type, fn) => this.listen(node, type, fn, undefined, card.cleanups);
    listen('pointerdown', e => this.start(card, e)); listen('pointermove', e => this.move(card, e)); listen('pointerup', e => this.end(card, e));
    for (const type of ['pointercancel', 'lostpointercapture']) listen(type, () => { if (this.drag?.card === card) this.cancelDrag(); });
    listen('keydown', e => this.key(card, e));
    for (const button of [handle, open]) this.listen(button, 'click', e => { if (!this.usable(card) || this.now() < card.suppress) { e.preventDefault(); return; } this.openCard(card); }, undefined, card.cleanups);
    this.element.insertBefore(node, this.zone); this.updateCard(card, item); return card;
  }
  updateCard(card, item) {
    // Keep only metadata and identity. Blob/text ownership remains in cofre-studio.
    card.item = { id: item.id, title: item.title, kind: item.kind, detail: item.detail };
    card.node.className = `vo-card vo-card-${item.kind}`; card.node.classList.toggle('is-docked', card.docked);
    card.node.setAttribute('aria-label', item.title); card.title.textContent = item.title; card.detail.textContent = item.detail;
    card.icon.textContent = item.kind === 'image' ? '▧' : item.kind === 'note' ? '✎' : '▤';
    card.open.setAttribute('aria-label', `Abrir ${item.title}`);
    card.handle.setAttribute('aria-label', `Mover ${item.title}. Flechas para mover, Intro para abrir y Fin para recoger.`);
    card.handle.title = 'Arrastra por aquí. Flechas: mover. Intro: abrir. Fin: recoger.';
  }
  setItems(items, allIds = items.map(item => item.id)) {
    if (this.destroyed) return;
    this.cancelDrag();
    const knownIds = new Set(allIds.map(String));
    const current = new Map(this.cards.map(c => [String(c.item.id), c]));
    for (const card of this.cards) if (knownIds.has(String(card.item.id))) this.layouts.set(String(card.item.id), { nx: card.nx, ny: card.ny, angle: card.angle, docked: card.docked });
    for (const id of this.layouts.keys()) if (!knownIds.has(id)) this.layouts.delete(id);
    const selected = items.slice(0, 4);
    this.cards = selected.map((item, index) => { const card = current.get(String(item.id)) || this.createCard(item, index); current.delete(String(item.id)); this.updateCard(card, item); return card; });
    for (const card of current.values()) { for (const clean of card.cleanups) clean(); card.node.remove(); }
    this.applyVisibility(); this.resize(true); this.changed('sync');
  }
  start(card, e) {
    if (!this.usable(card) || this.drag || e.button !== 0 || e.isPrimary === false) return;
    if (e.pointerType !== 'mouse' && !card.handle.contains(e.target)) return;
    e.preventDefault();
    this.drag = { card, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, x: card.x, y: card.y, nx: card.nx, ny: card.ny, time: this.now(), moved: false };
    try { card.node.setPointerCapture(e.pointerId); } catch { this.drag = null; return; }
    card.node.style.zIndex = String(++this.z); card.node.classList.add('is-pressed');
  }
  move(card, e) {
    const drag = this.drag; if (drag?.card !== card || drag.pointerId !== e.pointerId) return;
    const x = e.clientX - drag.startX, y = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(x, y) < 5) return;
    drag.moved = true; card.node.classList.add('is-dragging');
    const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY, elapsed = Math.max(8, this.now() - drag.time);
    card.x = clamp(drag.x + x, 12, Math.max(12, this.host.clientWidth - (card.node.offsetWidth || 148) - 12));
    card.y = clamp(drag.y + y, 12, Math.max(12, this.host.clientHeight - (card.node.offsetHeight || 132) - 12));
    card.node.style.left = `${card.x}px`; card.node.style.top = `${card.y}px`; card.node.style.transform = `rotate(${clamp(dx / elapsed * 7, -10, 10)}deg) scale(1.035)`;
    this.trail(drag.lastX, drag.lastY, e.clientX, e.clientY, clamp(Math.hypot(dx, dy) / elapsed, .5, 2));
    this.zone.classList.toggle('is-over', this.overZone(e.clientX, e.clientY));
    drag.lastX = e.clientX; drag.lastY = e.clientY; drag.time = this.now();
  }
  trail(x0, y0, x1, y1, power = 1) {
    const r = this.host.getBoundingClientRect(), width = Math.max(1, r.width), height = Math.max(1, r.height);
    const steps = Math.min(10, Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 20)));
    for (let i = 1; i <= steps; i++) this.onMove({ x: clamp((x0 + (x1 - x0) * i / steps - r.left) / width, 0, 1), y: clamp((y0 + (y1 - y0) * i / steps - r.top) / height, 0, 1), dx: (x1 - x0) / width / steps, dy: (y1 - y0) / height / steps, power });
  }
  overZone(x, y) { const r = this.zone.getBoundingClientRect(); return x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 10 && y <= r.bottom + 10; }
  release(drag) {
    drag.card.node.classList.remove('is-dragging', 'is-pressed'); this.zone.classList.remove('is-over');
    try { if (drag.card.node.hasPointerCapture(drag.pointerId)) drag.card.node.releasePointerCapture(drag.pointerId); } catch {}
  }
  end(card, e) {
    const drag = this.drag; if (drag?.card !== card || drag.pointerId !== e.pointerId) return;
    this.drag = null; this.release(drag); card.suppress = this.now() + 450;
    if (!drag.moved) this.openCard(card);
    else if (this.overZone(e.clientX, e.clientY)) this.dock(card);
    else { this.place(card, card.x, card.y); this.status.textContent = `${card.item.title} colocado.`; }
  }
  cancelDrag(remember = true) {
    const drag = this.drag; if (!drag) return; this.drag = null; this.release(drag);
    drag.card.nx = drag.nx; drag.card.ny = drag.ny; drag.card.suppress = this.now() + 450;
    this.place(drag.card, drag.x, drag.y, drag.card.angle, remember);
  }
  key(card, e) {
    if (!this.usable(card)) return;
    if (e.key === 'Escape' && this.drag?.card === card) { e.preventDefault(); this.cancelDrag(); return; }
    const vector = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (vector) {
      e.preventDefault(); const step = e.shiftKey ? 30 : 14, r = card.node.getBoundingClientRect(), x = card.x, y = card.y;
      this.place(card, x + vector[0] * step, y + vector[1] * step); this.trail(r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2 + card.x - x, r.top + r.height / 2 + card.y - y);
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target === card.handle) { e.preventDefault(); this.openCard(card); }
    if (e.key === 'End') { e.preventDefault(); this.dock(card); }
  }
  openCard(card) { if (this.usable(card)) this.onOpen(card.item.id); }
  dock(card) {
    card.docked = true; card.node.hidden = true; card.node.inert = true; card.node.classList.add('is-docked');
    this.status.textContent = `${card.item.title} recogido. Sigue disponible en la lista.`; this.changed('dock', card.item.id); this.recover.focus({ preventScroll: true });
  }
  changed(action, id) {
    const docked = this.cards.filter(c => c.docked).length;
    this.recover.hidden = !docked; this.recover.textContent = `Recuperar objetos (${docked})`;
    this.zone.hidden = !this.cards.length;
    this.onChange({ action, id, docked, count: this.cards.length, visible: this.cards.length - docked });
  }
  applyVisibility() {
    const visible = this.enabled && this.open && !this.destroyed;
    this.element.hidden = !visible; this.element.inert = !visible; this.element.classList.toggle('is-open', visible);
    for (const card of this.cards) { card.node.hidden = !visible || card.docked; card.node.inert = !visible || card.docked; }
  }
  setOpen(value) { if (this.destroyed || this.open === Boolean(value)) return; this.open = Boolean(value); this.cancelDrag(); this.applyVisibility(); if (this.open) this.resize(true); }
  setEnabled(value) { if (this.destroyed || this.enabled === Boolean(value)) return; this.enabled = Boolean(value); this.cancelDrag(); this.applyVisibility(); if (this.enabled) this.resize(true); }
  reset() {
    this.cancelDrag(); this.layouts.clear(); this.cards.forEach((c, i) => { [c.nx, c.ny, c.angle] = PLACES[i % PLACES.length]; c.docked = false; c.node.classList.remove('is-docked'); });
    this.applyVisibility(); this.resize(true); this.changed('reset'); this.status.textContent = 'Tus objetos vuelven a estar desplegados.';
  }
  destroy() {
    if (this.destroyed) return; this.cancelDrag(); this.destroyed = true; this.observer?.disconnect();
    for (const card of this.cards) for (const clean of card.cleanups) clean(); this.cleanups.splice(0).forEach(clean => clean()); this.cards = []; this.layouts.clear(); this.element.remove();
  }
}
