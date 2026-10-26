import { isRTL, prefersReducedMotion } from '@theme/utilities';

/**
 * Clothing rail: garments hang from a sagging rail and the one nearest the
 * centre comes forward. Markup and styles live in sections/clothing-rail.liquid.
 *
 * - Scroll position drives each item's `--focus` (0–1), its `--drop` along the
 *   curve, the caption and the progress bar.
 * - Scrolling leans every garment against the motion; it springs back in CSS.
 * - Hovering (or a garment arriving in the centre) turns it on its hook.
 * - Mouse users can drag the rail; touch uses native scroll.
 */
class ClothingRail extends HTMLElement {
  /** @type {HTMLElement | null} */
  track = null;
  /** @type {HTMLElement[]} */
  items = [];
  /** @type {HTMLElement | null} */
  focused = null;

  #frame = 0;
  #lastScroll = 0;
  #leanTimer = 0;
  #settleTimer = 0;
  /** @type {HTMLElement | null} */
  #settled = null;
  #resizeObserver = new ResizeObserver(() => {
    this.#measure();
    this.#update();
  });
  #abort = new AbortController();
  #drag = { active: false, moved: false, startX: 0, startScroll: 0, pointerId: -1 };

  connectedCallback() {
    this.track = this.querySelector('.crail__track');
    if (!this.track) return;

    this.items = [...this.track.querySelectorAll(':scope > .crail__item')];
    const { signal } = this.#abort;

    this.track.addEventListener('scroll', this.#schedule, { passive: true, signal });
    this.track.addEventListener('keydown', this.#onKeydown, { signal });
    this.track.addEventListener('pointerdown', this.#onPointerDown, { signal });
    this.track.addEventListener('pointermove', this.#onPointerMove, { signal });
    this.track.addEventListener('pointerup', this.#onPointerUp, { signal });
    this.track.addEventListener('pointercancel', this.#onPointerUp, { signal });
    this.track.addEventListener('click', this.#onClick, { capture: true, signal });

    for (const item of this.items) {
      item.addEventListener('pointerenter', (event) => {
        if (event.pointerType !== 'mouse' || this.#drag.active) return;
        // Garments with a second image turn to it; the rest spin once.
        if (item.classList.contains('crail__item--flip')) item.classList.add('is-flipped');
        else this.#turn(item);
      }, { signal });
      item.addEventListener('pointerleave', () => item.classList.remove('is-flipped'), { signal });
      item.addEventListener('animationend', (event) => {
        if (event.animationName === 'crail-turn') item.classList.remove('is-turning');
      }, { signal });
    }

    this.#resizeObserver.observe(this.track);
    this.#centreMiddle();
    this.#lastScroll = this.track.scrollLeft;
    this.#update();
  }

  disconnectedCallback() {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#resizeObserver.disconnect();
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#leanTimer);
    clearTimeout(this.#settleTimer);
  }

  /** Open on the middle garment so the rail reads full on both sides. */
  #centreMiddle() {
    const track = this.track;
    const middle = this.items[Math.floor((this.items.length - 1) / 2)];
    if (!track || !middle || track.scrollLeft !== 0) return;
    const trackRect = track.getBoundingClientRect();
    const rect = middle.getBoundingClientRect();
    track.scrollLeft += rect.left + rect.width / 2 - (trackRect.left + trackRect.width / 2);
  }

  /** Tallest photo, so the room kept for the centre garment to grow fits the real images. */
  #measure() {
    let tallest = 0;
    for (const media of this.querySelectorAll('.crail__media')) {
      if (media instanceof HTMLElement) tallest = Math.max(tallest, media.offsetHeight);
    }
    if (tallest) this.style.setProperty('--crail-media-h', `${tallest}px`);
  }

  #schedule = () => {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#update();
    });
  };

  #update() {
    const track = this.track;
    if (!track || !this.items.length) return;

    const trackRect = track.getBoundingClientRect();
    const width = trackRect.width || 1;
    const centre = trackRect.left + width / 2;
    const itemWidth = this.items[0].offsetWidth || 1;
    const sag = this.#sag();

    let nearest = this.items[0];
    let nearestDistance = Infinity;

    for (const item of this.items) {
      const rect = item.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const distance = Math.abs(x - centre);
      const focus = Math.max(0, 1 - distance / (itemWidth * 1.1));

      // Position along the rail, 0 at the left edge, 1 at the right.
      const u = Math.min(1, Math.max(0, (x - trackRect.left) / width));
      item.style.setProperty('--drop', `${(4 * sag * u * (1 - u)).toFixed(1)}px`);
      item.style.setProperty('--focus', focus.toFixed(3));
      item.style.zIndex = String(1 + Math.round(focus * 10));

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = item;
      }
    }

    // Progress runs in reading direction; scrollLeft is negative in RTL.
    const max = track.scrollWidth - track.clientWidth;
    const progress = max > 0 ? Math.abs(track.scrollLeft) / max : 0;
    this.style.setProperty('--crail-progress', progress.toFixed(3));
    this.style.setProperty('--crail-dir', isRTL(this) ? '-1' : '1');

    this.#lean(track.scrollLeft - this.#lastScroll);
    this.#lastScroll = track.scrollLeft;

    if (nearest !== this.focused) this.#setFocused(nearest);

    // When the rail comes to rest on a new garment, that one turns once.
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      if (this.#settled && this.focused && this.focused !== this.#settled && !this.#drag.active) {
        this.#turn(this.focused);
      }
      this.#settled = this.focused;
    }, 180);
  }

  /** The rail's sag in px, matched to the drawn curve on narrow screens. */
  #sag() {
    const sag = Number(this.dataset.sag) || 0;
    const scaled = this.offsetWidth < 750 ? sag * 0.5 : sag;
    const rail = this.querySelector('.crail__rail');
    if (rail instanceof SVGElement && rail.dataset.sag !== String(scaled)) {
      rail.dataset.sag = String(scaled);
      rail.setAttribute('viewBox', `0 0 100 ${scaled + 4}`);
      rail.style.height = `${scaled + 4}px`;
      for (const path of rail.querySelectorAll('path')) {
        path.setAttribute('d', `M0 2 Q50 ${scaled * 2 + 2} 100 2`);
      }
    }
    return scaled;
  }

  /** Lean against the direction of travel; CSS springs it back to 0. */
  #lean(delta) {
    if (prefersReducedMotion() || !delta) return;
    const lean = Math.max(-7, Math.min(7, -delta * 0.35));
    this.style.setProperty('--crail-lean', `${lean.toFixed(2)}deg`);
    clearTimeout(this.#leanTimer);
    this.#leanTimer = setTimeout(() => this.style.setProperty('--crail-lean', '0deg'), 90);
  }

  /** @param {HTMLElement} item */
  #setFocused(item) {
    this.focused = item;

    const garment = item.querySelector('.crail__garment');
    const title = this.querySelector('[ref="captionTitle"]');
    const price = this.querySelector('[ref="captionPrice"]');
    if (garment instanceof HTMLElement) {
      if (title) title.textContent = garment.dataset.title ?? '';
      if (price) price.textContent = garment.dataset.price ?? '';
    }
  }

  /** @param {HTMLElement} item */
  #turn(item) {
    if (prefersReducedMotion() || item.classList.contains('is-turning')) return;
    item.classList.add('is-turning');
  }

  /** @param {KeyboardEvent} event */
  #onKeydown = (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const current = this.items.findIndex((item) => item.contains(document.activeElement));
    const from = current === -1 ? this.items.indexOf(/** @type {HTMLElement} */ (this.focused)) : current;
    const forward = (event.key === 'ArrowRight') !== isRTL(this);
    const next = this.items[Math.min(this.items.length - 1, Math.max(0, from + (forward ? 1 : -1)))];
    const target = next?.querySelector('.crail__garment');
    if (!(target instanceof HTMLElement)) return;

    event.preventDefault();
    target.focus({ preventScroll: true });
    next.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  };

  /** @param {PointerEvent} event */
  #onPointerDown = (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !this.track) return;
    this.#drag = {
      active: true,
      moved: false,
      startX: event.clientX,
      startScroll: this.track.scrollLeft,
      pointerId: event.pointerId,
    };
  };

  /** @param {PointerEvent} event */
  #onPointerMove = (event) => {
    const drag = this.#drag;
    if (!drag.active || event.pointerId !== drag.pointerId || !this.track) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 6) return;

    if (!drag.moved) {
      drag.moved = true;
      this.track.classList.add('is-dragging');
      this.track.setPointerCapture(event.pointerId);
    }
    this.track.scrollLeft = drag.startScroll - dx;
  };

  /** @param {PointerEvent} event */
  #onPointerUp = (event) => {
    const drag = this.#drag;
    if (!drag.active || event.pointerId !== drag.pointerId || !this.track) return;
    drag.active = false;
    if (!drag.moved) return;

    if (this.track.hasPointerCapture(event.pointerId)) this.track.releasePointerCapture(event.pointerId);

    // Restore snapping from where the drag left off, then settle on the
    // nearest garment.
    const left = this.track.scrollLeft;
    this.track.classList.remove('is-dragging');
    this.track.scrollLeft = left;
    this.focused?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  };

  /** A drag that ends over a garment must not open it. */
  #onClick = (/** @type {MouseEvent} */ event) => {
    if (!this.#drag.moved) return;
    event.preventDefault();
    event.stopPropagation();
    this.#drag.moved = false;
  };
}

if (!customElements.get('clothing-rail')) {
  customElements.define('clothing-rail', ClothingRail);
}
