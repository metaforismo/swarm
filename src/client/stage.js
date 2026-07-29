/**
 * The vent stage: the colony, its light, and the beats that resolve it.
 *
 * Two things here are specification rather than decoration.
 *
 * **The layout** is `docs/DESIGN.md` §6.4 exactly: bodies sit on a golden-angle
 * phyllotaxis spiral around the vent-plume centroid, ordered by slot index, so
 * adding or removing an organism never re-shuffles the ones already on screen.
 *
 * **The light is the money** (§6.3). Screen exposure is a strictly increasing
 * function of colony *value*, so no frame in SWARM is ever brighter than a frame
 * worth more money, and the environment rises above the black floor at exactly
 * `475/48 = 9.895833x` — the smallest value a FULL BLOOM can have, which is why
 * every bloom lights it and so does every frame worth as much.
 *
 * What is placeholder: the bodies are flat discs rather than gel bells with
 * subsurface scattering, the halation is a box-shadow rather than two bloom
 * passes, and the water is a gradient rather than a volumetric.
 */

const GOLDEN_ANGLE = 137.507764;
const REFERENCE_WIDTH = 390;
/** `E(V) = E_min + (E_max - E_min) * log2(1 + V / V0) / log2(1 + V_max / V0)`. */
const EXPOSURE_MIN = 0.04;
const EXPOSURE_MAX = 1;
const EXPOSURE_V0 = 1;
const EXPOSURE_VMAX = 527.355936;
/** The environment threshold, `475/48`. A value, never a population (§7.2). */
export const ENVIRONMENT_THRESHOLD = 475 / 48;

export function exposure(valueMultiple) {
  const value = Math.max(0, valueMultiple);
  const span = Math.log2(1 + EXPOSURE_VMAX / EXPOSURE_V0);
  return EXPOSURE_MIN + (EXPOSURE_MAX - EXPOSURE_MIN) * (Math.log2(1 + value / EXPOSURE_V0) / span);
}

/** Body radius `r(n) = clamp(34 - 1.6(n - 3), 12, 34)` points. */
export function bodyRadius(n) {
  return Math.min(34, Math.max(12, 34 - 1.6 * (n - 3)));
}

/** Layout radius `R(n) = 44 + 7.5 * sqrt(n)` points. */
export function layoutRadius(n) {
  return 44 + 7.5 * Math.sqrt(n);
}

/** Position of body `i` of `n`, 1-based, in points relative to the centroid. */
export function bodyPosition(i, n) {
  const theta = (i * GOLDEN_ANGLE * Math.PI) / 180;
  const rho = layoutRadius(n) * Math.sqrt(i / n);
  return { x: rho * Math.cos(theta), y: rho * Math.sin(theta) };
}

export class Stage {
  constructor(root) {
    this.root = root;
    this.colony = root.querySelector('#colony');
    this.ghosts = root.querySelector('#ghosts');
    this.environment = root.querySelector('#environment');
    this.flash = root.querySelector('#flash');
    this.note = root.querySelector('#stage-note');
    this.units = 0;
    this.timers = new Set();
    this.pending = null;
  }

  get scale() {
    return this.root.clientWidth / REFERENCE_WIDTH;
  }

  /** Centre of the colony: the vent-plume centroid at 38% of stage height. */
  get centre() {
    return { x: this.root.clientWidth / 2, y: this.root.clientHeight * 0.42 };
  }

