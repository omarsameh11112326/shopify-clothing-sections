import { fetchConfig, isRTL, prefersReducedMotion } from '@theme/utilities';
import { CartLinesUpdateEvent } from '@shopify/events';

/**
 * Clothing rack: pick a garment off a packed rail and it flies to a centred
 * detail view while the page blurs behind it. Markup and styles live in
 * sections/clothing-rack.liquid.
 *
 * - The detail view is a modal <dialog>: focus moves in, Esc closes, and focus
 *   returns to the garment on the rack.
 * - The flight is a FLIP animation on transforms only; with reduced motion it
 *   becomes a fade.
 * - Colour options hang as tags beside the hanger; every other option is a row
 *   of pills. The matching variant drives price, image and add to cart.
 * - Add to cart mirrors product-form.js so Horizon's cart drawer and count
 *   update; the drawer opens once this dialog has closed.
 */

const FLY_MS = 650;
const RETURN_MS = 480;
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const REQUEST_TIMEOUT_MS = 15000;

/* ---------- Background removal for the detail view ----------
 * The detail view sits in the browser's top layer, where a white photo
 * background cannot blend away, so it would show as a box over the blur.
 * Studio shots have a plain background touching the photo's edges: flood-fill
 * it from the border, make it transparent, and feather the garment's edge.
 * Busy backgrounds and photos that are already cut-outs are left untouched.
 */
const CUTOUT_WIDTH = 1000;
const CUTOUT_TOLERANCE = 24;
/** @type {Map<string, Promise<string | null>>} */
const cutouts = new Map();

/**
 * A transparent-background version of an image, or null when it can't or
 * shouldn't be made. Cached per URL for the life of the page.
 * @param {string | null} url
 */
function cutout(url) {
  if (!url) return Promise.resolve(null);
  let job = cutouts.get(url);
  if (!job) {
    job = makeCutout(url).catch(() => null);
    cutouts.set(url, job);
  }
  return job;
}

/** @param {string} url */
async function makeCutout(url) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = url;
  await image.decode();

  const scale = Math.min(1, CUTOUT_WIDTH / (image.naturalWidth || 1));
  const width = Math.round(image.naturalWidth * scale);
  const height = Math.round(image.naturalHeight * scale);
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);

  const pixels = context.getImageData(0, 0, width, height);
  if (!clearBackground(pixels.data, width, height)) return null;
  context.putImageData(pixels, 0, 0);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? URL.createObjectURL(/** @type {Blob} */ (blob)) : null;
}

/**
 * Makes the plain background connected to the border transparent, in place.
 * Returns false (and changes nothing) when there is no plain background.
 *
 * @param {Uint8ClampedArray} px RGBA pixels
 * @param {number} w
 * @param {number} h
 */
