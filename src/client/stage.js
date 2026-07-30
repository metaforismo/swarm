/**
 * The vent stage: the colony, its light, and the beats that resolve it.
 *
 * This is the premium presentation layer. It draws a frame the server already
 * decided; it never decides anything. Everything on screen is generated in this
 * repository — canvas gradients, procedural sprites, seeded noise — and no asset
 * is fetched or copied from anywhere.
 *
 * Four things here are specification rather than decoration.
 *
 * **The layout** is `docs/DESIGN.md` §6.4 exactly: bodies sit on a golden-angle
 * phyllotaxis spiral around the vent-plume centroid, ordered by slot index, so
 * adding or removing an organism never re-shuffles the ones already on screen. A
 * body's *diameter* is `2 * r(n)` — §6.2 reads "a translucent gel bell 24 to 68 pt
 * across — the diameter of `r(n)`", and `r(n)` runs 34 → 12, so the bells run
 * 68 pt → 24 pt across. The graybox drew `r(n)` as the diameter and was therefore
 * half-size everywhere; this build draws the specified figure.
 *
 * **The light is the money** (§6.3). Screen exposure is a strictly increasing
 * function of colony *value*, so no frame in SWARM is ever brighter than a frame
 * worth more money, and the environment rises above the black floor at exactly
 * `475/48 = 9.895833x` — the smallest value a FULL BLOOM can have, which is why
 * every bloom lights it and so does every frame worth as much. Every emitter in
 * this file except two is a body whose radiance is `R_ref * c(t)/c(1)`; the two
 * exemptions are stated where they are drawn (the wild-line ghost, §6.3's own
 * exemption, and the banked-value vessel, whose reasoning is at `drawVessel`).
 * Water, motes, rays and rock are *lit* rather than emitting: their brightness is
 * a function of the colony's exposure, so a poorer frame can never be brighter
 * than a richer one.
 *
 * **The art may not leak information** (§6.2). A body's archetype, its Perlin
 * phase, its drift and its split axis are derived from the slot index and from
 * nothing else — never from a draw, an outcome, or a future state.
 *
 * **Emphasis follows the money** (§6.5). DIE, HOLD and SPLIT get equal
 * perceptual weight in the 400 ms outcome beat: the pulse wave that carries them
 * is identical for all three, and no colour flash, bloom pop or extra motion
 * attaches to a split. The emphasis lives in the verdict, and the verdict is a
 * function of the signed value change alone.
 *
 * Performance (§6.4's budget): one canvas, no `shadowBlur`, no per-frame
 * `filter`. Every soft thing is a pre-rendered sprite blitted with `drawImage`
 * under `globalCompositeOperation = 'lighter'`, which is how a 30-body colony
 * with halation, 240 plankton and 60 motes stays inside a frame budget on a
 * mid-range phone. Animation is one `requestAnimationFrame` loop that idles when
 * nothing is moving.
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
/**
 * How far the camera dollies back during the environment reveal (§7.2): 8%, and
 * the only camera move in the game.
 *
 * Every layer that participates in the dolly is drawn over-sized by exactly
 * `1 / CAMERA_MIN`, so that at full dolly it lands on the frame edge and never
 * short of it. A shrinking scene that is drawn to the frame's own bounds leaves a
 * visible un-drawn margin, which is the one artefact a camera move must not have.
 */
const CAMERA_MIN = 0.92;
const OVERDRAW = 1 / CAMERA_MIN;

/** §6.1, and the only place these live in the renderer. */
const C = {
  abyss: [2, 4, 10],
  trench: [6, 16, 25],
  silt: [10, 27, 40],
  basalt: [18, 50, 64],
  crust: [30, 74, 86],
  lumen: [57, 245, 200],
  lumenHigh: [124, 255, 227],
  lumenDeep: [15, 184, 148],
  plankton: [91, 140, 255],
  medusa: [176, 108, 255],
  amber: [255, 201, 120],
  ember: [255, 158, 107],
  ash: [138, 151, 166],
  foam: [230, 244, 241],
};

const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

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

/**
 * A deterministic value in `[0, 1)` from a slot index and a salt.
 *
 * §6.2 is a hard rule: the archetype, the phase and every other per-body constant
 * is derived from the slot index and from nothing else, so the art cannot leak
 * information about a draw. This is that derivation, and it is the only source of
 * per-body variation in the file.
 */