  /** A cancellable beat, so tapping the stage can end an animation early. */
  wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
      this.pending = resolve;
    });
  }

  /** Skipping ends the current animation and nothing else (§9.7). */
  skip() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.pending !== null) {
      const resolve = this.pending;
      this.pending = null;
      resolve();
    }
  }

  setNote(html) {
    this.note.innerHTML = html ?? '';
  }

  /** Applies `E(V)`: colony halation, and the environment's rise above the floor. */
  setValue(valueMultiple) {
    const level = exposure(valueMultiple);
    this.root.style.setProperty('--exposure', level.toFixed(4));
    const floor = exposure(ENVIRONMENT_THRESHOLD);
    const lit = Math.max(0, Math.min(1, (level - floor) / (EXPOSURE_MAX - floor)));
    // The environment stays lit once it is lit, and dims with the exposure like
    // everything else: a re-reveal would be a spectacle keyed to crossing a line.
    const current = Number(this.root.style.getPropertyValue('--environment') || 0);
    this.root.style.setProperty('--environment', String(Math.max(lit, lit > 0 ? current : 0)));
  }

  /** Renders `units` bodies on the spiral. Existing bodies keep their slot. */
  render(units, { seeding = false } = {}) {
    this.units = units;
    const { x: cx, y: cy } = this.centre;
    const scale = this.scale;
    const diameter = bodyRadius(Math.max(units, 1)) * scale;
    const existing = [...this.colony.children];
    for (let index = existing.length; index < units; index += 1) {
      const body = document.createElement('div');
      body.className = 'organism';
      body.style.animationDelay = `${(index % 5) * 120}ms`;
      if (seeding) body.style.opacity = '0';
      this.colony.append(body);
    }
    while (this.colony.children.length > units) this.colony.lastElementChild?.remove();

    [...this.colony.children].forEach((body, index) => {
      const slot = index + 1;
      const { x, y } = bodyPosition(slot, Math.max(units, 1));
      body.style.width = `${diameter}px`;
      body.style.height = `${diameter}px`;
      body.style.left = `${cx + x * scale}px`;
      body.style.top = `${cy + y * scale}px`;
      body.dataset.slot = String(slot);
      body.removeAttribute('data-outcome');
      if (!seeding) body.style.opacity = '1';
    });
    this.colony.setAttribute('aria-label', `${units} organism${units === 1 ? '' : 's'}`);
  }

  /** S2 — three organisms fade up from the vent over 700 ms. */
  async seed(units) {
    this.render(units, { seeding: true });
    await this.wait(30);
    for (const body of this.colony.children) body.style.opacity = '1';
    await this.wait(700);
  }

  /**
   * S3 — the resolution beat: draw flash (120 ms), every organism resolves
   * simultaneously (400 ms), verdict (380 ms). Organisms never resolve one at a
   * time: a fourteen-organism generation must not take fourteen seconds.
   *
   * DIE, HOLD and SPLIT get equal perceptual weight (§6.5 R2) — the emphasis
   * lives in the verdict, and the verdict is keyed to the money.
   */
  async resolve(resolution, nextUnits) {
    this.flash.classList.remove('on');
    void this.flash.offsetWidth;
    this.flash.classList.add('on');
    await this.wait(120);

    const bodies = [...this.colony.children];
    for (const outcome of resolution.outcomes) {
      const body = bodies[outcome.slot - 1];
      if (body !== undefined) body.dataset.outcome = outcome.id;
    }
    await this.wait(400);
    this.render(nextUnits);
    await this.wait(380);
  }

  /**
   * S5 — the harvest beat, 400 ms. The harvested bodies take AMBER, detach and
   * travel to the balance chip; the survivors close ranks. No swell, no shower,
   * no count-up flourish: a harvest moves money without changing its amount
   * (§6.5 R6).
   */
  async harvest(harvested, remaining, wildUnits) {
    const bodies = [...this.colony.children];
    for (let index = bodies.length - harvested; index < bodies.length; index += 1) {
      const body = bodies[index];
      if (body === undefined) continue;
      body.classList.add('harvested');
      body.style.top = '18px';
      body.style.left = '48px';
      body.style.width = '10px';
      body.style.height = '10px';
    }
    this.showGhosts(wildUnits);
    await this.wait(400);
    this.hideGhosts();
    this.render(remaining);
  }

  /**
   * The wild-line ghost: the colony that never gets harvested, drawn for the
   * 400 ms of the harvest beat and never as a standing rival colony (§9.8).
   */
  showGhosts(wildUnits) {
    this.ghosts.replaceChildren();
    if (!Number.isInteger(wildUnits) || wildUnits <= 0) return;
    const { x: cx, y: cy } = this.centre;
    const scale = this.scale;
    const diameter = bodyRadius(wildUnits) * scale;
    for (let slot = 1; slot <= wildUnits; slot += 1) {
      const { x, y } = bodyPosition(slot, wildUnits);
      const ghost = document.createElement('div');
      ghost.className = 'wild-ghost';
      ghost.style.width = `${diameter}px`;
      ghost.style.height = `${diameter}px`;
      ghost.style.left = `${cx + x * scale}px`;
      ghost.style.top = `${cy + y * scale}px`;
      this.ghosts.append(ghost);
    }
    this.ghosts.classList.add('showing');
  }

  hideGhosts() {
    this.ghosts.classList.remove('showing');
    this.ghosts.replaceChildren();
  }

  /** S6 — the last core dims and the scene falls to the vent ember alone. */
  async extinguish() {
    for (const body of this.colony.children) body.dataset.outcome = 'DIE';
    this.setValue(0);
    await this.wait(400);
    this.colony.replaceChildren();
  }

  /** A large gain puts a MEDUSA rim on every body for 240 ms (§6.5). */
  async medusa() {
    this.colony.classList.add('medusa-rim');
    await this.wait(240);
    this.colony.classList.remove('medusa-rim');
  }

  reset() {
    this.skip();
    this.colony.replaceChildren();
    this.hideGhosts();
    this.setNote('');
    this.root.style.setProperty('--environment', '0');
    this.setValue(0);
  }
}