function clearBackground(px, w, h) {
  /** @type {number[]} */
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);

  let seeThrough = 0;
  /** @type {number[][]} */
  const samples = [];
  for (let k = 0; k < border.length; k += 3) {
    const o = border[k] * 4;
    if (px[o + 3] < 200) seeThrough++;
    else samples.push([px[o], px[o + 1], px[o + 2]]);
  }
  // Already a cut-out, or nothing to judge by.
  if (seeThrough * 3 > border.length / 2 || samples.length < 8) return false;

  const median = (/** @type {number} */ c) => {
    const values = samples.map((s) => s[c]).sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  const bg = [median(0), median(1), median(2)];
  const far = (/** @type {number[]} */ c) =>
    Math.max(Math.abs(c[0] - bg[0]), Math.abs(c[1] - bg[1]), Math.abs(c[2] - bg[2]));
  const distance = (/** @type {number} */ o) => far([px[o], px[o + 1], px[o + 2]]);

  // A plain studio background: nearly the whole border is that one colour.
  const plain = samples.filter((s) => far(s) < CUTOUT_TOLERANCE);
  if (plain.length < samples.length * 0.85) return false;

  const mask = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const i of border) {
    if (!mask[i] && distance(i * 4) < CUTOUT_TOLERANCE) {
      mask[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const around = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
    for (const j of around) {
      if (j < 0 || j >= w * h || mask[j]) continue;
      if (distance(j * 4) < CUTOUT_TOLERANCE) {
        mask[j] = 1;
        queue[tail++] = j;
      }
    }
  }

  // Clear the background, then soften the garment's outermost pixels so the
  // edge doesn't carry a hard white fringe.
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (mask[i]) {
      px[o + 3] = 0;
      continue;
    }
    const x = i % w;
    const touchesBackground =
      (x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (i >= w && mask[i - w]) || (i + w < w * h && mask[i + w]);
    if (touchesBackground) {
      const t = Math.min(1, Math.max(0, (distance(o) - CUTOUT_TOLERANCE * 0.5) / (CUTOUT_TOLERANCE * 2)));
      px[o + 3] = Math.round(px[o + 3] * (0.35 + 0.65 * t));
    }
  }
  return true;
}

/**
 * @typedef {{ value: string, swatch: string | null }} OptionValue
 * @typedef {{ name: string, values: OptionValue[] }} ProductOption
 * @typedef {{ id: number, available: boolean, price: string, options: string[], image: string | null }} Variant
 * @typedef {{ title: string, url: string, price: string, front: string | null, ratio: number,
 *   back: string | null, colorIndex: number, options: ProductOption[], variants: Variant[] }} RackProduct
 */

/* ---------- Hangers on the rail ----------
 * Each hanger is its own object on a 1D rail. The one you hold follows the
 * pointer; it pushes its neighbours when they touch (they can't pass through
 * each other or leave the rail), and everything slides on with momentum and
 * friction after release, staying where it stops. Each garment is a damped
 * pendulum driven by its hanger's acceleration, so a quick pull swings it back
 * and a stop swings it forward.
 */
const FRAME_MS = 1000 / 60;
const FRICTION = 0.9; // velocity kept per frame while sliding
const SWING_STIFFNESS = 0.012; // pull back to vertical, per frame²
const SWING_DAMPING = 0.05;
const SWING_GAIN = 0.09; // push per px/frame² of hanger acceleration
const SWING_DRAG = 0.004; // cloth trails behind while moving (air drag)
const SWING_LIMIT = 28; // degrees

class HangerRail {
  /**
   * @param {HTMLElement} rack positioned container the hangers are measured in
   * @param {HTMLElement[]} items the hanging items, in any DOM order
   */
  constructor(rack, items) {
    this.rack = rack;
    // Physics runs left to right on screen, whatever the DOM/RTL order.
    this.items = [...items].sort((a, b) => a.offsetLeft - b.offsetLeft);
    const n = this.items.length;
    this.x = new Float64Array(n);
    this.v = new Float64Array(n);
    this.base = new Float64Array(n);
    this.angle = new Float64Array(n);
    this.spin = new Float64Array(n);
    this.held = -1;
    this.target = 0;
    this.gap = 0;
    this.left = 0;
    this.right = 0;
    this.frame = 0;
    this.last = 0;
    this.reduced = prefersReducedMotion();
    this.rail = /** @type {HTMLElement | null} */ (rack.querySelector('.crack__rail'));
    this.curveDepth = Number(rack.closest('[data-curve]')?.getAttribute('data-curve')) || 0;
    this.curve = 0;
    this.railLeft = 0;
    this.railWidth = 1;
    this.measure(true);
    this.render();
  }

  /** @param {HTMLElement} item */
  indexOf(item) {
    return this.items.indexOf(item);
  }

  /**
   * Reads the rail's length and each item's resting slot. On first run the
   * hangers sit in their layout slots if they fit, otherwise spread evenly;
   * on resize they keep their place proportionally.
   * @param {boolean} initial
   */
  measure(initial) {
    const n = this.items.length;
    if (!n) return;
    const style = getComputedStyle(this.rack);
    const pad = parseFloat(style.paddingLeft) || 0;
    const width = this.rack.clientWidth;
    const itemWidth = this.items[0].offsetWidth || 1;
    const edge = itemWidth * 0.2;
    // The rail's curve, matched to the CSS (half as deep on phones).
    this.curve = this.curveDepth * (matchMedia('(max-width: 749px)').matches ? 0.5 : 1);
    this.railLeft = this.rail?.offsetLeft ?? 0;
    this.railWidth = this.rail?.offsetWidth || width;
    const left = pad + edge;
    const right = Math.max(left, width - pad - edge);
    const oldLeft = this.left;
    const oldRight = this.right;

    this.items.forEach((item, i) => {
      this.base[i] = item.offsetLeft + item.offsetWidth / 2;
    });
    this.left = left;
    this.right = right;
    // Packed clothes can still be squeezed to under half their resting
    // spacing, so on a full rail there is always room to pull one aside.
    this.gap = n > 1 ? Math.min(itemWidth * 0.28, ((right - left) / (n - 1)) * 0.45) : 0;

    if (initial) {
      const fits = this.base[n - 1] - this.base[0] <= right - left;
      for (let i = 0; i < n; i++) {
        this.x[i] = fits ? this.base[i] : left + ((right - left) * (n > 1 ? i : 0.5)) / Math.max(1, n - 1);
      }
    } else if (oldRight > oldLeft) {
      for (let i = 0; i < n; i++) {
        this.x[i] = left + ((this.x[i] - oldLeft) / (oldRight - oldLeft)) * (right - left);
      }
    }
    this.constrain();
  }

  /** Where hanger `i` may go and still leave room for every other hanger. */
  /** @param {number} i @param {number} x */
  clampFor(i, x) {
    const n = this.items.length;
    return Math.min(this.right - (n - 1 - i) * this.gap, Math.max(this.left + i * this.gap, x));
  }

  /** @param {number} i @param {number} x */
  hold(i, x) {
    this.held = i;
    this.target = this.clampFor(i, x);
    this.kick();
  }

  /** @param {number} x */
  moveTo(x) {
    if (this.held < 0) return;
    this.target = this.clampFor(this.held, x);
    this.kick();
  }

  /** @param {number} [fling] release speed in px per frame, from the pointer */
  release(fling = 0) {
    if (this.held >= 0) this.v[this.held] = this.reduced ? 0 : Math.max(-60, Math.min(60, fling));
    if (this.reduced) this.v.fill(0);
    this.held = -1;
    this.kick();
  }

  /** Nudge the neighbours of `i` apart, e.g. so a focused garment shows. */
  /** @param {number} i */
  part(i) {
    if (i > 0) this.v[i - 1] -= 7;
    if (i < this.items.length - 1) this.v[i + 1] += 7;
    this.kick();
  }

  kick() {
    if (this.frame) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** @param {number} now */
  tick = (now) => {
    const dt = Math.min(48, now - this.last) || FRAME_MS;
    this.last = now;
    const moving = this.step(dt / FRAME_MS);
    this.render();
    this.frame = moving ? requestAnimationFrame(this.tick) : 0;
  };

  /**
   * Advances the simulation by `f` frames. Returns whether anything is
   * still moving.
   * @param {number} f
   */
  step(f) {
    const { x, v, angle, spin } = this;
    const n = x.length;
    const before = Float64Array.from(v);

    for (let i = 0; i < n; i++) {
      if (i === this.held) {
        // The held hanger follows the pointer; its velocity is what you pulled.
        const pulled = (this.target - x[i]) / f;
        v[i] = v[i] * 0.4 + pulled * 0.6;
        x[i] = this.target;
      } else {
        x[i] += v[i] * f;
        v[i] *= Math.pow(FRICTION, f);
        if (Math.abs(v[i]) < 0.02) v[i] = 0;
      }
    }
    this.constrain();

    let moving = this.held >= 0;
    for (let i = 0; i < n; i++) {
      if (this.reduced) {
        angle[i] = 0;
        spin[i] = 0;
      } else {
        // Pivot accelerates right → garment trails left (clockwise in CSS).
        const accel = (v[i] - before[i]) / f;
        const force =
          -SWING_STIFFNESS * angle[i] - SWING_DAMPING * spin[i] + SWING_GAIN * accel + SWING_DRAG * v[i];
        spin[i] += force * f;
        angle[i] = Math.max(-SWING_LIMIT, Math.min(SWING_LIMIT, angle[i] + spin[i] * f));
        if (Math.abs(angle[i]) < 0.04 && Math.abs(spin[i]) < 0.004) {
          angle[i] = 0;
          spin[i] = 0;
        }
      }
      if (v[i] || angle[i] || spin[i]) moving = true;
    }
    return moving;
  }

  /** Keeps hangers in order, apart by at least `gap`, and on the rail. */
  constrain() {
    const { x, v } = this;
    const n = x.length;
    const gap = this.gap;
    const weight = (/** @type {number} */ i) => (i === this.held ? 0 : 1);

    for (let pass = 0; pass < 6; pass++) {
      const forward = pass % 2 === 0;
      for (let s = 1; s < n; s++) {
        const i = forward ? s : n - s;
        const d = x[i] - x[i - 1];
        if (d >= gap) continue;
        const wa = weight(i - 1);
        const wb = weight(i);
        const w = wa + wb;
        if (!w) continue;
        const overlap = gap - d;
        x[i - 1] -= (overlap * wa) / w;
        x[i] += (overlap * wb) / w;
        // Touching hangers that close in move on together (inelastic push).
        if (v[i - 1] > v[i]) {
          const shared = !wa ? v[i - 1] : !wb ? v[i] : (v[i - 1] + v[i]) / 2;
          if (wa) v[i - 1] = shared;
          if (wb) v[i] = shared;
        }
      }
      if (x[0] < this.left) {
        x[0] = this.left;
        if (v[0] < 0) v[0] *= -0.2;
      }
      if (x[n - 1] > this.right) {
        x[n - 1] = this.right;
        if (v[n - 1] > 0) v[n - 1] *= -0.2;
      }
    }
  }

  render() {
    this.items.forEach((item, i) => {
      item.style.setProperty('--x', `${(this.x[i] - this.base[i]).toFixed(2)}px`);
      // Ride the curve: a quadratic sag, deepest in the middle of the rail.
      const u = Math.min(1, Math.max(0, (this.x[i] - this.railLeft) / this.railWidth));
      item.style.setProperty('--y', `${(4 * this.curve * u * (1 - u)).toFixed(2)}px`);
      item.style.setProperty('--swing', `${this.angle[i].toFixed(2)}deg`);
    });
  }
}

class ClothingRack extends HTMLElement {
  /** @type {RackProduct[]} */
  products = [];
  /** @type {HTMLAnchorElement[]} */
  garments = [];
  index = -1;
  /** @type {string[]} */
  selected = [];
  /** @type {Variant | null} */
  variant = null;

  #busy = false;
  #abort = new AbortController();
  #swipe = { x: 0, y: 0, active: false };
  /** @type {HangerRail | null} */
  #rail = null;
  #resize = new ResizeObserver(() => this.#rail?.measure(false));
  #pull = { item: -1, pointerId: -1, startX: 0, startY: 0, grab: 0, dragging: false, suppressClick: false };
  /** Recent pointer positions, for the speed of a flick. @type {{ t: number, x: number }[]} */
  #trail = [];

  connectedCallback() {
    try {
      this.products = JSON.parse(this.querySelector('[data-crack-products]')?.textContent || '[]');
    } catch {
      this.products = [];
    }

    this.garments = [...this.querySelectorAll('.crack__garment[data-index]')].filter(
      (el) => el instanceof HTMLAnchorElement
    );
    this.dialog = /** @type {HTMLDialogElement | null} */ (this.querySelector('.crack__dialog'));
    if (!this.dialog || !this.products.length) return;

    const q = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (this.dialog?.querySelector(sel));
    this.hero = q('[data-crack-hero]');
    this.heroMedia = q('[data-crack-hero-media]');
    this.front = /** @type {HTMLImageElement} */ (q('[data-crack-front]'));
    this.back = /** @type {HTMLImageElement} */ (q('[data-crack-back]'));
    this.tags = q('[data-crack-tags]');
    this.nameEl = q('[data-crack-title]');
    this.price = q('[data-crack-price]');
    this.options = q('[data-crack-options]');
    this.add = /** @type {HTMLButtonElement | null} */ (this.dialog.querySelector('[data-crack-add]'));
    this.status = q('[data-crack-status]');
    this.more = /** @type {HTMLAnchorElement} */ (q('[data-crack-more]'));

    const { signal } = this.#abort;

    // The hangers can be pulled along the rail, by mouse or finger.
    const scroller = this.querySelector('.crack__scroller');
    const rack = this.querySelector('.crack__rack');
    const items = [...this.querySelectorAll('.crack__item')].filter((el) => el instanceof HTMLElement);
    if (scroller instanceof HTMLElement && rack instanceof HTMLElement && items.length) {
      this.scroller = scroller;
      this.rackEl = rack;
      this.classList.add('crack--physics');
      this.#rail = new HangerRail(rack, /** @type {HTMLElement[]} */ (items));
      this.#resize.observe(rack);
      scroller.addEventListener('pointerdown', this.#onPullStart, { signal });
      scroller.addEventListener('pointermove', this.#onPullMove, { signal });
      scroller.addEventListener('pointerup', this.#onPullEnd, { signal });
      scroller.addEventListener('pointercancel', this.#onPullEnd, { signal });
      scroller.addEventListener('click', this.#onPullClick, { capture: true, signal });
      scroller.addEventListener('keydown', this.#onRackKeydown, { signal });
      // Links and images are natively draggable; that would hijack a pull.
      scroller.addEventListener('dragstart', (event) => event.preventDefault(), { signal });
    }

    for (const garment of this.garments) {
      garment.addEventListener('click', this.#onGarmentClick, { signal });
      // Start cutting the photo out before the click, so it's ready on landing.
      const warm = () => this.#warmCutout(Number(garment.dataset.index));
      garment.addEventListener('pointerenter', warm, { signal });
      garment.addEventListener('focus', warm, { signal });
      garment.addEventListener('focus', () => {
        const item = garment.closest('.crack__item');
        if (this.#rail && item instanceof HTMLElement && garment.matches(':focus-visible')) {
          this.#rail.part(this.#rail.indexOf(item));
        }
      }, { signal });
    }

    this.dialog.addEventListener('cancel', this.#onCancel, { signal });
    this.dialog.addEventListener('click', this.#onDialogClick, { signal });
    this.dialog.addEventListener('keydown', this.#onKeydown, { signal });
    this.dialog.addEventListener('pointerdown', this.#onPointerDown, { signal });
    this.dialog.addEventListener('pointerup', this.#onPointerUp, { signal });
    this.heroMedia.addEventListener('pointerenter', this.#onHeroEnter, { signal });
    this.heroMedia.addEventListener('pointerleave', () => this.hero?.classList.remove('is-flipped'), { signal });
    this.add?.addEventListener('click', this.#addToCart, { signal });
  }

  disconnectedCallback() {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#rail?.stop();
    this.#resize.disconnect();
    if (this.dialog?.open) this.dialog.close();
  }

  /* ---------- Pulling hangers ---------- */

  /** Pointer position along the rack, in the rail's coordinates. */
  /** @param {PointerEvent} event */
  #rackX(event) {
    return event.clientX - (this.rackEl?.getBoundingClientRect().left ?? 0);
  }

  /** @param {PointerEvent} event */
  #onPullStart = (event) => {
    const rail = this.#rail;
    if (!rail || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const item = /** @type {HTMLElement} */ (event.target).closest('.crack__item');
    if (!(item instanceof HTMLElement)) return;
    const index = rail.indexOf(item);
    if (index < 0) return;
    this.#pull = {
      item: index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grab: this.#rackX(event) - rail.x[index],
      dragging: false,
      suppressClick: false,
    };
    this.#trail = [{ t: event.timeStamp, x: this.#rackX(event) }];
  };

  /** @param {PointerEvent} event */
  #onPullMove = (event) => {
    const pull = this.#pull;
    const rail = this.#rail;
    if (!rail || pull.item < 0 || event.pointerId !== pull.pointerId) return;

    if (!pull.dragging) {
      const dx = Math.abs(event.clientX - pull.startX);
      const dy = Math.abs(event.clientY - pull.startY);
      if (dx < 6 && dy < 6) return;
      // A mostly vertical finger swipe is the page scrolling, not a pull.
      if (event.pointerType !== 'mouse' && dy > dx) {
        pull.item = -1;
        return;
      }
      pull.dragging = true;
      this.scroller?.setPointerCapture(event.pointerId);
      this.scroller?.classList.add('is-dragging');
      rail.items[pull.item].classList.add('is-held');
      rail.hold(pull.item, this.#rackX(event) - pull.grab);
    }
    const x = this.#rackX(event);
    this.#trail.push({ t: event.timeStamp, x });
    if (this.#trail.length > 8) this.#trail.shift();
    rail.moveTo(x - pull.grab);
  };

  /**
   * Speed of the hand over its last ~80ms, in px per frame; zero if it had
   * stopped before letting go.
   * @param {number} now
   */
  #flickSpeed(now) {
    const trail = this.#trail;
    const last = trail[trail.length - 1];
    if (!last || now - last.t > 80) return 0;
    const first = trail.find((p) => last.t - p.t <= 80) ?? last;
    const ms = last.t - first.t;
    return ms > 0 ? ((last.x - first.x) / ms) * FRAME_MS : 0;
  }

  /** @param {PointerEvent} event */
  #onPullEnd = (event) => {
    const pull = this.#pull;
    const rail = this.#rail;
    if (!rail || event.pointerId !== pull.pointerId) return;
    if (pull.dragging) {
      rail.items[pull.item]?.classList.remove('is-held');
      rail.release(this.#flickSpeed(event.timeStamp));
      pull.suppressClick = true;
      if (this.scroller?.hasPointerCapture(event.pointerId)) this.scroller.releasePointerCapture(event.pointerId);
      this.scroller?.classList.remove('is-dragging');
    }
    pull.item = -1;
    pull.dragging = false;
  };

  /** A pull that ends over a garment must not pick it. */
  #onPullClick = (/** @type {MouseEvent} */ event) => {
    if (!this.#pull.suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    this.#pull.suppressClick = false;
  };

  /** ←/→ move between garments in screen order (RTL included). */
  /** @param {KeyboardEvent} event */
  #onRackKeydown = (event) => {
    if ((event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') || !this.#rail) return;
    const item = /** @type {HTMLElement} */ (event.target).closest('.crack__item');
    if (!(item instanceof HTMLElement)) return;
    const next = this.#rail.items[this.#rail.indexOf(item) + (event.key === 'ArrowRight' ? 1 : -1)];
    const garment = next?.querySelector('.crack__garment');
    if (!(garment instanceof HTMLElement)) return;
    event.preventDefault();
    garment.focus();
  };

  /* ---------- Open, step, close ---------- */

  /** @param {MouseEvent} event */
  #onGarmentClick = (event) => {
    // Let new-tab and modified clicks reach the product page as normal links.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const index = Number(/** @type {HTMLElement} */ (event.currentTarget).dataset.index);
    this.open(index);
  };

  /** @param {number} index */
  async open(index) {
    const dialog = this.dialog;
    const garment = this.garments[index];
    if (!dialog || !garment || dialog.open || this.#busy) return;
    this.#busy = true;

    try {
      this.index = index;
      this.#render(this.products[index], garment);

      const firstRect = this.#mediaRect(garment);
      dialog.showModal();
      dialog.classList.add('is-open');
      garment.classList.add('is-lifted');

      await this.#fly(firstRect, null);
      dialog.classList.add('is-settled');
    } finally {
      this.#busy = false;
    }
  }

  async close() {
    const dialog = this.dialog;
    if (!dialog?.open || this.#busy) return;
    this.#busy = true;

    const garment = this.garments[this.index];
    try {
      this.#revealOnRack(garment);

      dialog.classList.remove('is-settled');
      dialog.classList.remove('is-open');
      this.hero?.classList.remove('is-flipped');

      await this.#fly(null, garment ? this.#mediaRect(garment) : null);
    } finally {
      dialog.close();
      for (const el of this.garments) el.classList.remove('is-lifted');
      this.hero?.getAnimations().forEach((animation) => animation.cancel());
      this.#setStatus('');
      garment?.focus({ preventScroll: true });
      this.#busy = false;
    }
  }

  /** @param {number} direction 1 for next, -1 for previous */
  async step(direction) {
    if (!this.dialog?.open || this.#busy || this.products.length < 2) return;
    this.#busy = true;

    try {
      await this.#swapTo(direction);
    } finally {
      this.#busy = false;
    }
  }

  /** @param {number} direction */
  async #swapTo(direction) {
    const count = this.products.length;
    const next = (this.index + direction + count) % count;
    const shift = 48 * direction * (isRTL(this) ? -1 : 1);
    const reduced = prefersReducedMotion();

    if (this.hero && !reduced) {
      await this.hero.animate(
        [{ transform: 'none', opacity: 1 }, { transform: `translateX(${-shift}px)`, opacity: 0 }],
        { duration: 180, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' }
      ).finished.catch(() => {});
    }

    this.garments[this.index]?.classList.remove('is-lifted');
    this.index = next;
    this.garments[next]?.classList.add('is-lifted');
    this.#render(this.products[next], this.garments[next]);

    if (this.hero) {
      this.hero.getAnimations().forEach((animation) => animation.cancel());
      if (!reduced) {
        await this.hero.animate(
          [{ transform: `translateX(${shift}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
          { duration: 420, easing: EASE }
        ).finished.catch(() => {});
      }
    }
  }

  /**
   * Animates the hero between a garment's place on the rack and the stage.
   * Pass `from` to fly in, `to` to fly back. Origin is the top centre, where
   * the hanger is.
   *
   * @param {DOMRect | null} from
   * @param {DOMRect | null} to
   */
  async #fly(from, to) {
    const hero = this.hero;
    const media = this.heroMedia;
    if (!hero || !media) return;

    const reduced = prefersReducedMotion();
    const rack = from ?? to;
    if (reduced || !rack) {
      await hero.animate([{ opacity: from ? 0 : 1 }, { opacity: from ? 1 : 0 }], {
        duration: 200,
        fill: to ? 'forwards' : 'none',
      }).finished.catch(() => {});
      return;
    }

    hero.getAnimations().forEach((animation) => animation.cancel());
    const stage = media.getBoundingClientRect();
    const scale = rack.width / (stage.width || 1);
    const dx = rack.left + rack.width / 2 - (stage.left + stage.width / 2);
    const dy = rack.top - stage.top;
    const away = { transform: `translate(${dx}px, ${dy}px) scale(${scale})` };
    const home = { transform: 'none' };

    await hero.animate(from ? [away, home] : [home, away], {
      duration: from ? FLY_MS : RETURN_MS,
      easing: EASE,
      fill: to ? 'forwards' : 'none',
    }).finished.catch(() => {});
  }

  /** The photo box of a garment on the rack (the hero aligns to it). */
  /** @param {HTMLElement} garment */
  #mediaRect(garment) {
    return (garment.querySelector('.crack__media') ?? garment).getBoundingClientRect();
  }

  /** Scrolls the rack (not the page) so a garment is in view before it flies home. */
  /** @param {HTMLElement | undefined} garment */
  #revealOnRack(garment) {
    const scroller = this.querySelector('.crack__scroller');
    if (!garment || !(scroller instanceof HTMLElement)) return;
    const box = scroller.getBoundingClientRect();
    const rect = garment.getBoundingClientRect();
    if (rect.left < box.left || rect.right > box.right) {
      scroller.scrollLeft += rect.left + rect.width / 2 - (box.left + box.width / 2);
    }
  }

  #onCancel = (/** @type {Event} */ event) => {
    event.preventDefault();
    this.close();
  };

  /** @param {MouseEvent} event */
  #onDialogClick = (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest('[data-crack-close]')) return void this.close();

    const stepper = target.closest('[data-crack-step]');
    if (stepper instanceof HTMLElement) return void this.step(Number(stepper.dataset.crackStep));

    // A click on empty space around the garment puts it back.
    if (target.classList.contains('crack__stage') || target.classList.contains('crack__veil')) this.close();
  };

  /** @param {KeyboardEvent} event */
  #onKeydown = (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const forward = (event.key === 'ArrowRight') !== isRTL(this);
    event.preventDefault();
    this.step(forward ? 1 : -1);
  };

  /** @param {PointerEvent} event */
  #onPointerDown = (event) => {
    if (event.pointerType === 'mouse') return;
    this.#swipe = { x: event.clientX, y: event.clientY, active: true };
  };

  /** @param {PointerEvent} event */
  #onPointerUp = (event) => {
    if (!this.#swipe.active) return;
    this.#swipe.active = false;
    const dx = event.clientX - this.#swipe.x;
    const dy = event.clientY - this.#swipe.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const forward = dx < 0 !== isRTL(this);
    this.step(forward ? 1 : -1);
  };

  /** @param {PointerEvent} event */
  #onHeroEnter = (event) => {
    if (event.pointerType !== 'mouse' || !this.back || this.back.hidden) return;
    this.hero?.classList.add('is-flipped');
  };

  /* ---------- Product, options, variant ---------- */

  /**
   * @param {RackProduct | undefined} product
   * @param {HTMLElement | undefined} garment
   */
  #render(product, garment) {
    if (!product) return;

    this.nameEl.textContent = product.title;
    this.more.href = product.url;
    this.hero?.style.setProperty('--crack-hero-ratio', String(Math.min(1.25, Math.max(0.5, product.ratio || 0.75))));

    // Show the rack's already-loaded image at once, then swap in the large one.
    const rackImage = garment?.querySelector('img');
    this.#setFront(product.front, rackImage instanceof HTMLImageElement ? rackImage.currentSrc : '');

    if (product.back) {
      const back = product.back;
      this.back.src = back;
      this.back.hidden = false;
      if (this.#cutoutOn) {
        cutout(back).then((clear) => {
          if (clear && this.products[this.index]?.back === back) this.back.src = clear;
        });
      }
    } else {
      this.back.removeAttribute('src');
      this.back.hidden = true;
    }
    this.hero?.classList.remove('is-flipped');

    const start = product.variants.find((v) => v.available) ?? product.variants[0];
    this.selected = start ? [...start.options] : product.options.map((o) => o.values[0]?.value ?? '');
    this.#buildOptions(product);
    this.#update(false);
    this.#setStatus('');
  }

  /**
   * @param {string | null} large
   * @param {string} [instant]
   */
  #setFront(large, instant = '') {
    if (instant) this.front.src = instant;
    if (!large || large === instant) return;
    this.front.dataset.want = large;

    if (this.#cutoutOn) {
      // The cut-out replaces whatever is showing as soon as it's ready.
      if (!instant) this.front.src = large;
      cutout(large).then((clear) => {
        if (this.front.dataset.want === large) this.front.src = clear ?? large;
      });
      return;
    }

    const loader = new Image();
    loader.src = large;
    loader
      .decode()
      .then(() => {
        if (this.front.dataset.want === large) this.front.src = large;
      })
      .catch(() => {});
    if (!instant) this.front.src = large;
  }

  get #cutoutOn() {
    return this.classList.contains('crack--blend');
  }

  /** @param {number} index */
  #warmCutout(index) {
    const product = this.products[index];
    if (!this.#cutoutOn || !product) return;
    cutout(product.front);
    cutout(product.back);
  }

  /** @param {RackProduct} product */
  #buildOptions(product) {
    this.tags.replaceChildren();
    this.options.replaceChildren();
    this.tags.hidden = true;

    product.options.forEach((option, position) => {
      if (position === product.colorIndex) {
        this.tags.hidden = false;
        this.tags.setAttribute('aria-label', option.name);
        for (const { value, swatch } of option.values) {
          const tag = document.createElement('button');
          tag.type = 'button';
          tag.className = 'crack__tag';
          tag.dataset.position = String(position);
          tag.dataset.value = value;
          tag.setAttribute('aria-label', `${option.name}: ${value}`);
          const colour = swatch || (CSS.supports('color', value) ? value : '');
          if (colour) tag.style.setProperty('--tag-color', colour);
          const label = document.createElement('span');
          label.className = 'crack__tag-label';
          label.textContent = value;
          label.setAttribute('aria-hidden', 'true');
          tag.append(label);
          tag.addEventListener('click', () => this.#choose(position, value));
          this.tags.append(tag);
        }
        return;
      }

      // A lone "Default Title" style option is not a choice.
      if (option.values.length < 2) return;

      const group = document.createElement('div');
      group.className = 'crack__pills';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', option.name);
      for (const { value } of option.values) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'crack__pill';
        pill.dataset.position = String(position);
        pill.dataset.value = value;
        pill.textContent = value;
        pill.addEventListener('click', () => this.#choose(position, value));
        group.append(pill);
      }
      this.options.append(group);
    });
  }

  /**
   * @param {number} position
   * @param {string} value
   */
  #choose(position, value) {
    this.selected[position] = value;
    this.#update(position === this.products[this.index]?.colorIndex);
  }

  /** @param {boolean} colourChanged */
  #update(colourChanged) {
    const product = this.products[this.index];
    if (!product) return;

    const matches = (/** @type {Variant} */ v, /** @type {number} */ skip = -1) =>
      v.options.every((value, i) => i === skip || value === this.selected[i]);

    this.variant = product.variants.find((v) => matches(v)) ?? null;

    for (const button of this.dialog?.querySelectorAll('[data-position]') ?? []) {
      if (!(button instanceof HTMLElement)) continue;
      const position = Number(button.dataset.position);
      const value = button.dataset.value;
      button.setAttribute('aria-pressed', String(this.selected[position] === value));
      // Could this value be bought with everything else as chosen?
      const buyable = product.variants.some(
        (v) => v.available && v.options[position] === value && matches(v, position)
      );
      button.classList.toggle('is-unavailable', !buyable);
    }

    // Price, then the chosen colour's name (the tags themselves carry no text).
    const colour = product.colorIndex >= 0 ? this.selected[product.colorIndex] : '';
    const amount = document.createElement('span');
    amount.textContent = this.variant?.price ?? product.price;
    this.price.replaceChildren(amount);
    if (colour && (product.options[product.colorIndex]?.values.length ?? 0) > 1) {
      const name = document.createElement('span');
      name.textContent = `· ${colour}`;
      this.price.append(name);
    }

    if (colourChanged) {
      const image = this.variant?.image ?? product.variants.find((v) => v.options[product.colorIndex] === this.selected[product.colorIndex] && v.image)?.image;
      if (image) {
        this.#setFront(image);
        // The second image belongs to the default colour; don't turn to it.
        this.back.hidden = image !== product.front || !product.back;
      }
    }

    if (this.add) {
      const labels = this.dataset;
      if (!this.variant) {
        this.add.disabled = true;
        this.add.textContent = labels.unavailableLabel ?? 'Unavailable';
      } else if (!this.variant.available) {
        this.add.disabled = true;
        this.add.textContent = labels.soldOutLabel ?? 'Sold out';
      } else {
        this.add.disabled = false;
        this.add.textContent = labels.addLabel ?? 'Add to cart';
      }
    }
  }

  /** @param {string} message */
  #setStatus(message) {
    if (this.status) this.status.textContent = message;
  }

  /* ---------- Add to cart ---------- */

  #addToCart = async () => {
    const add = this.add;
    const variant = this.variant;
    if (!add || !variant?.available || add.getAttribute('aria-busy') === 'true') return;

    add.setAttribute('aria-busy', 'true');
    this.#setStatus('');

    const formData = new FormData();
    formData.append('id', String(variant.id));
    formData.append('quantity', '1');
    const sectionIds = [...document.querySelectorAll('cart-items-component')]
      .map((el) => (el instanceof HTMLElement ? el.dataset.sectionId : ''))
      .filter(Boolean);
    if (sectionIds.length) formData.append('sections', sectionIds.join(','));

    const deferred = CartLinesUpdateEvent.createPromise();
    // Dispatched from inside the dialog so the cart drawer waits for it to close.
    add.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: [{ merchandiseId: String(variant.id), quantity: 1 }],
        promise: deferred.promise,
      })
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const config = fetchConfig('javascript', { body: formData });

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        ...config,
        headers: { ...config.headers, Accept: 'text/html' },
        signal: controller.signal,
      }).then((r) => r.json());

      const cart = await this.#fetchCart();
      const result = {
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          items: cart.items,
          source: 'clothing-rack',
          sourceId: this.dataset.sectionId ?? '',
          itemCount: 1,
          sections: response.status ? undefined : response.sections,
          didError: Boolean(response.status),
        },
      };
      deferred.resolve(result);

      if (response.status) {
        this.#setStatus(response.description || response.message || 'Could not add to cart.');
        return;
      }

      add.textContent = this.dataset.addedLabel ?? 'Added';
      this.#setStatus(this.dataset.addedLabel ?? 'Added');
      setTimeout(() => this.close(), 700);
    } catch (error) {
      deferred.reject(error);
      this.#setStatus(
        controller.signal.aborted ? 'The cart took too long to respond. Please try again.' : 'Could not add to cart. Please try again.'
      );
    } finally {
      clearTimeout(timer);
      add.removeAttribute('aria-busy');
    }
  };

  async #fetchCart() {
    const response = await fetch(`${Theme.routes.cart_url}.json`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    return response.json();
  }
}

if (!customElements.get('clothing-rack')) {
  customElements.define('clothing-rack', ClothingRack);
}