function slotRandom(slot, salt) {
  let h = (Math.imul(slot + 1, 374761393) + Math.imul(salt + 1, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 1-D value noise — the Perlin-ish drift input of §6.4's idle row. */
function noise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const a = slotRandom(i, seed);
  const b = slotRandom(i + 1, seed);
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Easings named in §6.4, as functions of normalized time. */
const ease = {
  linear: (t) => t,
  /** `cubic-bezier(0.4, 0, 0.2, 1)` — the standard material-ish move. */
  standard: (t) => 1 - Math.pow(1 - t, 2.2),
  /** `cubic-bezier(0.2, 0, 0, 1)` — the harvest and exposure ramp. */
  decel: (t) => 1 - Math.pow(1 - t, 3),
  /** `cubic-bezier(0.22, 1, 0.36, 1)` — the verdict count. */
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  /** `cubic-bezier(0.4, 0, 1, 1)` — the death fall. */
  accel: (t) => t * t,
  /** `cubic-bezier(0.34, 1.56, 0.64, 1)` — the split, with 12% elastic overshoot. */
  elastic: (t) => {
    const c = 1.56;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
};

// --------------------------------------------------------------------- sprites

/**
 * A soft radial sprite: the halation of §6.2, pre-rendered once per colour.
 *
 * "This is the single most important material effect — without halation the
 * organisms look like stickers." It is also the most expensive thing to do
 * honestly, so it is a gradient baked into a 128 px canvas and blitted, never a
 * `shadowBlur` and never a per-frame `filter`.
 */
function glowSprite(colour, falloff = 2.6) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let stop = 0; stop <= 16; stop += 1) {
    const t = stop / 16;
    gradient.addColorStop(t, rgba(colour, Math.pow(1 - t, falloff)));
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** The three silhouettes of §6.2, as lobes on a unit body radius. */
const ARCHETYPES = [
  // DOME — wide, shallow.
  [{ x: 0, y: 0.06, rx: 1, ry: 0.82 }],
  // BELL — tall, pinched.
  [{ x: 0, y: -0.04, rx: 0.8, ry: 1 }],
  // LOBE — asymmetric, two-lobed. The minor lobe stays small: at 12 pt across it
  // has to read as a bulge in one organism, never as a second organism.
  [
    { x: -0.08, y: 0, rx: 0.9, ry: 0.92 },
    { x: 0.5, y: 0.14, rx: 0.34, ry: 0.3 },
  ],
];

/**
 * A gel bell (§6.2): a translucent body that *transmits* its core outward with a
 * soft falloff, a brighter nucleus at ~25% of body radius, and a thin Fresnel
 * membrane in LUMEN HIGH.
 *
 * Everything is drawn **additively and with no hard silhouette edge** — each lobe
 * is a radial falloff that reaches zero alpha exactly at its own boundary. That
 * is what separates a bioluminescent organism from a coloured disc: the body has
 * no outline, it has a brightness that runs out. §6.2's "never a flat sprite;
 * never outlined" is the rule, and an opaque fill with a crisp rim breaks both.
 *
 * Three archetypes, because fifteen identical bells read as a texture and three
 * read as a colony. Baked at 256 px and blitted at 24–68 pt: a *cached* body, not
 * a flat one — the internal falloff and the membrane are real, they are simply
 * computed once.
 *
 * The 2–3 px background refraction §6.2 asks for is not attempted: sampling the
 * backdrop per body per frame is exactly the work §6.4's budget rules out, and on
 * an additive emitter over near-black water there is almost nothing behind the
 * body to warp. The membrane carries the lens read instead.
 */
function bellSprite(archetype, core, high, deep) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 14;
  const lobes = ARCHETYPES[archetype];
  const nucleus = { x: cx - R * 0.17, y: cy - R * 0.21 };

  ctx.globalCompositeOperation = 'lighter';

  // The gel: one falloff per lobe, drawn in a scaled space so an ellipse is a
  // circle and the alpha reaches zero on every axis at the same time.
  for (const lobe of lobes) {
    ctx.save();
    ctx.translate(cx + lobe.x * R, cy + lobe.y * R);
    ctx.scale(lobe.rx, lobe.ry);
    const gel = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    gel.addColorStop(0, rgba(core, 0.6));
    gel.addColorStop(0.32, rgba(core, 0.46));
    gel.addColorStop(0.62, rgba(core, 0.28));
    gel.addColorStop(0.86, rgba(deep, 0.11));
    gel.addColorStop(1, rgba(deep, 0));
    ctx.fillStyle = gel;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The nucleus, at ~25% of body radius: the hottest 10% of the body.
  const core1 = ctx.createRadialGradient(nucleus.x, nucleus.y, 0, nucleus.x, nucleus.y, R * 0.42);
  core1.addColorStop(0, rgba(high, 0.95));
  core1.addColorStop(0.28, rgba(high, 0.5));
  core1.addColorStop(0.62, rgba(core, 0.17));
  core1.addColorStop(1, rgba(core, 0));
  ctx.fillStyle = core1;
  ctx.fillRect(0, 0, size, size);

  // The Fresnel membrane: soft, thin, brightest away from the nucleus, and never
  // a crisp outline. Blurred once here rather than per frame, and drawn only on
  // the body's own silhouette — a second stroke around a LOBE's minor lobe reads
  // as a second organism, which is the one thing the archetype must not do.
  ctx.save();
  ctx.filter = 'blur(5px)';
  ctx.lineWidth = size * 0.02;
  const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  rim.addColorStop(0, rgba(high, 0.03));
  rim.addColorStop(0.62, rgba(high, 0.17));
  rim.addColorStop(1, rgba(high, 0.07));
  ctx.strokeStyle = rim;
  ctx.beginPath();
  const main = lobes[0];
  ctx.ellipse(cx + main.x * R, cy + main.y * R, R * main.rx * 0.9, R * main.ry * 0.9, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.filter = 'none';
  ctx.restore();

  return canvas;
}

/**
 * A soft annulus: the pulse wave that carries a generation's outcomes.
 *
 * A stroked circle reads as a UI ring. This is a ring of *light* — its edges fade
 * on both sides — baked once and blitted, so a wave crossing the whole colony
 * costs one `drawImage`.
 */
function ringSprite(colour) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, rgba(colour, 0));
  gradient.addColorStop(0.62, rgba(colour, 0));
  gradient.addColorStop(0.8, rgba(colour, 0.5));
  gradient.addColorStop(0.9, rgba(colour, 0.9));
  gradient.addColorStop(0.97, rgba(colour, 0.28));
  gradient.addColorStop(1, rgba(colour, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * The colony's light in the water: LUMEN at the core, cooling through LUMEN DEEP
 * to PLANKTON at the edge, so the field the colony sits in is two hues rather
 * than the single one the round-1 build had. Baked once and blitted; the whole
 * point is that this is one `drawImage` a frame and not a gradient fill.
 */
function waterSprite() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, rgba(C.lumen, 0.44));
  gradient.addColorStop(0.34, rgba(C.lumenDeep, 0.25));
  gradient.addColorStop(0.72, rgba(C.plankton, 0.1));
  gradient.addColorStop(1, rgba(C.plankton, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** A fine monochrome grain tile — §6.2's 2% noise, animated at 12 fps. */
function grainTile(seed) {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  for (let index = 0; index < size * size; index += 1) {
    const value = slotRandom(index, seed) * 255;
    image.data[index * 4] = value;
    image.data[index * 4 + 1] = value;
    image.data[index * 4 + 2] = value;
    image.data[index * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Two soft cones of colony light falling toward the near silt (§7.2's
 * "volumetric shafts": two blurred quads, no god-ray shader). Baked once with a
 * single blur so the per-frame cost is two `drawImage` calls.
 */
function shaftSprite(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(width));
  canvas.height = Math.max(2, Math.round(height));
  const ctx = canvas.getContext('2d');
  // Heavily blurred, then feathered sideways: an unfeathered trapezoid reads as a
  // spotlight cone with two straight edges, which is a stage light and not water.
  ctx.filter = 'blur(40px)';
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, rgba(C.lumen, 0));
  gradient.addColorStop(0.16, rgba(C.lumen, 0.42));
  gradient.addColorStop(0.6, rgba(C.lumen, 0.14));
  gradient.addColorStop(1, rgba(C.lumen, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(canvas.width * 0.4, 0);
  ctx.lineTo(canvas.width * 0.6, 0);
  ctx.lineTo(canvas.width * 1.02, canvas.height);
  ctx.lineTo(canvas.width * -0.02, canvas.height);
  ctx.closePath();
  ctx.fill();
  ctx.filter = 'none';

  const feather = ctx.createLinearGradient(0, 0, canvas.width, 0);
  feather.addColorStop(0, 'rgba(0,0,0,0)');
  feather.addColorStop(0.34, 'rgba(0,0,0,1)');
  feather.addColorStop(0.66, 'rgba(0,0,0,1)');
  feather.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = feather;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

// ----------------------------------------------------------------------- stage

export class Stage {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('#stage-canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.colony = root.querySelector('#colony');
    this.note = root.querySelector('#stage-note');

    this.reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = this.reducedQuery.matches;
    this.reducedQuery.addEventListener?.('change', (event) => {
      this.reduced = event.matches;
    });

    this.sprites = {
      lumenGlow: glowSprite(C.lumen, 1.9),
      lumenTight: glowSprite(C.lumenHigh, 4.2),
      planktonGlow: glowSprite(C.plankton, 2.6),
      planktonFlat: glowSprite(C.plankton, 0.9),
      amberGlow: glowSprite(C.amber, 2.2),
      emberGlow: glowSprite(C.ember, 2.4),
      medusaGlow: glowSprite(C.medusa, 2.6),
      foamGlow: glowSprite(C.foam, 1.8),
      pulseRing: ringSprite(C.lumen),
      medusaRing: ringSprite(C.medusa),
      ashRing: ringSprite([4, 9, 16]),
      // The colony's light in the water: LUMEN at the core cooling to PLANKTON
      // at the edge, so the field is two hues rather than one. Baked once.
      waterBody: waterSprite(),
      bells: [
        bellSprite(0, C.lumen, C.lumenHigh, C.lumenDeep),
        bellSprite(1, C.lumen, C.lumenHigh, C.lumenDeep),
        bellSprite(2, C.lumen, C.lumenHigh, C.lumenDeep),
      ],
      amberBells: [
        bellSprite(0, C.amber, [255, 224, 168], [196, 132, 56]),
        bellSprite(1, C.amber, [255, 224, 168], [196, 132, 56]),
        bellSprite(2, C.amber, [255, 224, 168], [196, 132, 56]),
      ],
      // One tile: the 12 fps cycle is `background-position` on the compositor
      // now, so the three the canvas pass used to swap between are dead weight.
      grain: [grainTile(11)],
    };

    /** Live bodies, in slot order. */
    this.bodies = [];
    this.units = 0;
    /** Harvest light trails, alive only during a harvest beat. */
    this.trails = [];
    /** The wild-line ghost population, non-zero only during a harvest beat. */
    this.ghostUnits = 0;
    this.ghostAlpha = 0;

    this.value = 0;
    /** Animated screen exposure. Settles to `E(V)` across the verdict beat. */
    this.exposure = exposure(0);
    this.exposureTarget = exposure(0);
    /** How far the environment has risen above the black floor, 0 → 1. */
    this.environment = 0;
    this.environmentTarget = 0;
    /**
     * Milliseconds into the §7.2 reveal, or `null` when no reveal is running — in
     * which case every depth layer is simply at its level. This is what staggers
     * the fade by depth: near silt at 180 ms, chimney at 300, far rock at 520,
     * plankton last at 700.
     */
    this.revealPhase = null;
    /** Camera scale. The one camera move in the game: an 8% dolly back (§7.2). */
    this.camera = 1;
    /** Screen-wide bloom flood, staged by the environment reveal. */
    this.flood = 0;
    /**
     * What colour the flood is. The environment reveal is the colony's own light,
     * so it is LUMEN; the settlement flood is banked money arriving, so it is
     * AMBER. Nothing else may set this — the two are the only screen-wide washes
     * in the game and they mean different things.
     */
    this.floodTint = 'lumen';
    /** Celebration sparks, alive only during a T2/T3 settlement. */
    this.sparks = [];
    /** Whether the frame has been worth `475/48` at any point this round (§7.2). */
    this.envRevealed = false;
    /** MEDUSA rim strength, and only ever on a `D >= +1.00x` verdict (§6.5). */
    this.medusaRim = 0;
    /** The draw-flash contraction: every body contracts 4% for 120 ms. */
    this.contract = 0;
    /**
     * The anticipation of §2's draw flash: the frame holds its breath before the
     * generation resolves. It is a *dip*, identical for every generation and
     * fired before any outcome is known, so it leaks nothing and it can never
     * make a frame brighter than a frame worth more (§6.3) — it only ever makes
     * one darker, and only for 120 ms.
     */
    this.charge = 0;
    /**
     * The verdict's weight: how far the exposure change of §6.4 overshoots its
     * new `E(V)` before settling. Signed, and a function of `D` alone (§6.5 R1) —
     * a gain arrives above its steady state and falls into it, a loss arrives
     * below and rises into it. Monotone in `D`, which is R4.
     */
    this.verdictBoost = 0;
    /** The verdict's ring, and the tint it carries. */
    this.verdictRing = null;
    /** The pulse wave that carries a generation's outcomes outward. */
    this.wave = null;
    /** Banked-this-round value, as a stake multiple. Drives the vessel. */
    this.banked = 0;
    this.vesselLevel = 0;
    this.vesselPulse = 0;
    this.vesselAlpha = 0;

    this.tweens = [];
    this.timers = new Set();
    this.pending = new Set();
    this.motes = [];
    this.snow = [];
    this.shaft = null;
    this.background = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.time = 0;
    this.lastFrame = 0;
    this.running = false;
    /**
     * Which round the stage is drawing.
     *
     * The settlement beats are long — the flood runs about two seconds and the
     * pour a second — and `NEW ROUND` unlocks after 600 ms, so a player can start
     * the next round while the last one's ceremony is still running. `reset()`
     * ends the animations, but an `async` beat parked on a `wait()` resumes the
     * moment `skip()` resolves it and then keeps going: it would clear the bodies
     * of a colony that had just been seeded, or flood a stake screen with amber.
     * Every beat that outlives a frame checks this before touching anything.
     */
    this.generation = 0;

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(root);
    this.installGrain();
    this.resize();
    this.start();
  }

  // ------------------------------------------------------------------ geometry

  get scale() {
    return this.width / REFERENCE_WIDTH;
  }

  /** Centre of the colony: the vent-plume centroid, at 38% of the stage. */
  get centre() {
    return { x: this.width / 2, y: this.height * 0.4 };
  }

  resize() {
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    if (width === 0 || height === 0) return;
    // DPR is capped at 2: the whole scene is bloom and gradient, and the third
    // pixel of a 3x backing store costs 2.25x the fill for no visible gain.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.background = this.bakeBackground();
    this.shaft = shaftSprite(width * 0.78, height * 0.72);
    this.seedParticles();
    this.relayout(true);
    /*
     * Setting `canvas.width` clears the backing store, and the loop idles itself
     * whenever nothing is animating — so a resize that landed while the stage was
     * idle left a **blank canvas** with nothing scheduled to repaint it. That is
     * the whole reason S1 was a black void: the ResizeObserver fires once on
     * observe, just after the constructor's first paint and just after the loop
     * has parked itself, so the very first thing a player ever saw was the vent
     * scene wiped out. No scrim tuning could have fixed it, because there was
     * nothing behind the scrim.
     */
    this.start();
  }

  /**
   * The water: a near-black blue-green depth gradient with a vignette, plus the
   * unlit environment (silt, chimney, far rock) baked in at full value. It is
   * composited at the environment's own opacity, which is a function of `E(V)` —
   * so nothing here is ever *switched on*: it was always there and always unlit
   * (§7.2), and it can never make a poorer frame brighter than a richer one.
   */
  bakeBackground() {
    const { width, height, dpr } = this;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const water = ctx.createLinearGradient(0, 0, 0, height);
    water.addColorStop(0, 'rgb(2, 4, 10)');
    water.addColorStop(0.42, 'rgb(4, 11, 18)');
    water.addColorStop(0.78, 'rgb(6, 18, 26)');
    water.addColorStop(1, 'rgb(3, 9, 15)');
    ctx.fillStyle = water;
    ctx.fillRect(0, 0, width, height);

    // A cold cast toward the trench walls, so the frame has depth before any
    // light exists in it.
    const cast = ctx.createRadialGradient(width / 2, height * 0.36, 0, width / 2, height * 0.36, width * 1.05);
    cast.addColorStop(0, rgba(C.trench, 0.55));
    cast.addColorStop(0.7, 'rgba(2, 8, 14, 0)');
    ctx.fillStyle = cast;
    ctx.fillRect(0, 0, width, height);

    const vignette = ctx.createRadialGradient(width / 2, height * 0.42, width * 0.24, width / 2, height * 0.42, width * 0.95);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.72)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    /*
     * The ambient floor §6.3 specifies at `V = 0` — the vent's fixed rim light
     * and the 2% PLANKTON ambient — baked in rather than composited every frame.
     *
     * It is a *constant*: the same contribution in every frame of every round, so
     * it cannot reorder two frames by value and §6.3's promise is untouched. And
     * because it is constant it belongs in the background, which is rendered once
     * per resize. Compositing it live cost two extra full-screen passes a frame
     * for a term that never changes, which took the resolve beat from 60 fps to
     * about 20 in the headless harness.
     */
    const cold = ctx.createLinearGradient(0, 0, 0, height * 0.66);
    cold.addColorStop(0, rgba(C.plankton, 0.05));
    cold.addColorStop(0.55, rgba(C.plankton, 0.022));
    cold.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = cold;
    ctx.fillRect(0, 0, width, height * 0.66);

    const warm = ctx.createLinearGradient(0, height * 0.58, 0, height);
    warm.addColorStop(0, 'rgba(0, 0, 0, 0)');
    warm.addColorStop(1, rgba(C.ember, 0.06));
    ctx.fillStyle = warm;
    ctx.fillRect(0, height * 0.58, width, height * 0.42);
    ctx.globalCompositeOperation = 'source-over';
    return canvas;
  }

  /**
   * §7.2's particulate: 240 plankton sprites in a depth shell and 60 larger ASH
   * motes of marine snow. Positions and phases come from `slotRandom`, so the
   * field is identical on every device and derived from nothing the round knows.
   */
  seedParticles() {
    const count = this.reduced ? 90 : 240;
    this.motes = [];
    for (let index = 0; index < count; index += 1) {
      this.motes.push({
        x: slotRandom(index, 3) * this.width,
        y: slotRandom(index, 5) * this.height,
        depth: 0.35 + slotRandom(index, 7) * 0.65,
        size: (1.5 + slotRandom(index, 9) * 1.5) * this.scale,
        phase: slotRandom(index, 11) * Math.PI * 2,
        rate: 0.3 + slotRandom(index, 13) * 0.4,
        drift: (slotRandom(index, 15) - 0.5) * 0.6,
      });
    }
    this.snow = [];
    for (let index = 0; index < 60; index += 1) {
      this.snow.push({
        x: slotRandom(index, 21) * this.width,
        y: slotRandom(index, 23) * this.height,
        size: (4 + slotRandom(index, 25) * 3) * this.scale,
        drift: (slotRandom(index, 27) - 0.5) * 0.5,
      });
    }
  }

  // --------------------------------------------------------------- scheduling

  /**
   * A cancellable beat. Tapping the stage ends the current animation and nothing
   * else (§9.7): `skip()` completes every live tween and resolves every wait, so
   * the resolved state arrives immediately — and the action bar is still inert
   * for the dead period afterwards, which is app-side and unaffected.
   */
  wait(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = { resolve };
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.pending.delete(entry);
        resolve();
      }, ms);
      entry.timer = timer;
      this.timers.add(timer);
      this.pending.add(entry);
    });
  }

  skip() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const waiting = [...this.pending];
    this.pending.clear();
    for (const tween of this.tweens) tween.t = tween.ms;
    this.step(0);
    for (const entry of waiting) entry.resolve();
  }

  /**
   * Tweens a numeric field on `target` toward `to`. Under
   * `prefers-reduced-motion` a positional or scalar move still happens — it
   * carries information — but at a fraction of the duration, so nothing on
   * screen slides for 400 ms.
   */
  tween(target, key, to, ms, easing = ease.standard) {
    const duration = this.reduced ? Math.min(ms, 120) : ms;
    this.tweens = this.tweens.filter((entry) => !(entry.target === target && entry.key === key));
    if (duration <= 0) {
      target[key] = to;
      return;
    }
    this.tweens.push({ target, key, from: target[key], to, ms: duration, t: 0, easing });
    this.start();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const frame = (now) => {
      if (!this.running) return;
      // Clamped at both ends. The upper bound keeps a backgrounded tab from
      // fast-forwarding a beat on return; the lower one matters because a frame's
      // rAF timestamp can predate the `performance.now()` the loop was armed
      // with, which would otherwise run the clock backwards on the first frame.
      const dt = Math.max(0, Math.min(48, now - this.lastFrame));
      this.lastFrame = now;
      this.step(dt);
      this.paint();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  step(dt) {
    this.time += dt;
    const done = [];
    for (const tween of this.tweens) {
      tween.t = Math.min(tween.ms, tween.t + dt);
      const t = tween.ms === 0 ? 1 : tween.t / tween.ms;
      tween.target[tween.key] = lerp(tween.from, tween.to, tween.easing(t));
      if (tween.t >= tween.ms) done.push(tween);
    }
    if (done.length > 0) this.tweens = this.tweens.filter((entry) => !done.includes(entry));

    // Exposure settles to `E(V)` — a first-order approach, so it is continuous
    // through a skip rather than snapping. The environment follows the same curve,
    // because §7.2 makes its level a function of the same value.
    const k = 1 - Math.exp(-dt / 130);
    this.exposure += (this.exposureTarget - this.exposure) * k;
    this.environment += (this.environmentTarget - this.environment) * k;

    // Trails: each harvested body's light travelling to the vessel.
    for (const trail of this.trails) trail.t = Math.min(1, trail.t + dt / trail.ms);
    this.trails = this.trails.filter((trail) => trail.t < 1 || trail.hold > 0);

    if (this.wave !== null) {
      this.wave.t += dt;
      if (this.wave.t > this.wave.ms) this.wave = null;
    }
    if (this.verdictRing !== null) {
      this.verdictRing.t += dt;
      if (this.verdictRing.t > this.verdictRing.ms) this.verdictRing = null;
    }
    if (this.vesselPulse > 0) this.vesselPulse = Math.max(0, this.vesselPulse - dt / 380);

    // Celebration sparks: ballistic, with a light drag, rising out of frame. The
    // array is only rebuilt on the frames where one actually expired — filtering
    // eighty-six of them every frame allocates through the loudest two seconds
    // in the game for nothing.
    if (this.sparks.length > 0) {
      let expired = false;
      for (const spark of this.sparks) {
        spark.life += dt;
        spark.x += spark.vx * dt * 0.06;
        spark.y += spark.vy * dt * 0.06;
        spark.vy += dt * 0.0009 * this.scale;
        spark.vx *= 1 - dt * 0.0009;
        if (spark.life >= spark.ms) expired = true;
      }
      if (expired) this.sparks = this.sparks.filter((spark) => spark.life < spark.ms);
    }
  }

  setNote(html) {
    this.note.innerHTML = html ?? '';
  }

  // ------------------------------------------------------------------- values

  /**
   * Applies `E(V)`: the colony's halation, the water's lit level, the motes, the
   * rays and the environment's rise above the black floor — all of them
   * functions of the one number, which is the money (§6.3).
   */
  setValue(valueMultiple) {
    this.value = Math.max(0, valueMultiple);
    this.exposureTarget = exposure(this.value);
    /*
     * The environment threshold (§6.3, §7.2).
     *
     * Nothing is switched on. The environment was always there and always unlit,
     * and `475/48` is the exposure at which it stops being below the black floor.
     * Once it is above the floor it **stays lit and dims with the exposure like
     * everything else** — so its level is a monotone function of colony value from
     * that point on, and a re-crossing produces no second reveal, because a
     * spectacle keyed to crossing a line is exactly what §7.2 refuses.
     */
    const floor = exposure(ENVIRONMENT_THRESHOLD);
    if (this.exposureTarget >= floor - 1e-9) this.envRevealed = true;
    // Two ramps meeting at the threshold: `62%` lit the moment the frame is worth
    // `475/48`, climbing to fully lit at `V_max`, and falling back along the first
    // ramp if the colony becomes poorer. Monotone in value on both sides, and
    // never zero once it has been above the floor.
    const below = clamp01((this.exposureTarget - EXPOSURE_MIN) / (floor - EXPOSURE_MIN));
    const above = clamp01((this.exposureTarget - floor) / (EXPOSURE_MAX - floor));
    this.environmentTarget = this.envRevealed ? 0.62 * below + 0.38 * above : 0;
    this.root.style.setProperty('--exposure', this.exposureTarget.toFixed(4));
    this.root.style.setProperty('--environment', this.environmentTarget.toFixed(4));
    this.start();
  }

  /** Banked-this-round value, in stake multiples. The vessel's fill (§6.1 AMBER). */
  setBanked(multipleOfStake) {
    this.banked = Math.max(0, multipleOfStake);
    // Log-scaled so a 0.4x bank is visible and a 20x one fills the glass.
    const level = clamp01(Math.log2(1 + this.banked) / Math.log2(1 + 20));
    this.tween(this, 'vesselLevel', level, 520, ease.decel);
    // The vessel exists once there is something in it. An empty glass drawn on
    // every frame of every round is a UI box in the corner of the stage that the
    // game never explains; the trails arriving *are* the explanation.
    this.tween(this, 'vesselAlpha', this.banked > 0 ? 1 : 0, 320, ease.decel);
  }

  /** True once the frame is worth at least `475/48`, i.e. the world is lit. */
  get environmentLit() {
    return this.environment > 0.001;
  }

  /**
   * A copy of the last painted frame, for the share card (§7.1).
   *
   * The picture on a share card has to be the round's own, so this is taken while
   * the colony is still standing — the caller freezes before the beat that takes
   * it away, not after. One `drawImage` into an offscreen canvas, at most twice a
   * round; nothing is captured per frame.
   */
  freeze() {
    if (this.canvas.width === 0 || this.canvas.height === 0) return null;
    const snapshot = document.createElement('canvas');
    snapshot.width = this.canvas.width;
    snapshot.height = this.canvas.height;
    snapshot.getContext('2d').drawImage(this.canvas, 0, 0);
    return snapshot;
  }

  // -------------------------------------------------------------------- layout

  makeBody(slot) {
    return {
      slot,
      archetype: slot % 3,
      /**
       * A per-body tilt, so the nucleus does not point the same way on every
       * organism and three baked archetypes read as fifteen individuals. Derived
       * from the slot index and from nothing else (§6.2).
       */
      tilt: slotRandom(slot, 19) * Math.PI * 2,
      phase: slotRandom(slot, 1) * Math.PI * 2,
      driftSeed: slot * 7 + 3,
      x: this.centre.x,
      y: this.centre.y,
      r: 0,
      alpha: 0,
      outcome: null,
      /** Split state: progress, axis, and the two child offsets. */
      split: 0,
      splitAxis: slotRandom(slot, 31) * Math.PI,
      die: 0,
      hold: 0,
      tint: 'lumen',
    };
  }

  /**
   * Places `units` bodies on the spiral. Existing bodies keep their slot, and
   * every position change is a tween rather than a jump — which is what makes a
   * colony that doubles read as a colony that *grew* rather than a list that got
   * longer.
   */
  relayout(immediate = false) {
    const units = Math.max(0, this.units);
    const { x: cx, y: cy } = this.centre;
    const scale = this.scale;
    const radius = bodyRadius(Math.max(units, 1)) * scale;
    this.bodies.forEach((body, index) => {
      const slot = index + 1;
      const { x, y } = bodyPosition(slot, Math.max(units, 1));
      const tx = cx + x * scale;
      const ty = cy + y * scale;
      if (immediate) {
        body.x = tx;
        body.y = ty;
        body.r = radius;
        return;
      }
      // Staggered by ring position, so the reflow ripples outward instead of
      // every body sliding on the same frame.
      const delay = Math.min(140, index * 9);
      const duration = 460 + delay;
      this.tween(body, 'x', tx, duration, ease.decel);
      this.tween(body, 'y', ty, duration, ease.decel);
      this.tween(body, 'r', radius, duration, ease.decel);
    });
  }

  /** Renders `units` bodies. Public for the reconnect path, which has no beat. */
  render(units, { immediate = false } = {}) {
    const previous = this.units;
    this.units = units;
    while (this.bodies.length > units) this.bodies.pop();
    while (this.bodies.length < units) {
      const body = this.makeBody(this.bodies.length + 1);
      body.alpha = immediate ? 1 : 0;
      this.bodies.push(body);
      if (!immediate) this.tween(body, 'alpha', 1, 320, ease.decel);
    }
    for (const body of this.bodies) {
      body.outcome = null;
      body.split = 0;
      body.die = 0;
      body.hold = 0;
      body.tint = 'lumen';
      if (immediate) body.alpha = 1;
    }
    if (previous !== units || immediate) this.relayout(immediate);
    else this.relayout(false);
    this.announce(units);
    this.start();
  }

  announce(units) {
    this.colony.setAttribute('aria-label', `${units} organism${units === 1 ? '' : 's'}`);
  }

  // --------------------------------------------------------------------- beats

  /**
   * S2 — three organisms fade up from the vent over 700 ms.
   *
   * `onBody(index, pan)` fires as each one lights, so the caller can sound its
   * breath panned by screen position (§8).
   */
  async seed(units, onBody) {
    this.units = units;
    this.bodies = [];
    const { x: cx } = this.centre;
    const ventY = this.height * 0.94;
    for (let slot = 1; slot <= units; slot += 1) {
      const body = this.makeBody(slot);
      body.x = cx + (slotRandom(slot, 41) - 0.5) * 40 * this.scale;
      body.y = ventY;
      body.r = 4 * this.scale;
      body.alpha = 0;
      this.bodies.push(body);
    }
    this.announce(units);
    await this.wait(30);
    this.bodies.forEach((body, index) => {
      const delay = index * 90;
      setTimeout(() => {
        this.tween(body, 'alpha', 1, 520, ease.decel);
        onBody?.(index, this.panOf(body));
      }, delay);
    });
    this.relayout(false);
    await this.wait(700);
  }

  /** A body's stereo position, `-1` to `1`, from where it sits on screen (§8). */
  panOf(body) {
    if (this.width === 0) return 0;
    return Math.max(-1, Math.min(1, ((body.x / this.width) * 2 - 1) * 0.7));
  }

  /**
   * S3, the outcome half of the resolution beat: draw flash (120 ms) then every
   * organism resolving inside one 400 ms window. Organisms never resolve one at a
   * time — a fourteen-organism generation must not take fourteen seconds — so
   * what carries the outcomes is a *pulse wave* that crosses the whole colony in
   * at most 140 ms. The wave is identical for DIE, HOLD and SPLIT, which is
   * §6.5 R2's legibility parity: equal weight, not equal excitement.
   *
   * `onOutcome(id, pan)` fires as each body plays its outcome, so the caller can
   * sound the mark on the same frame the body moves.
   */
  async resolveOutcomes(resolution, nextUnits, onOutcome) {
    /*
     * Draw flash, and the anticipation the round-1 build did not have (§6.4).
     *
     * The vent pulses once and all bodies contract 4% — and the frame *holds its
     * breath*: the light dips and the colony draws in for 120 ms before anything
     * resolves. It is the same dip on every generation, fired before a single
     * outcome is read, so it cannot leak what is coming; and it is what turns
     * "the numbers changed" into "something is about to happen".
     */
    this.contract = 1;
    this.tween(this, 'contract', 0, 260, ease.standard);
    this.charge = 0;
    this.tween(this, 'charge', 1, 110, ease.standard);
    this.ventFlash = 1;
    this.tween(this, 'ventFlash', 0, 320, ease.accel);
    await this.wait(120);
    this.tween(this, 'charge', 0, 240, ease.decel);

    const { x: cx, y: cy } = this.centre;
    // The wave reaches just past the colony and stops: it is a pulse through the
    // colony, not a shockwave through the frame.
    const reach = Math.max(60 * this.scale, layoutRadius(Math.max(this.units, 1)) * this.scale * 1.9);
    this.wave = { t: 0, ms: 380, reach };

    const bodies = this.bodies;
    const children = [];
    let nextSlot = 0;
    let lastLead = 0;
    for (const outcome of resolution.outcomes) {
      const body = bodies[outcome.slot - 1];
      const distance = body === undefined ? 0 : Math.hypot(body.x - cx, body.y - cy);
      // Capped at 110 ms, and the beat waits for the last body to *finish*. The
      // round-1 build reflowed at a flat 400 ms from the start of the wave, so a
      // body that fired 140 ms late only ever showed 260 ms of its 400 ms split —
      // which is why the best mid-round outcome in the game was over in a flash.
      const lead = Math.min(110, (distance / reach) * 160);
      if (lead > lastLead) lastLead = lead;
      for (let child = 0; child < outcome.children; child += 1) {
        nextSlot += 1;
        children.push({ parent: outcome.slot, index: child, of: outcome.children, slot: nextSlot });
      }
      if (body === undefined) continue;
      body.outcome = outcome.id;
      const fire = () => {
        onOutcome?.(outcome.id, this.panOf(body));
        if (outcome.id === 'SPLIT') {
          this.tween(body, 'split', 1, 400, ease.elastic);
        } else if (outcome.id === 'HOLD') {
          // One soft brightness pulse, +15% then back.
          this.tween(body, 'hold', 1, 125, ease.standard);
          setTimeout(() => this.tween(body, 'hold', 0, 125, ease.standard), this.reduced ? 40 : 125);
        } else {
          // Core dims to zero, membrane collapses inward, the remnant drifts down
          // and out — and the body's light leaves the scene, which is the frame
          // measurably darkening (§6.5 R3).
          this.tween(body, 'die', 1, 400, ease.accel);
          this.tween(body, 'alpha', 0, 400, ease.accel);
        }
      };
      if (lead <= 8 || this.reduced) fire();
      else setTimeout(fire, lead);
    }

    await this.wait(400 + (this.reduced ? 0 : lastLead));

    // The children take the parent's split positions, then reflow to the spiral.
    const positions = new Map();
    for (const child of children) {
      const parent = bodies[child.parent - 1];
      if (parent === undefined) continue;
      const spread = parent.r * 1.1;
      const offset = child.of === 1 ? 0 : (child.index === 0 ? -1 : 1) * spread;
      positions.set(child.slot, {
        x: parent.x + Math.cos(parent.splitAxis) * offset,
        y: parent.y + Math.sin(parent.splitAxis) * offset,
      });
    }
    this.reflowInto(nextUnits, positions);
  }

  /** Rebuilds the colony at `units`, seeding new bodies from `positions`. */
  reflowInto(units, positions) {
    const fresh = [];
    for (let slot = 1; slot <= units; slot += 1) {
      const body = this.makeBody(slot);
      const seedPoint = positions.get(slot);
      const previous = this.bodies[slot - 1];
      if (seedPoint !== undefined) {
        body.x = seedPoint.x;
        body.y = seedPoint.y;
        body.r = (previous?.r ?? bodyRadius(units) * this.scale) * 0.7;
        body.alpha = 1;
      } else if (previous !== undefined) {
        body.x = previous.x;
        body.y = previous.y;
        body.r = previous.r;
        body.alpha = 1;
      } else {
        body.x = this.centre.x;
        body.y = this.centre.y;
        body.r = 2;
        body.alpha = 0;
        this.tween(body, 'alpha', 1, 300, ease.decel);
      }
      fresh.push(body);
    }
    this.tweens = this.tweens.filter((tween) => !this.bodies.includes(tween.target));
    this.bodies = fresh;
    this.units = units;
    this.announce(units);
    this.relayout(false);
  }

  /**
   * The verdict beat: 380 ms in which the exposure settles to its new `E(V)`.
   *
   * In the round-1 build that was all it was — a `wait(380)` with nothing in it,
   * which is why a 3 → 1 resolve went static for the last 360 ms of its own beat
   * and a gain at generation 11 with eighteen stakes on the table got exactly the
   * treatment of a hold at generation 1.
   *
   * What fills it now is **weight**, and weight is a function of `D` — the signed
   * change in colony value in stake multiples — and of nothing else (§6.5 R1).
   * The exposure change of §6.4 arrives with an overshoot whose size scales with
   * `|D|`: a gain lands above its new steady state and falls into it, a loss
   * lands below and rises into it. A larger `D` never gets less than a smaller
   * one (R4), and because `D` grows with the colony and the ladder, the beat
   * escalates through the round on its own without anything keying off the
   * population, the generation, or how the change was arrived at.
   *
   * The ring is the same device in the same currency: outward and bright on a
   * gain, inward and dim on a loss, absent at `D = 0`. Above a whole stake it is
   * MEDUSA, which is the one place violet is allowed to appear (§6.1).
   */
  async verdict(delta = 0) {
    const magnitude = Math.min(2.4, Math.abs(delta));
    /*
     * The ring's reach is a property of the *frame*, not of the colony.
     *
     * Deriving it from `layoutRadius(this.units)` — which is what a first pass
     * did — makes two generations with the same `D` but different populations
     * get differently sized rings, and R1 says the verdict's treatment is a
     * function of `D` and of nothing else. Nothing in this method reads the
     * population, the generation, or how the change was arrived at.
     */
    const reach = Math.min(this.width, this.height) * 0.66;

    // Under `prefers-reduced-motion` the ring does not run at all. It is
    // emphasis, and §6.4 keeps only the beats that carry information — which
    // here is the exposure change, and that still happens.
    if (this.reduced) {
      if (delta !== 0) {
        const boost = delta > 0 ? 0.05 + 0.16 * Math.min(1, magnitude / 1.6) : -(0.04 + 0.1 * Math.min(1, magnitude / 1.4));
        this.verdictBoost = boost;
        this.tween(this, 'verdictBoost', 0, 120, ease.standard);
      }
      await this.wait(380);
      return;
    }

    if (delta > 0) {
      const peak = 0.05 + 0.16 * Math.min(1, magnitude / 1.6);
      this.verdictBoost = 0;
      this.tween(this, 'verdictBoost', peak, 150, ease.decel);
      this.verdictRing = {
        t: 0,
        ms: 520,
        reach,
        tint: delta >= 1 ? 'medusa' : 'lumen',
        strength: 0.3 + 0.5 * Math.min(1, magnitude / 1.6),
        inward: false,
      };
      setTimeout(() => this.tween(this, 'verdictBoost', 0, 330, ease.standard), 160);
    } else if (delta < 0) {
      const depth = -(0.04 + 0.1 * Math.min(1, magnitude / 1.4));
      this.verdictBoost = 0;
      this.tween(this, 'verdictBoost', depth, 130, ease.standard);
      this.verdictRing = {
        t: 0,
        ms: 460,
        reach,
        tint: 'ash',
        strength: 0.14 + 0.2 * Math.min(1, magnitude / 1.4),
        inward: true,
      };
      setTimeout(() => this.tween(this, 'verdictBoost', 0, 320, ease.decel), 140);
    }
    this.start();
    await this.wait(380);
  }

  /**
   * §6.5's `D >= +1.00x` treatment: a MEDUSA rim on every body for 240 ms, and
   * nothing else. Violet on screen therefore always means the position just grew
   * by more than the player paid to enter.
   */
  async medusa() {
    this.medusaRim = 0;
    this.tween(this, 'medusaRim', 1, 90, ease.standard);
    await this.wait(150);
    this.tween(this, 'medusaRim', 0, 150, ease.standard);
    await this.wait(90);
  }

  /**
   * §7.2 — the environment reveal, and the clip the marketing case rests on.
   *
   * Fired at most once a round, at the moment the colony first crosses
   * `475/48 = 9.895833x`. It replaces that generation's verdict beat and the
   * round continues. It is keyed to a **value**, never to a population, so every
   * FULL BLOOM lights it and so does every frame worth as much.
   *
   * Beat by beat: exposure ramps 0–420 ms; silt, chimney, far rock and plankton
   * fade up staggered by depth 180–700 ms; exposure eases to steady state
   * 700–1,000 ms. The camera does not cut, shake or zoom — it dollies back 8% on
   * the same easing, and that is the only camera move in the game.
   *
   * Under `prefers-reduced-motion` the dolly and the stagger become a single
   * 400 ms cross-fade to the lit frame. The reveal still happens, because it
   * carries information.
   */
  async revealEnvironment() {
    this.envRevealed = true;
    this.floodTint = 'lumen';
    if (this.reduced) {
      // A single 400 ms cross-fade to the lit frame: no dolly, no stagger. The
      // reveal still happens, because it carries information (§6.4, §7.2).
      this.revealPhase = null;
      this.tween(this, 'flood', 0.3, 200, ease.standard);
      await this.wait(400);
      this.tween(this, 'flood', 0, 240, ease.standard);
      await this.wait(240);
      return;
    }
    this.revealPhase = 0;
    this.tween(this, 'revealPhase', 1000, 1000, ease.linear);
    this.tween(this, 'camera', CAMERA_MIN, 1000, ease.decel);
    this.tween(this, 'flood', 1, 420, ease.decel);
    await this.wait(420);
    // The wash holds, rather than spiking and vanishing: the clip is a second of
    // light, and the exposure it settles to is genuinely higher than the one it
    // came from, so the frame stays brighter afterwards because it is worth more.
    this.tween(this, 'flood', 0.5, 380, ease.standard);
    await this.wait(380);
    this.tween(this, 'flood', 0, 420, ease.standard);
    await this.wait(420);
    this.revealPhase = null;
  }

  /**
   * A depth layer's own progress through the reveal, staggered by depth (§7.2).
   * `1` whenever no reveal is running, which is every other frame in the game.
   */
  depthPhase(startMs, durationMs = 340) {
    if (this.revealPhase === null) return 1;
    return clamp01((this.revealPhase - startMs) / durationMs);
  }

  /**
   * S5 — the harvest beat, 400 ms. The harvested bodies take AMBER at their
   * existing intensity, detach and stream to the vessel as light trails; the
   * survivors close ranks.
   *
   * No swell, no shower, no count-up flourish: a harvest moves money between the
   * colony and the balance without changing its amount, so `D = 0` and it gets
   * the `D = 0` treatment (§6.5 R6). What it *does* get is legibility — the
   * player has to be able to see where their money went — which is what the
   * trails and the vessel are for.
   *
   * `onArrival` fires once per body as its trail lands, so the caller can sound
   * the informational mark and tick the balance chip on the same frame.
   */
  async harvest(harvested, remaining, wildUnits, onArrival) {
    const bodies = this.bodies;
    const vessel = this.vesselMouth();
    const taken = [];
    for (let index = bodies.length - harvested; index < bodies.length; index += 1) {
      const body = bodies[index];
      if (body !== undefined) taken.push(body);
    }
    taken.forEach((body, order) => {
      body.tint = 'amber';
      const delay = Math.min(180, order * (harvested > 6 ? 22 : 46));
      const duration = this.reduced ? 140 : 300;
      this.trails.push({
        t: 0,
        ms: duration,
        delay,
        hold: 0,
        from: { x: body.x, y: body.y },
        to: vessel,
        // A bowed path, so a stream of trails reads as a stream rather than a
        // bundle of straight lines.
        bow: (slotRandom(body.slot, 53) - 0.5) * 0.5 + 0.28,
        r: body.r,
        fired: false,
        onArrival,
      });
      setTimeout(() => {
        this.tween(body, 'alpha', 0, duration, ease.decel);
        this.tween(body, 'r', body.r * 0.4, duration, ease.decel);
      }, delay);
    });
    this.showGhosts(wildUnits);
    await this.wait(400);
    this.hideGhosts();
    this.render(remaining);
  }

  /** Where the trails land: the mouth of the vessel, in canvas pixels. */
  vesselMouth() {
    const width = 46 * this.scale;
    const x = this.width - 22 * this.scale - width / 2;
    const y = this.height - 82 * this.scale;
    return { x, y };
  }

  /**
   * The balance chip, in stage-local pixels. It lives in the top bar, above this
   * canvas, so the point is off the top edge on purpose: value leaving the stage
   * for the chip should visibly leave the frame rather than stop at its border.
   */
  chipMouth() {
    return { x: 62 * this.scale, y: -20 * this.scale };
  }

  /**
   * S7 — the round's take going home (§7.1).
   *
   * At settlement the money stops being a colony and becomes a balance, and the
   * player has to be able to watch that happen: the vessel empties and anything
   * still alive turns AMBER, detaches and streams out of the top of the frame
   * toward the chip the value lands in. This is the only beat that drains the
   * vessel, and it exists because a count-up with nothing moving on the stage is
   * a receipt rather than a ceremony.
   *
   * It runs on wins only. A round that returned less than it cost keeps its
   * vessel exactly where it is — the story there is what the player kept (§5,
   * S6), and money flowing into an amber chip is the one thing §7.1 forbids
   * below the stake.
   */
  async bankOut(onArrival) {
    const target = this.chipMouth();
    const sources = [];
    for (const body of this.bodies) {
      body.tint = 'amber';
      sources.push({ x: body.x, y: body.y, r: body.r, body });
    }
    if (this.vesselAlpha > 0.02) {
      const mouth = this.vesselMouth();
      // The vessel does not empty in one drop: the number of arrivals scales with
      // how full it is, so a big bank reads as a longer pour.
      const drops = Math.max(2, Math.min(8, 2 + Math.round(this.vesselLevel * 8)));
      for (let index = 0; index < drops; index += 1)
        sources.push({ x: mouth.x, y: mouth.y, r: 10 * this.scale, vessel: true });
    }
    if (sources.length === 0) return;
    const round = this.generation;

    const duration = this.reduced ? 160 : 520;
    sources.forEach((source, order) => {
      const delay = Math.min(420, order * (sources.length > 8 ? 34 : 64));
      this.trails.push({
        t: 0,
        ms: duration,
        delay,
        hold: 0,
        from: { x: source.x, y: source.y },
        to: target,
        bow: (slotRandom(order, 59) - 0.5) * 0.42 - 0.18,
        r: source.r,
        fired: false,
        onArrival,
      });
      if (source.body !== undefined)
        setTimeout(() => {
          this.tween(source.body, 'alpha', 0, duration, ease.decel);
          this.tween(source.body, 'r', source.body.r * 0.35, duration, ease.decel);
        }, delay);
    });
    // The glass empties as the pour leaves it, and then it is dark: the value is
    // in the balance now, and a vessel still holding it would be saying otherwise.
    this.tween(this, 'vesselLevel', 0, duration + 380, ease.standard);
    this.tween(this, 'vesselAlpha', 0, duration + 520, ease.standard);
    await this.wait(duration + 440);
    // The next round may already have been seeded: clearing its colony here
    // would empty a stage the player is looking at.
    if (this.generation !== round) return;
    this.bodies = [];
    this.units = 0;
    this.banked = 0;
    this.setValue(0);
    this.announce(0);
  }

  /**
   * §7.1's frame lift, at T2 and T3 only.
   *
   * The tier table says the frame lifts one exposure stop at T2 and goes to full
   * illumination at T3 — but by the time a settlement is on screen the colony has
   * usually just been banked away, so `E(V)` is at its floor and there is no
   * colony light left to lift. The ceremony therefore supplies its own, in AMBER,
   * which is the colour of banked value: what is flooding the frame is the money
   * arriving, not a colony that no longer exists. `E(V)` is untouched, so §6.3's
   * promise — no frame is brighter than a frame worth more money — is not being
   * asked to describe a frame that has no money in it any more.
   */
  async celebrate(tier) {
    const peak = tier === 'T3' ? 1 : 0.6;
    const round = this.generation;
    this.floodTint = 'amber';
    this.flood = 0;
    if (this.reduced) {
      this.tween(this, 'flood', peak * 0.5, 160, ease.standard);
      await this.wait(300);
      if (this.generation !== round) return;
      this.tween(this, 'flood', 0, 260, ease.standard);
      return;
    }
    this.emitSparks(tier === 'T3' ? 86 : 44);
    this.tween(this, 'flood', peak, 360, ease.decel);
    await this.wait(360);
    // `NEW ROUND` unlocks after 600 ms, so from here on the round may be over.
    // A flood that resumes on the stake screen is amber light on a screen where
    // nothing has been banked.
    if (this.generation !== round) return;
    this.tween(this, 'flood', peak * 0.44, 560, ease.standard);
    await this.wait(560);
    if (this.generation !== round) return;
    this.tween(this, 'flood', 0, 1100, ease.standard);
    await this.wait(1100);
  }

  /**
   * The sparks of a loud settlement: banked light rising out of the frame.
   *
   * Every constant here comes from `slotRandom`, so the shower is identical on
   * every device and derived from nothing the round knows — the same rule the
   * colony's own art follows (§6.2). They are AMBER because they are money that
   * has already been credited, and they exist at T2 and T3 and nowhere else.
   */
  emitSparks(count) {
    const centre = this.centre;
    for (let index = 0; index < count; index += 1) {
      const angle = slotRandom(index, 67) * Math.PI * 2;
      const speed = (0.16 + slotRandom(index, 71) * 0.5) * this.scale;
      this.sparks.push({
        x: centre.x + Math.cos(angle) * 30 * this.scale * slotRandom(index, 73),
        y: centre.y + Math.sin(angle) * 22 * this.scale * slotRandom(index, 79),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (0.16 + slotRandom(index, 83) * 0.26) * this.scale,
        size: (3 + slotRandom(index, 89) * 7) * this.scale,
        life: 0,
        ms: 900 + slotRandom(index, 97) * 900,
      });
    }
    this.start();
  }

  /**
   * The wild-line ghost (§4.2, §6.4): the colony that never gets harvested,
   * drawn for the 400 ms of the harvest beat and never as a standing rival
   * colony (§9.8). 22% PLANKTON, no halation, no specular, no point light — it
   * contributes nothing to the exposure, because it is not money. §6.3 states
   * this exemption rather than leaving a renderer to discover it.
   */
  showGhosts(wildUnits) {
    if (!Number.isInteger(wildUnits) || wildUnits <= 0) return;
    this.ghostUnits = wildUnits;
    this.ghostAlpha = 0;
    this.tween(this, 'ghostAlpha', 1, 160, ease.standard);
  }

  hideGhosts() {
    this.tween(this, 'ghostAlpha', 0, 200, ease.standard);
    setTimeout(() => {
      if (this.ghostAlpha < 0.02) this.ghostUnits = 0;
    }, 260);
  }

  /**
   * S6 — extinction. The last core dims and collapses; the scene falls to the
   * vent's ember rim and a 2% PLANKTON ambient over 400 ms. Do not fade to a
   * bright screen; the dark is the point.
   *
   * The vessel stays lit if anything was harvested: the story is what the player
   * kept, not what they lost.
   */
  async extinguish() {
    for (const body of this.bodies) {
      body.outcome = 'DIE';
      this.tween(body, 'die', 1, 400, ease.accel);
      this.tween(body, 'alpha', 0, 400, ease.accel);
    }
    this.setValue(0);
    await this.wait(420);
    this.bodies = [];
    this.units = 0;
    this.announce(0);
  }

  reset() {
    // Anything still running belongs to the round that just ended.
    this.generation += 1;
    this.skip();
    this.tweens = [];
    this.bodies = [];
    this.trails = [];
    this.units = 0;
    this.ghostUnits = 0;
    this.ghostAlpha = 0;
    this.environment = 0;
    this.envRevealed = false;
    this.camera = 1;
    this.flood = 0;
    this.floodTint = 'lumen';
    this.sparks = [];
    this.medusaRim = 0;
    this.contract = 0;
    this.charge = 0;
    this.verdictBoost = 0;
    this.verdictRing = null;
    this.ventFlash = 0;
    this.banked = 0;
    this.vesselLevel = 0;
    this.vesselPulse = 0;
    this.vesselAlpha = 0;
    this.wave = null;
    this.setNote('');
    this.root.style.setProperty('--environment', '0');
    this.setValue(0);
    this.announce(0);
  }

  // -------------------------------------------------------------------- paint

  paint() {
    const ctx = this.ctx;
    const { width, height, dpr } = this;
    if (width === 0 || height === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);
    if (this.background !== null) ctx.drawImage(this.background, 0, 0, width, height);

    /*
     * The frame's working exposure: `E(V)`, held down for the 120 ms the frame
     * spends holding its breath, and overshooting by the weight of the verdict.
     * Both are transients of the two beats §6.4 specifies — the draw flash and
     * the exposure change — and both settle back onto `E(V)`, which is what the
     * whole scene is lit from and what §6.3's promise is about.
     */
    const level = Math.max(0.02, Math.min(1, this.exposure * (1 - 0.24 * this.charge) + this.verdictBoost));
    // The camera dolly: the one camera move in the game, and it moves the whole
    // world including the particulate, which is what gives it parallax.
    ctx.save();
    ctx.translate(width / 2, height * 0.42);
    ctx.scale(this.camera, this.camera);
    ctx.translate(-width / 2, -height * 0.42);

    // The world layers are drawn over-sized so the dolly never reveals an edge.
    ctx.save();
    ctx.translate(width / 2, height * 0.42);
    ctx.scale(OVERDRAW, OVERDRAW);
    ctx.translate(-width / 2, -height * 0.42);
    this.drawWaterLight(ctx, level);
    this.drawEnvironment(ctx, level);
    this.drawParticles(ctx, level);
    this.drawVent(ctx, level);
    ctx.restore();

    this.drawShafts(ctx, level);
    this.drawGhosts(ctx);
    this.drawColony(ctx, level);
    this.drawTrails(ctx);
    ctx.restore();

    this.drawVessel(ctx);
    this.drawSparks(ctx);
    this.drawFlood(ctx);

    // Idle only when nothing is animating: a static frame must not spin the GPU.
    const idle =
      this.tweens.length === 0 &&
      this.trails.length === 0 &&
      this.sparks.length === 0 &&
      this.flood < 0.004 &&
      this.wave === null &&
      this.verdictRing === null &&
      Math.abs(this.verdictBoost) < 0.002 &&
      this.charge < 0.002 &&
      Math.abs(this.exposureTarget - this.exposure) < 0.0005 &&
      this.vesselPulse === 0;
    if (idle && this.bodies.length === 0 && !this.environmentLit) this.running = false;
  }

  /**
   * The water taking the colony's colour.
   *
   * §6.3 says nothing is lit that the colony does not light, and the round-1
   * build read that as *nothing is lit at all*: the water was a baked near-black
   * gradient that never changed, so the whole play surface was one cyan hue on
   * black at every value, and measured mean frame luminance never left the
   * 19–31-out-of-255 band. That is the abyssal direction executed as
   * premium-minimal rather than premium-casino, and it is not what the brief
   * asks for.
   *
   * This is the volumetric term §6.2 asks for, and it is *lit* rather than
   * emitting: every alpha below is a multiple of `level`, which is `E(V)`, so the
   * water is exactly as bright as the colony is rich and a poorer frame can never
   * outshine a richer one. The one constant term is the `2% PLANKTON ambient`
   * §6.3 already specifies at `V = 0` — a constant offset added to every frame
   * alike, which is what stops "the vent idle in darkness" from being a black
   * rectangle and cannot reorder any two frames.
   */
  drawWaterLight(ctx, level) {
    if (level < 0.05) return;
    const { width, height } = this;
    const centre = this.centre;
    // One pre-rendered sprite scaled to the colony's reach, rather than a radial
    // gradient built and filled across the whole frame every frame: same picture,
    // one blit, no per-frame gradient object. The constant ambient this used to
    // carry now lives in the baked background, where it belongs.
    const reach = Math.hypot(width, height) * (0.4 + 0.62 * level);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3 * level;
    ctx.drawImage(this.sprites.waterBody, centre.x - reach, centre.y - reach, reach * 2, reach * 2);
    ctx.restore();
  }

  /** Silt, chimney and far rock, at the environment's own lit level (§7.2). */
  drawEnvironment(ctx, level) {
    const lit = this.environment;
    if (lit < 0.002) return;
    const { width, height } = this;
    const nearSilt = this.depthPhase(180);
    const chimney = this.depthPhase(300);
    const farRock = this.depthPhase(520);
    ctx.save();
    ctx.globalAlpha = lit * farRock;

    /*
     * The materials of §7.2, in depth order, each *lit by the colony*: their
     * albedo is fixed and dark (BASALT at 30% value, CRUST at 12% and 6%), so what
     * makes them appear is the exposure multiplying them. Every alpha below is a
     * function of `level`, which is `E(V)` — so the world is exactly as bright as
     * the colony is rich, and never brighter.
     */
    const litColour = (from, to) => [
      Math.round(lerp(from[0], to[0], level)),
      Math.round(lerp(from[1], to[1], level)),
      Math.round(lerp(from[2], to[2], level)),
    ];
    const rockColour = litColour(C.basalt, C.crust);

    // Far rock: two parallax cards, the thing the dolly moves against.
    const rock = ctx.createRadialGradient(width * 0.1, height * 0.62, 0, width * 0.1, height * 0.62, width * 0.62);
    rock.addColorStop(0, rgba(rockColour, 0.6 * level));
    rock.addColorStop(0.6, rgba(rockColour, 0.18 * level));
    rock.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rock;
    ctx.fillRect(0, height * 0.3, width, height * 0.62);
    const rock2 = ctx.createRadialGradient(width * 0.95, height * 0.52, 0, width * 0.95, height * 0.52, width * 0.5);
    rock2.addColorStop(0, rgba(rockColour, 0.4 * level));
    rock2.addColorStop(0.6, rgba(rockColour, 0.12 * level));
    rock2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rock2;
    ctx.fillRect(0, height * 0.26, width, height * 0.62);

    // Chimney: the existing vent geometry, lit from above by the colony, which
    // is the first time its silhouette resolves.
    ctx.globalAlpha = lit * chimney;
    const chimneyWidth = 148 * this.scale;
    const chimneyTop = height * 0.62;
    const wall = ctx.createLinearGradient(0, chimneyTop, 0, height);
    wall.addColorStop(0, rgba(C.basalt, 0.3 * level));
    wall.addColorStop(0.45, rgba(C.basalt, 0.9 * level));
    wall.addColorStop(1, rgba([9, 24, 32], 0.96));
    ctx.fillStyle = wall;
    const chimney1 = new Path2D();
    chimney1.moveTo(width / 2 - chimneyWidth * 0.17, chimneyTop);
    chimney1.quadraticCurveTo(width / 2 - chimneyWidth * 0.34, height * 0.82, width / 2 - chimneyWidth * 0.54, height);
    chimney1.lineTo(width / 2 + chimneyWidth * 0.54, height);
    chimney1.quadraticCurveTo(width / 2 + chimneyWidth * 0.32, height * 0.82, width / 2 + chimneyWidth * 0.17, chimneyTop);
    chimney1.closePath();
    ctx.fill(chimney1);
    // A lit crust on the chimney's *rim*, from the light above it — the two edges
    // the colony can see, and not the outline of the whole shape: stroking the
    // closed path draws a wireframe pyramid, which is the one thing a rock is not.
    ctx.strokeStyle = rgba(C.crust, 0.8 * level);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(width / 2 - chimneyWidth * 0.17, chimneyTop);
    ctx.quadraticCurveTo(width / 2 - chimneyWidth * 0.34, height * 0.82, width / 2 - chimneyWidth * 0.54, height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width / 2 + chimneyWidth * 0.17, chimneyTop);
    ctx.quadraticCurveTo(width / 2 + chimneyWidth * 0.32, height * 0.82, width / 2 + chimneyWidth * 0.54, height);
    ctx.stroke();

    // Near silt: the lower 18% of the frame, with a soft horizon so the floor
    // reads as a floor rather than as a gradient.
    ctx.globalAlpha = lit * nearSilt;
    const siltColour = litColour(C.silt, C.basalt);
    const silt = ctx.createLinearGradient(0, height * 0.8, 0, height);
    silt.addColorStop(0, 'rgba(0,0,0,0)');
    silt.addColorStop(0.35, rgba(siltColour, 0.5 * level));
    silt.addColorStop(1, rgba(siltColour, 0.95));
    ctx.fillStyle = silt;
    ctx.beginPath();
    ctx.moveTo(0, height * 0.86);
    ctx.quadraticCurveTo(width * 0.3, height * 0.82, width * 0.52, height * 0.845);
    ctx.quadraticCurveTo(width * 0.8, height * 0.87, width, height * 0.83);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();
    // The horizon: one lit edge where the silt meets the water, brightest under
    // the colony and fading out at the frame edges the colony's light never reaches.
    const horizon = ctx.createLinearGradient(0, 0, width, 0);
    horizon.addColorStop(0, rgba(C.crust, 0));
    horizon.addColorStop(0.5, rgba(C.crust, 0.45 * level));
    horizon.addColorStop(1, rgba(C.crust, 0));
    ctx.strokeStyle = horizon;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height * 0.86);
    ctx.quadraticCurveTo(width * 0.3, height * 0.82, width * 0.52, height * 0.845);
    ctx.quadraticCurveTo(width * 0.8, height * 0.87, width, height * 0.83);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Drifting plankton and marine snow.
   *
   * Nothing here emits: a mote's brightness is an ambient floor plus the colony's
   * own light falling on it with quadratic falloff, so the particulate is bright
   * exactly where and when the colony is (§6.3, "nothing is lit that the colony
   * does not light"). That also keeps the field monotone in value.
   */
  drawParticles(ctx, level) {
    const { width, height } = this;
    const seconds = this.time / 1000;
    const centre = this.centre;
    const colonyReach = (60 + 130 * level) * this.scale;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sprite = this.sprites.planktonGlow;
    for (const mote of this.motes) {
      const drift = noise1(seconds * 0.08 + mote.phase, mote.driftSeed ?? 3);
      const x = (mote.x + (drift - 0.5) * 26 * this.scale * mote.depth + width) % width;
      const y = (mote.y + seconds * 0.9 * this.scale * mote.depth) % height;
      const twinkle = 0.6 + 0.4 * Math.sin(seconds * mote.rate * Math.PI * 2 + mote.phase);
      const distance = Math.hypot(x - centre.x, y - centre.y);
      const falloff = 1 / (1 + Math.pow(distance / colonyReach, 2));
      // Drifting plankton is the last layer up in the reveal, at 700 ms (§7.2).
      // The constant term is §6.3's ambient floor, raised until it is actually
      // visible: "vent idle in darkness" is a picture of water, and water with no
      // life in it at all is a black rectangle.
      const alpha =
        (0.085 + 0.42 * level * falloff + 0.16 * this.environment * this.depthPhase(700, 300)) *
        twinkle *
        mote.depth;
      if (alpha < 0.006) continue;
      const size = mote.size * (3.8 + 3.2 * level);
      ctx.globalAlpha = Math.min(0.78, alpha);
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }
    // Marine snow: ASH, larger, slower, and what makes the water read as water
    // rather than as fog.
    ctx.globalCompositeOperation = 'source-over';
    // One `fillStyle` for the whole field rather than one per mote: sixty state
    // changes a frame is sixty chances to break the rasteriser's batching.
    ctx.fillStyle = rgba(C.ash, 1);
    for (const mote of this.snow) {
      const x = (mote.x + mote.drift * seconds * 4 * this.scale + width) % width;
      const y = (mote.y + seconds * 1.4 * this.scale) % height;
      const distance = Math.hypot(x - centre.x, y - centre.y);
      const falloff = 1 / (1 + Math.pow(distance / colonyReach, 2));
      // Marine snow is what makes the water read as water rather than as fog, so
      // its constant term has to be visible at `V = 0` too — that frame is a
      // picture of water and nothing else.
      const alpha = 0.055 + 0.19 * level * falloff + 0.06 * this.environment;
      ctx.globalAlpha = Math.min(0.32, alpha);
      ctx.beginPath();
      ctx.ellipse(x, y, mote.size / 2, mote.size / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The vent: one warm ember from below, EMBER only, and never more than the ~5%
   * of frame §6.1 allows it. It is the only thing on screen that emits without
   * being the colony, and the mouth's gradient never moves (§6.2) — the plume
   * above it does, because that is water.
   */
  drawVent(ctx, level) {
    const { width, height } = this;
    const flash = this.ventFlash ?? 0;
    const scale = this.scale;
    const seconds = this.time / 1000;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // The wide bloom the mouth throws into the water.
    const size = (250 + 90 * flash) * scale;
    ctx.globalAlpha = 0.34 + 0.3 * flash;
    ctx.drawImage(this.sprites.emberGlow, width / 2 - size / 2, height - size * 0.46, size, size * 0.72);

    /*
     * The plume: a column of warm shimmer rising from the mouth, built from soft
     * sprites rather than a filled path — a path has edges, and hot water has
     * none.
     *
     * It rises through the water column rather than stopping just above the
     * mouth. "Vent idle in darkness" (§5, S1) is a picture of *water*, and the
     * round-1 plume topped out at 130 pt, which left the upper two thirds of the
     * frame with nothing in it at all on the one screen a player sees before
     * every single round.
     */
    const puffs = 6;
    for (let index = 0; index < puffs; index += 1) {
      const t = index / (puffs - 1);
      const rise = 34 * scale + t * 300 * scale;
      const sway = (noise1(seconds * 0.14 + index * 1.7, 71) - 0.5) * (10 + 42 * t) * scale;
      const puff = (58 + t * 116) * scale;
      // The column cools as it rises: warm at the mouth, fading to nothing well
      // before it could read as a second light source.
      ctx.globalAlpha = (0.2 - t * 0.175) * (1 + 0.9 * flash);
      ctx.drawImage(
        this.sprites.emberGlow,
        width / 2 + sway - puff / 2,
        height - rise - puff / 2,
        puff,
        puff,
      );
    }

    // The mouth itself: hot, small, fixed.
    const core = 96 * scale;
    ctx.globalAlpha = 0.62 + 0.36 * flash;
    ctx.drawImage(this.sprites.emberGlow, width / 2 - core / 2, height - core * 0.48, core, core * 0.56);
    ctx.globalAlpha = 0.76 + 0.24 * flash;
    const mouth = 34 * scale;
    ctx.drawImage(this.sprites.emberGlow, width / 2 - mouth / 2, height - mouth * 0.55, mouth, mouth * 0.6);
    ctx.restore();
  }

  /** §7.2's volumetric shafts: two blurred quads, animated only by the colony. */
  drawShafts(ctx, level) {
    if (this.shaft === null) return;
    const alpha = 0.02 + 0.05 * this.environment + 0.07 * level;
    // Two blits the size of the frame for something invisible below about a fifth
    // of full exposure. The threshold is where they start to read, not where they
    // stop being zero.
    if (alpha < 0.032) return;
    const centre = this.centre;
    const seconds = this.time / 1000;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [index, sign] of [[0, -1], [1, 1]]) {
      const sway = (noise1(seconds * 0.06 + index * 3, 61) - 0.5) * 0.14;
      ctx.save();
      ctx.translate(centre.x, centre.y);
      // Wide enough that the two cones do not land on the chimney's own edges: a
      // shaft that coincides with a silhouette reads as geometry, not as light.
      ctx.rotate(sign * 0.34 + sway);
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.shaft, -this.shaft.width / 2, -20 * this.scale, this.shaft.width, this.shaft.height);
      ctx.restore();
    }
    ctx.restore();
  }

  drawGhosts(ctx) {
    if (this.ghostUnits <= 0 || this.ghostAlpha < 0.01) return;
    const { x: cx, y: cy } = this.centre;
    const scale = this.scale;
    const radius = bodyRadius(this.ghostUnits) * scale;
    ctx.save();
    // Additive so a 22% trace is legible against near-black water, but a *flat*
    // sprite: no halation, no specular, no falloff that could read as light. It
    // contributes nothing to the exposure, because it is not money (§6.3, §6.4).
    ctx.globalCompositeOperation = 'lighter';
    for (let slot = 1; slot <= this.ghostUnits; slot += 1) {
      const { x, y } = bodyPosition(slot, this.ghostUnits);
      const px = cx + x * scale;
      const py = cy + y * scale;
      const size = radius * 2.1;
      // A trace, not an outline. A stroked ring reads as a UI element and, at
      // twelve of them over a live colony, as a second interface.
      ctx.globalAlpha = 0.28 * this.ghostAlpha;
      ctx.drawImage(this.sprites.planktonFlat, px - size / 2, py - size / 2, size, size);
    }
    ctx.restore();
  }

  /**
   * The colony: halation, then bodies, then the rim.
   *
   * Per-body radiance is `R_ref * c(t) / c(1)`, and the frame's exposure is the
   * tone-mapped total — so a single late organism reads as a small sun and twelve
   * dim ones read as twelve dim ones (§6.3). Halation scales with that exposure:
   * a wide low-opacity bloom (32 → 96 px, 12% → 26%) plus a tight core bloom.
   */
  drawColony(ctx, level) {
    if (this.bodies.length === 0) return;
    const seconds = this.time / 1000;
    const contract = 1 - 0.04 * this.contract;

    /*
     * Halation, in two passes, and it is the single most important material
     * effect in the game (§6.2): a wide, low-opacity bloom that grows 32 → 96 px
     * and 12% → 26% with the frame's exposure, plus a tight core bloom. Without
     * it the organisms look like stickers, which is exactly what the graybox's
     * flat discs were.
     *
     * A thin PLANKTON halo sits between the two. The round-1 art direction asked
     * for a magenta outer halo; magenta cannot be that, because §6.1 reserves
     * MEDUSA for a verdict worth at least one whole stake — a permanent violet rim
     * would make violet mean nothing. PLANKTON is the in-palette cool edge and it
     * gives the same two-tone chromatic read against the cyan core.
     */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const wide = this.sprites.lumenGlow;
    const halo = this.sprites.planktonGlow;
    for (const body of this.bodies) {
      if (body.alpha < 0.01) continue;
      const radius = body.r * contract * (1 - 0.6 * body.die);
      const alive = body.alpha * (1 - body.die);
      // The gain on both terms is steeper than the round-1 build's, so the top
      // of the range is genuinely bright rather than merely less dark. Both are
      // still strictly increasing in `level`, which is all §6.3 requires.
      const size = radius * (4.6 + 6.4 * level);
      ctx.globalAlpha = (0.22 + 0.5 * level) * alive;
      ctx.drawImage(wide, body.x - size / 2, body.y - size / 2, size, size);
      const cool = radius * (2.7 + 1.1 * level);
      ctx.globalAlpha = (0.13 + 0.17 * level) * alive;
      ctx.drawImage(halo, body.x - cool / 2, body.y - cool / 2, cool, cool);
    }
    ctx.restore();

    // Bodies, with the split's cell division and the death's collapse. Additive:
    // an overlap brightens rather than occludes, which is what §6.4's "up to 30%
    // overlap with additive blending" means at sixteen organisms and above.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const body of this.bodies) {
      if (body.alpha < 0.01) continue;
      this.drawBody(ctx, body, level, contract, seconds);
    }
    ctx.restore();

    // Tight core bloom, in front, so the nucleus reads as the hottest point.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const tight = this.sprites.lumenTight;
    for (const body of this.bodies) {
      if (body.alpha < 0.01 || body.tint === 'amber') continue;
      const radius = body.r * contract * (1 - 0.6 * body.die);
      const size = radius * (1.7 + 0.5 * level);
      ctx.globalAlpha = (0.36 + 0.44 * level) * body.alpha * (1 - body.die);
      ctx.drawImage(tight, body.x - size / 2, body.y - size / 2, size, size);
    }
    ctx.restore();

    // The pulse wave: one ring per generation, crossing the whole colony.
    if (this.wave !== null) this.drawWave(ctx);
    // The verdict's ring, in the currency of the money: outward on a gain,
    // inward on a loss, and never present at all when nothing changed.
    if (this.verdictRing !== null) this.drawVerdictRing(ctx);

    // MEDUSA, and only on a `D >= +1.00x` verdict.
    if (this.medusaRim > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const body of this.bodies) {
        if (body.alpha < 0.01) continue;
        const size = body.r * 2.9;
        ctx.globalAlpha = 0.5 * this.medusaRim * body.alpha;
        ctx.drawImage(this.sprites.medusaGlow, body.x - size / 2, body.y - size / 2, size, size);
      }
      ctx.strokeStyle = rgba(C.medusa, 0.85 * this.medusaRim);
      ctx.lineWidth = 1.6;
      for (const body of this.bodies) {
        if (body.alpha < 0.01) continue;
        ctx.beginPath();
        ctx.ellipse(body.x, body.y, body.r * 1.06, body.r * 1.06, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /**
   * One body, and the outcome it is playing.
   *
   * SPLIT is the cell division of §6.4: the body elongates, pinches at the waist,
   * and two bodies snap apart with a 12% elastic overshoot — joined for the
   * middle of the beat by a thin light filament, which is the frame that makes
   * "it divided" legible rather than "there are now two of them".
   */
  drawBody(ctx, body, level, contract, seconds) {
    const breath = 1 + 0.055 * Math.sin(seconds * 0.8 * Math.PI * 2 + body.phase) * (this.reduced ? 0 : 1);
    const drift = this.reduced
      ? { x: 0, y: 0 }
      : {
          x: (noise1(seconds * 0.14 + body.phase, body.driftSeed) - 0.5) * 5 * this.scale,
          y: (noise1(seconds * 0.11 + body.phase + 7, body.driftSeed + 1) - 0.5) * 5 * this.scale,
        };
    const dieShrink = 1 - 0.6 * body.die;
    const radius = body.r * contract * breath * dieShrink;
    const x = body.x + drift.x;
    const y = body.y + drift.y + body.die * 26 * this.scale;
    const sprite = (body.tint === 'amber' ? this.sprites.amberBells : this.sprites.bells)[body.archetype];
    const bright = (1 + 0.15 * body.hold) * (1 - 0.85 * body.die);

    ctx.save();
    ctx.globalAlpha = body.alpha * bright;

    if (body.split > 0.001) {
      // Elongate (0 → 0.35), pinch (0.35 → 0.6), snap apart (0.6 → 1).
      const p = clamp01(body.split);
      const elongate = p < 0.35 ? p / 0.35 : 1;
      const separation = p < 0.3 ? 0 : ((p - 0.3) / 0.7) * radius * 1.05;
      const stretch = 1 + 0.24 * elongate * (1 - clamp01((p - 0.3) / 0.4));
      const squash = 1 - 0.16 * elongate * (1 - clamp01((p - 0.3) / 0.4));
      const axis = body.splitAxis;
      const dx = Math.cos(axis) * separation;
      const dy = Math.sin(axis) * separation;
      const childRadius = radius * lerp(1, 0.78, clamp01((p - 0.2) / 0.8));

      // The filament: two glowing children joined by a thread of their own light.
      if (separation > radius * 0.12) {
        const fade = 1 - clamp01((p - 0.55) / 0.42);
        if (fade > 0.02) {
          ctx.save();
          ctx.globalAlpha = body.alpha * 0.85 * fade;
          const gradient = ctx.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
          gradient.addColorStop(0, rgba(C.lumenHigh, 0.9));
          gradient.addColorStop(0.5, rgba(C.lumen, 0.35));
          gradient.addColorStop(1, rgba(C.lumenHigh, 0.9));
          ctx.strokeStyle = gradient;
          ctx.lineWidth = Math.max(1, radius * 0.22 * fade);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x - dx, y - dy);
          ctx.lineTo(x + dx, y + dy);
          ctx.stroke();
          ctx.restore();
        }
      }

      for (const sign of [-1, 1]) {
        ctx.save();
        ctx.translate(x + sign * dx, y + sign * dy);
        ctx.rotate(axis + body.tilt);
        ctx.scale(stretch, squash);
        ctx.drawImage(sprite, -childRadius, -childRadius, childRadius * 2, childRadius * 2);
        ctx.restore();
      }
      ctx.restore();
      return;
    }

    ctx.translate(x, y);
    ctx.rotate(body.tilt);
    ctx.drawImage(sprite, -radius, -radius, radius * 2, radius * 2);
    ctx.restore();
  }

  /**
   * The pulse wave: one ring per generation, expanding from the vent-plume
   * centroid through the colony. It is the same wave for every outcome, which is
   * §6.5 R2 — it makes the beat legible without making any one outcome loud.
   */
  drawWave(ctx) {
    const wave = this.wave;
    const t = clamp01(wave.t / wave.ms);
    const radius = ease.decel(t) * wave.reach;
    const alpha = Math.pow(1 - t, 1.6) * 0.4;
    if (alpha < 0.008 || radius < 1) return;
    const { x: cx, y: cy } = this.centre;
    const size = radius * 2.4;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.sprites.pulseRing, cx - size / 2, cy - size / 2 * 0.94, size, size * 0.94);
    ctx.restore();
  }

  /**
   * The verdict's ring (§6.5's verdict bands, drawn).
   *
   * A gain sends light *out* of the colony; a loss draws the frame *in* on it.
   * Both are the same device at the same place in the beat, differing only in
   * direction, tint and strength — and all three of those are functions of `D`,
   * which is R1. Nothing here knows how many organisms split or died.
   */
  drawVerdictRing(ctx) {
    const ring = this.verdictRing;
    const t = clamp01(ring.t / ring.ms);
    const travel = ring.inward ? 1 - ease.decel(t) : ease.decel(t);
    const radius = (ring.inward ? 0.25 + 0.75 * travel : travel) * ring.reach;
    const alpha = Math.pow(1 - t, 1.7) * ring.strength;
    if (alpha < 0.006 || radius < 1) return;
    const { x: cx, y: cy } = this.centre;
    const size = radius * 2.4;
    const sprite =
      ring.tint === 'medusa'
        ? this.sprites.medusaRing
        : ring.tint === 'ash'
          ? this.sprites.ashRing
          : this.sprites.pulseRing;
    ctx.save();
    // A loss removes light rather than adding it, so its ring is composited
    // normally over the water instead of additively: darkness is the channel a
    // loss gets (§6.5 R3), and an additive grey would be one more thing glowing.
    ctx.globalCompositeOperation = ring.inward ? 'source-over' : 'lighter';
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, cx - size / 2, cy - (size / 2) * 0.94, size, size * 0.94);
    ctx.restore();
  }

  /** The harvest trails: banked light on its way to the vessel. */
  drawTrails(ctx) {
    if (this.trails.length === 0) return;
    const now = this.time;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const trail of this.trails) {
      if (trail.delay > 0) {
        trail.delay -= 16.7;
        continue;
      }
      const t = clamp01(trail.t);
      if (!trail.fired && t >= 1) {
        trail.fired = true;
        this.vesselPulse = 1;
        trail.onArrival?.();
      }
      const eased = ease.decel(t);
      const control = {
        x: lerp(trail.from.x, trail.to.x, 0.5) + (trail.to.y - trail.from.y) * trail.bow,
        y: lerp(trail.from.y, trail.to.y, 0.5) - (trail.to.x - trail.from.x) * trail.bow * 0.4,
      };
      const at = (u) => ({
        x: (1 - u) * (1 - u) * trail.from.x + 2 * (1 - u) * u * control.x + u * u * trail.to.x,
        y: (1 - u) * (1 - u) * trail.from.y + 2 * (1 - u) * u * control.y + u * u * trail.to.y,
      });
      // A tapering tail behind a bright head, sampled densely enough that it reads
      // as one streak of light rather than a dotted line.
      const segments = 18;
      for (let index = 0; index < segments; index += 1) {
        const u = Math.max(0, eased - index * 0.026);
        const point = at(u);
        const size = trail.r * (1.7 - index * 0.062) * (1 - 0.45 * t);
        if (size <= 0) continue;
        ctx.globalAlpha = (0.34 - index * 0.017) * (1 - t * 0.3);
        ctx.drawImage(this.sprites.amberGlow, point.x - size / 2, point.y - size / 2, size, size);
      }
      if (t >= 1) trail.hold = 0;
    }
    ctx.restore();
  }

  /**
   * The vessel: the one warm object in a cold world, and where banked value
   * pools.
   *
   * §5 (S5) says harvested bodies travel to the balance chip, and they do — the
   * chip ticks on each arrival, in AMBER, which is the colour of banked value and
   * appears nowhere else (§6.1). The vessel is that value made physical on the
   * stage so the transfer has somewhere to land, and it is placed off the vent
   * axis so the game's one EMBER source and its one AMBER source never mix.
   *
   * **Why an emitter outside `E(V)` is admissible here.** §6.3's promise is that
   * no frame is ever brighter than a frame worth more money, and it names the
   * wild-line ghost as its one exemption. The vessel is the second, and it is a
   * narrower one: it is lit *by* money — banked money, which the player already
   * owns — so it strengthens the pillar rather than weakening it. Its glow is
   * capped well below a single body's, it is AMBER and therefore never mistakable
   * for colony light, and it is dark and empty until something has actually been
   * banked. At extinction it stays lit if anything was harvested, because the
   * story is what the player kept.
   */
  drawVessel(ctx) {
    const scale = this.scale;
    const width = 46 * scale;
    const height = 62 * scale;
    const x = this.width - 22 * scale - width;
    const y = this.height - 82 * scale;
    const presence = this.vesselAlpha;
    if (presence < 0.01) return;
    const cxv = x + width / 2;
    const shoulder = 11 * scale;

    // A beaker: straight walls, a rounded base and an open rim, so the trails have
    // a mouth to arrive at and the silhouette is not another rounded rectangle.
    const path = new Path2D();
    path.moveTo(x, y);
    path.lineTo(x, y + height - shoulder);
    path.quadraticCurveTo(x, y + height, x + shoulder, y + height);
    path.lineTo(x + width - shoulder, y + height);
    path.quadraticCurveTo(x + width, y + height, x + width, y + height - shoulder);
    path.lineTo(x + width, y);

    ctx.save();
    ctx.globalAlpha = presence;
    ctx.fillStyle = 'rgba(10, 27, 40, 0.22)';
    ctx.fill(path);
    ctx.strokeStyle = rgba(C.amber, 0.4 + 0.3 * this.vesselPulse);
    ctx.lineWidth = 1;
    ctx.stroke(path);
    // The rim: one line across the mouth, brighter than the walls.
    ctx.strokeStyle = rgba(C.amber, 0.55);
    ctx.beginPath();
    ctx.moveTo(x - 3 * scale, y);
    ctx.lineTo(x + width + 3 * scale, y);
    ctx.stroke();

    ctx.save();
    {
      // `clip` needs the path closed to fill it; the open rim is a stroke-only
      // affordance, so the fill uses the same walls with the mouth sealed.
      const bowl = new Path2D(path);
      bowl.closePath();
      ctx.clip(bowl);
      const fill = Math.max(0.08, this.vesselLevel) * height * 0.8;
      const top = y + height - fill;
      const liquid = ctx.createLinearGradient(0, top, 0, y + height);
      liquid.addColorStop(0, rgba(C.amber, 0.92));
      liquid.addColorStop(1, 'rgba(196, 126, 44, 0.78)');
      ctx.fillStyle = liquid;
      ctx.fillRect(x, top, width, fill + 2);
      // The meniscus: one bright line at the surface, bowed as a surface is.
      ctx.strokeStyle = rgba([255, 240, 214], 0.95);
      ctx.lineWidth = Math.max(1, 1.4 * scale);
      ctx.beginPath();
      ctx.moveTo(x, top + 1.5 * scale);
      ctx.quadraticCurveTo(cxv, top - 1.5 * scale, x + width, top + 1.5 * scale);
      ctx.stroke();
      // One vertical specular on the glass, so it reads as glass.
      const sheen = ctx.createLinearGradient(x, 0, x + width, 0);
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.2, 'rgba(255,255,255,0.16)');
      sheen.addColorStop(0.34, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(x, y, width, height);
    }
    ctx.restore();

    // Its own halation, capped well below a single body's, plus a brief riser:
    // light leaving the vessel toward the balance chip the value landed in.
    ctx.globalCompositeOperation = 'lighter';
    const glow = width * (2.6 + 0.9 * this.vesselPulse);
    ctx.globalAlpha = (0.18 + 0.24 * this.vesselPulse) * presence;
    ctx.drawImage(this.sprites.amberGlow, cxv - glow / 2, y + height * 0.72 - glow / 2, glow, glow);
    if (this.vesselPulse > 0.01) {
      const riser = ctx.createLinearGradient(0, y - 54 * scale, 0, y + 4 * scale);
      riser.addColorStop(0, rgba(C.amber, 0));
      riser.addColorStop(1, rgba(C.amber, 0.45 * this.vesselPulse));
      ctx.fillStyle = riser;
      ctx.globalAlpha = presence;
      ctx.fillRect(cxv - 1.5 * scale, y - 54 * scale, 3 * scale, 58 * scale);
    }
    ctx.restore();
  }

  /**
   * The celebration sparks: banked light rising out of the frame at T2 and T3.
   * Additive AMBER sprites with a soft in-and-out, so the shower has no edges.
   */
  drawSparks(ctx) {
    if (this.sparks.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sprite = this.sprites.amberGlow;
    for (const spark of this.sparks) {
      const t = clamp01(spark.life / spark.ms);
      const alpha = Math.min(1, t / 0.12) * Math.pow(1 - t, 1.4);
      if (alpha < 0.01) continue;
      const size = spark.size * (1 + 1.1 * t);
      ctx.globalAlpha = 0.5 * alpha;
      ctx.drawImage(sprite, spark.x - size / 2, spark.y - size / 2, size, size);
    }
    ctx.restore();
  }

  /**
   * The two screen-wide washes in the game, and they mean different things.
   *
   * The environment reveal (§7.2) is the frame filling with light because the
   * colony is worth at least `475/48`, so it is LUMEN — the colony's own colour.
   * The settlement flood (§7.1, T2 and T3) is banked value arriving, so it is
   * AMBER, which is the colour of money that is already the player's. Neither is
   * instantaneous: both are staged, because the clip is a second of light rather
   * than a flash.
   */
  drawFlood(ctx) {
    if (this.flood < 0.004) return;
    const { width, height } = this;
    const centre = this.centre;
    const warm = this.floodTint === 'amber';
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const size = Math.hypot(width, height) * (1.5 + 0.6 * this.flood);
    ctx.globalAlpha = (warm ? 0.62 : 0.5) * this.flood;
    ctx.drawImage(
      warm ? this.sprites.amberGlow : this.sprites.lumenGlow,
      centre.x - size / 2,
      centre.y - size / 2,
      size,
      size,
    );
    ctx.globalAlpha = (warm ? 0.24 : 0.16) * this.flood;
    ctx.drawImage(this.sprites.foamGlow, centre.x - size / 2, centre.y - size / 2, size, size);
    ctx.restore();
  }

  /**
   * §6.2's fine grain: 2% monochrome noise, cycled at 12 fps — handed to the
   * compositor instead of drawn.
   *
   * It used to be a full-screen pattern fill on every canvas frame, for a texture
   * that is the same texture on every frame of the game. That is one whole
   * screen of fill rate a frame spent on something that does not move, and with
   * the richer water on top of it the resolve beat no longer fitted in a 16.7 ms
   * budget in the headless harness. As a repeating background on its own element
   * it is rasterized once, animated by `background-position` in steps, and costs
   * the render loop nothing at all.
   *
   * The tile is still generated in this repository, from the same seeded noise —
   * it is handed over as a data URL rather than fetched.
   */
  installGrain() {
    const layer = this.root.querySelector('#stage-grain');
    if (layer === null) return;
    layer.style.backgroundImage = `url(${this.sprites.grain[0].toDataURL()})`;
  }
}
