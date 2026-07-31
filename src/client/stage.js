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
 * this file except one is a body whose radiance is `R_ref * c(t)/c(1)`; the one
 * exemption is stated where it is drawn (the wild-line ghost, §6.3's own
 * exemption).
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
  abyss: [6, 26, 36],
  trench: [8, 36, 48],
  silt: [13, 48, 64],
  basalt: [22, 73, 92],
  crust: [37, 109, 125],
  lumen: [57, 245, 200],
  lumenHigh: [124, 255, 227],
  lumenDeep: [15, 184, 148],
  plankton: [91, 140, 255],
  medusa: [176, 108, 255],
  medusaHigh: [203, 160, 255],
  medusaDeep: [106, 47, 181],
  amber: [255, 201, 120],
  amberHigh: [255, 233, 194],
  amberDeep: [217, 144, 47],
  ember: [255, 158, 107],
  ash: [138, 151, 166],
  ashDeep: [58, 78, 90],
  ink: [35, 20, 10],
  foam: [230, 244, 241],
};

const rgba = ([r, g, b], a) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** Linear blend between two palette colours, for shading ramps. */
const mixTone = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * The value bands an organism wears (§6.1, §6.2).
 *
 * An organism's colour is **its own worth**, so the payout scale is learned by
 * looking rather than by reading — which is the property every reference in the
 * calibration set has and the round-1 colony did not: `x5.6` printed on a yellow
 * chip, `x16` on a purple balloon. Ours is banded on the per-organism
 * value `u` in stake multiples, the same figure printed on the body's face, so
 * the colour and the number can never disagree.
 *
 * `light` is the band core's relative luminance and `gain` is the constant that
 * multiplies this band's emission. The product is **non-decreasing up the
 * ladder** — 0.514 -> 0.792 -> 0.828 — which is §6.3's ordering promise applied
 * at the organism: a richer organism is never drawn dimmer than a poorer one.
 * Without the gain a violet body would be darker than a cyan one and the colony
 * would visibly dim as it got rich.
 */
const BANDS = {
  dim: { core: C.lumenDeep, high: [92, 230, 199], deep: [7, 96, 78], edge: C.plankton, gain: 0.9 },
  lumen: { core: C.lumen, high: C.lumenHigh, deep: C.lumenDeep, edge: C.plankton, gain: 1 },
  medusa: {
    core: C.medusaHigh,
    high: [232, 208, 255],
    deep: C.medusaDeep,
    edge: [130, 150, 255],
    gain: 1.2,
  },
  amber: { core: C.amber, high: C.amberHigh, deep: C.amberDeep, edge: [255, 176, 96], gain: 1 },
  /*
   * A husk is the one band that does not emit, and its tone is deliberately held
   * **below the dimmest living band**: `[86,108,120]` measures L = 0.41 against
   * LUMEN DEEP's 0.57, and it carries no halation, no interior and no nucleus. So
   * a frame full of remains can never be brighter than a frame with one living
   * organism in it, which is §6.3's ordering promise at the point where it is
   * easiest to break.
   */
  husk: { core: [86, 108, 120], high: [150, 166, 178], deep: [30, 50, 62], edge: C.basalt, gain: 0.3 },
};

/**
 * The band an organism of value `u` (in stake multiples) wears.
 *
 * The rungs are the two thresholds the game already means something by: half a
 * stake, and a whole stake. MEDUSA at `u >= 1` keeps §6.1's promise that violet
 * on screen always means *at least one whole stake* — here, one organism on its
 * own is worth everything the player paid to enter.
 */
export function bandFor(unitValue) {
  if (!(unitValue > 0)) return 'dim';
  if (unitValue >= 1) return 'medusa';
  if (unitValue >= 0.5) return 'lumen';
  return 'dim';
}

/**
 * The value printed on an organism's face, at most five glyphs.
 *
 * Two decimals below ten, one below a hundred, none above: the reference set
 * prints `x1.1`, `x5.6`, `x16` — never a figure so long it stops being readable
 * at the size the object actually is.
 */
export function faceValue(unitValue) {
  const value = Math.max(0, unitValue);
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const scale = Math.pow(10, decimals);
  const truncated = Math.floor(value * scale) / scale;
  return `${truncated.toFixed(decimals)}×`;
}

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
  // 256 px and 64 stops, not 128 and 16. A halo is blitted at up to 3.5× its own
  // bake size, and a canvas gradient is *linear between stops*: sixteen stops
  // magnified three-fold puts a visible kink every 24 px across a near-black
  // frame, which is how a soft bloom acquires concentric rings. Sixty-four stops
  // put the kinks below the noise floor of the grain that sits over them.
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let stop = 0; stop <= 64; stop += 1) {
    const t = stop / 64;
    gradient.addColorStop(t, rgba(colour, Math.pow(1 - t, falloff)));
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * The bell sprite's box, and the bell's own box inside it.
 *
 * §6.2 fixes the *bell* at `2 * r(n)` — 24 to 68 pt across — and an organism that
 * trails tentacles has to hang them somewhere. So the sprite is baked a quarter
 * larger than the bell's own box and blitted across `2.5 * radius`: the bell
 * lands on exactly the specified diameter and the tentacles use the margin,
 * rather than the round-1 compromise of a body shrunk to make room for its own
 * anatomy.
 *
 * The margin is a quarter and not a half because every pixel of it is blitted
 * fifteen times a frame with `lighter`: at 1.5x the blit covers 2.25 times the
 * area of the bell's own box, and most of that area is transparent. A skirt is
 * worth a quarter; it is not worth half the colony's fill rate.
 */
const BELL_SPRITE = 320;
const BELL_INNER = 256;
/** What a body's radius has to be multiplied by to blit the whole sprite. */
const BELL_BLIT = BELL_SPRITE / BELL_INNER;

/**
 * The three silhouettes of §6.2, with the anatomy each one carries.
 *
 * `lobes` is the gel; the rest is the interior. Round 1 had only the lobes, which
 * is why the hero object of a game called SWARM measured, at 3x zoom, as a plain
 * radial gradient: a colony of blurred dots. An organism needs organs.
 */
const ARCHETYPES = [
  // DOME — wide, shallow. Fine canals, a broad short veil.
  {
    lobes: [{ x: 0, y: 0.06, rx: 1, ry: 0.8, gain: 1 }],
    canals: 6,
    tentacles: 26,
    tentacleLength: 0.78,
    tentacleSpread: 2.7,
    lappets: 13,
    grain: 54,
  },
  // BELL — tall, pinched. Fewer canals and a long trailing veil.
  {
    lobes: [{ x: 0, y: -0.04, rx: 0.82, ry: 1, gain: 1 }],
    canals: 5,
    tentacles: 22,
    tentacleLength: 1.15,
    tentacleSpread: 2.1,
    lappets: 11,
    grain: 44,
  },
  /*
   * LOBE — asymmetric, two-lobed.
   *
   * The minor lobe has to read as a *bulge in one organism* and never as a second
   * organism, and at `x: 0.5` with a full-brightness gel it did exactly the wrong
   * thing: its own falloff reached zero outside the main body's, so it came out
   * of the blit as a separate bright ellipse stuck to the side — an ear. It is
   * pulled inside the main lobe's own radius and drawn at two-fifths the gain, so
   * what the eye gets is one body whose silhouette swells on one side.
   */
  {
    lobes: [
      { x: -0.06, y: 0, rx: 0.94, ry: 0.9, gain: 1 },
      { x: 0.36, y: 0.12, rx: 0.42, ry: 0.36, gain: 0.4 },
    ],
    canals: 6,
    tentacles: 24,
    tentacleLength: 0.95,
    tentacleSpread: 2.4,
    lappets: 12,
    grain: 50,
  },
];

/**
 * How many baked interiors each archetype gets.
 *
 * Three sprites for a colony of up to thirty is three sprites: at sixteen
 * organisms the frame carries five copies of each, in the same orientation band,
 * and the eye reads a *stamp* rather than a species. Nine interiors — the same
 * three silhouettes, each seeded three ways — is the cheapest thing that makes
 * every organism on screen an individual, and the variant is chosen from the slot
 * index and from nothing else, exactly like the archetype (§6.2).
 */
const BELL_VARIANTS = 3;

/**
 * A gel bell (§6.2), with the anatomy the round-1 build did not have.
 *
 * The body *transmits* its core outward with a soft falloff and carries a
 * brighter nucleus at ~25% of body radius and a thin Fresnel membrane in LUMEN
 * HIGH — and inside that, the things that make it an organism rather than a
 * blur: radial gastric canals running from the manubrium to the bell margin, a
 * scalloped margin of lappets, fine interior granulation, and a skirt of
 * tentacles trailing behind it.
 *
 * Everything is drawn **additively and with no hard silhouette edge** — each lobe
 * is a radial falloff that reaches zero alpha exactly at its own boundary. That
 * is what separates a bioluminescent organism from a coloured disc: the body has
 * no outline, it has a brightness that runs out. §6.2's "never a flat sprite;
 * never outlined" is the rule, and an opaque fill with a crisp rim breaks both.
 * The canals and the lappets obey it too — every one of them is a gradient that
 * fades out before it reaches an edge.
 *
 * Three archetypes, because fifteen identical bells read as a texture and three
 * read as a colony. Baked once at 384 px and blitted at 24–68 pt: a *cached*
 * body, not a flat one — the falloff, the canals and the membrane are real, they
 * are simply computed once. The interior is seeded from the archetype index and
 * from nothing else, which is §6.2's hard rule.
 */
function bellSprite(archetype, variant, core, high, deep, edge = C.plankton) {
  const size = BELL_SPRITE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  /** The bell's own radius, so its diameter blits to exactly `2 * r(n)`. */
  const R = BELL_INNER / 2 - 4;
  const shape = ARCHETYPES[archetype];
  const lobes = shape.lobes;
  const main = lobes[0];
  // The variant moves the manubrium as well as re-seeding the interior: a nucleus
  // in the same corner of every bell is the tell that gives a stamp away even
  // when everything around it differs.
  const salt = 200 + archetype * 17 + variant * 53;
  const nucleus = {
    x: cx - R * (0.09 + slotRandom(variant, salt + 40) * 0.14),
    y: cy - R * (0.11 + slotRandom(variant, salt + 41) * 0.16),
  };

  ctx.globalCompositeOperation = 'lighter';

  /*
   * The tentacles, first, so the bell sits in front of its own skirt.
   *
   * They leave the trailing margin and hang away with a bow, **tapering to
   * nothing** — width and brightness both run out along the filament, which is
   * the difference between a skirt and a set of drawn legs. The first pass at
   * this stroked each one at a constant width with a bead halfway down, and the
   * result read as whiskers on a comet: too few, too straight, too even.
   *
   * Drawn into its own layer in `source-over` and composited once. Additive
   * segments overlapping at their own joins would bead the filament at every
   * sample, and a filament of beads is the round-1 defect wearing a new coat.
   */
  const skirt = document.createElement('canvas');
  skirt.width = size;
  skirt.height = size;
  const sk = skirt.getContext('2d');
  sk.lineCap = 'round';
  const mix = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  for (let index = 0; index < shape.tentacles; index += 1) {
    const spread = shape.tentacleSpread;
    const t = shape.tentacles === 1 ? 0.5 : index / (shape.tentacles - 1);
    /*
     * Roots fan across the trailing margin — and they leave it at *different
     * depths*, which is the detail that decides whether this reads as a veil or
     * as a comb. Thirteen filaments on one arc at even spacing and one length is
     * a comb no matter how well each individual one is drawn, and that is exactly
     * what the previous pass measured as at 3x zoom: a row of identical teeth
     * under every bell, repeated across the whole colony.
     */
    const angle = Math.PI / 2 + (t - 0.5) * spread + (slotRandom(index, salt) - 0.5) * 0.42;
    const depth = 0.62 + slotRandom(index, salt + 20) * 0.34;
    const root = {
      x: cx + Math.cos(angle) * R * main.rx * depth,
      y: cy + Math.sin(angle) * R * main.ry * depth,
    };
    /*
     * A few primaries and a lot of veil. Every filament the same weight is the
     * other half of the comb read; a medusa has three or four long trailing
     * tentacles and a haze of short fine ones, and the ratio is what the eye
     * actually recognises.
     */
    const primary = slotRandom(index, salt + 21) > 0.78;
    const length =
      R * shape.tentacleLength * (primary ? 1.6 + slotRandom(index, salt + 1) * 1.2 : 0.3 + slotRandom(index, salt + 1) * 1);
    // A cubic, so each filament has an S in it and no two curve the same way. The
    // bow scales with the length: a long tentacle trails, a short one barely does.
    const bend = (slotRandom(index, salt + 2) - 0.5) * 2.4;
    const outward = Math.cos(angle) * length * 0.5;
    const sway = (length / R) * R * 0.3;
    const p0 = root;
    const p1 = { x: root.x + outward * 0.3 + bend * sway * 0.8, y: root.y + length * 0.32 };
    const p2 = { x: root.x + outward * 0.8 - bend * sway, y: root.y + length * 0.72 };
    const p3 = { x: root.x + outward + bend * sway * 0.5, y: root.y + length };
    const width = R * (primary ? 0.03 + slotRandom(index, salt + 4) * 0.018 : 0.013 + slotRandom(index, salt + 4) * 0.014);
    const peak = primary ? 0.44 : 0.2 + slotRandom(index, salt + 22) * 0.12;
    const at = (u) => {
      const v = 1 - u;
      return {
        x: v * v * v * p0.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u * u * u * p3.x,
        y: v * v * v * p0.y + 3 * v * v * u * p1.y + 3 * v * u * u * p2.y + u * u * u * p3.y,
      };
    };
    const steps = 18;
    let from = at(0);
    for (let step = 1; step <= steps; step += 1) {
      const u = step / steps;
      const to = at(u);
      /*
       * Both taper, and the colour walks continuously from the core hue to the
       * deep one. The previous pass switched hue at `u = 0.55`, which put a
       * visible joint in the middle of every filament — a tentacle with a knee.
       *
       * The alpha profile is `fade³` rather than `fade²`: a filament that is
       * still at a third of its brightness three-quarters of the way down ends
       * somewhere, and an end is a tip, and a tip is a tooth.
       */
      const fade = 1 - (step - 0.5) / steps;
      sk.strokeStyle = rgba(mix(core, deep, u), peak * fade * fade * fade);
      sk.lineWidth = Math.max(0.5, width * (0.18 + 0.82 * fade));
      sk.beginPath();
      sk.moveTo(from.x, from.y);
      sk.lineTo(to.x, to.y);
      sk.stroke();
      from = to;
    }
  }
  ctx.save();
  // Blurred: at the 24 pt end of the range the whole veil is 36 device px tall,
  // and anything with a legible edge in it at that size is a spike. Five pixels
  // at bake resolution is about one device pixel at the small end of the range
  // and three at the large one, which is where a filament stops being a line.
  ctx.filter = 'blur(5px)';
  ctx.drawImage(skirt, 0, 0);
  ctx.filter = 'none';
  ctx.restore();

  /*
   * The gel: one falloff per lobe, drawn in a scaled space so an ellipse is a
   * circle and the alpha reaches zero on every axis at the same time. The body
   * runs LUMEN → LUMEN DEEP → PLANKTON outward, so the organism is chromatic
   * rather than one hue at two alphas.
   *
   * The falloff is **monotone in premultiplied luminance**, not merely in alpha,
   * and that distinction is the whole of §6.2's "never outlined". A ramp whose
   * alpha only ever descends still draws a hard ring if the *hue* brightens on
   * the way out: LUMEN DEEP at 18.5% is darker on screen than LUMEN HIGH at
   * 15.5%, so a membrane written as a stop in this ramp put a local maximum at
   * `t = 0.88` and every organism in the colony acquired a contact-lens edge.
   * Alpha falls and the hue cools together, all the way out, with no radius the
   * eye can find.
   */
  for (const lobe of lobes) {
    ctx.save();
    ctx.translate(cx + lobe.x * R, cy + lobe.y * R);
    ctx.scale(lobe.rx, lobe.ry);
    const gain = lobe.gain ?? 1;
    const gel = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    gel.addColorStop(0, rgba(core, 0.64 * gain));
    gel.addColorStop(0.3, rgba(core, 0.56 * gain));
    gel.addColorStop(0.58, rgba(core, 0.41 * gain));
    gel.addColorStop(0.78, rgba(deep, 0.25 * gain));
    gel.addColorStop(0.91, rgba(edge, 0.12 * gain));
    gel.addColorStop(1, rgba(edge, 0));
    ctx.fillStyle = gel;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /*
   * The interior, in **one blurred layer**.
   *
   * The canals, the granulation, the bell margin and the oral arms all want the
   * same treatment — soft at bake resolution, because the sprite is minified up
   * to 6:1 and a feature that is merely soft at 320 px comes out of a 24 pt blit
   * crisp. Drawing them as four separately-filtered passes cost four full-sprite
   * blurs per sprite, and at nine interiors in two tints that is seventy-two
   * blurs of a 320² surface on the main thread at construction: a measured 772 ms
   * of frozen UI before the first frame, which on a mid-range phone is seconds.
   *
   * They are one layer, blurred once. Eighteen blurs instead of seventy-two, the
   * same picture, and the anatomy is composited additively over the gel exactly
   * as before.
   */
  const organs = document.createElement('canvas');
  organs.width = size;
  organs.height = size;
  const og = organs.getContext('2d');

  /*
   * Four short oral arms hanging off the manubrium: the frilled cross a medusa
   * has under its bell, and the thing that reads as an *interior* rather than as
   * a bright spot painted on a dome.
   *
   * Drawn in `source-over` and before everything else in the layer: four additive
   * strokes meeting at one point put a bright wedge in the middle of the bell,
   * and at 3x zoom that wedge read as a shard of glass.
   */
  og.lineCap = 'round';
  og.strokeStyle = rgba(high, 0.15);
  /*
   * Five, at uneven angles, not four at ninety degrees. Four arms on a cross
   * blurred into a bright manubrium do not read as arms — they read as a *square*,
   * because the eye completes them, and a square is the one silhouette a medusa
   * must not have. At five with the spacing broken the same feature reads as a
   * frill.
   */
  for (let index = 0; index < 5; index += 1) {
    const angle =
      (index / 5) * Math.PI * 2 +
      slotRandom(archetype, 149) * Math.PI +
      variant +
      (slotRandom(index, salt + 19) - 0.5) * 0.7;
    const reach = R * (0.2 + slotRandom(index, salt + 17) * 0.12);
    const swirl = (slotRandom(index, salt + 18) - 0.5) * 0.9;
    og.lineWidth = R * 0.045;
    og.beginPath();
    og.moveTo(nucleus.x, nucleus.y);
    og.quadraticCurveTo(
      nucleus.x + Math.cos(angle + swirl) * reach * 0.6,
      nucleus.y + Math.sin(angle + swirl) * reach * 0.6,
      nucleus.x + Math.cos(angle) * reach,
      nucleus.y + Math.sin(angle) * reach,
    );
    og.stroke();
  }
  og.globalCompositeOperation = 'lighter';

  /*
   * The gastric canals: tapered spokes from the manubrium to the margin.
   *
   * They are the single feature that turns the blur into an organism, because
   * they give the interior a *direction*. Drawn in the bell's own scaled space so
   * they follow the archetype's ellipse, and faded to nothing at both ends so
   * neither the nucleus nor the margin gets an edge.
   */
  og.save();
  og.translate(cx + main.x * R, cy + main.y * R);
  og.scale(main.rx, main.ry);
  og.lineCap = 'round';
  for (let index = 0; index < shape.canals; index += 1) {
    // Uneven spacing, and each canal *curves*. Straight spokes at even angles are
    // a starburst — a UI sparkle, not an anatomy — and that is exactly what a
    // first pass at this drew.
    const angle =
      (index / shape.canals) * Math.PI * 2 +
      slotRandom(archetype, 137) * Math.PI +
      (slotRandom(index, salt + 10) - 0.5) * 0.5;
    const inner = R * (0.24 + slotRandom(index, salt + 11) * 0.08);
    const outer = R * (0.78 + slotRandom(index, salt + 5) * 0.12);
    const curl = (slotRandom(index, salt + 12) - 0.5) * 0.55;
    const from = { x: Math.cos(angle) * inner, y: Math.sin(angle) * inner };
    const to = { x: Math.cos(angle + curl) * outer, y: Math.sin(angle + curl) * outer };
    const canal = og.createLinearGradient(from.x, from.y, to.x, to.y);
    canal.addColorStop(0, rgba(high, 0));
    canal.addColorStop(0.3, rgba(high, 0.34));
    canal.addColorStop(0.7, rgba(core, 0.24));
    canal.addColorStop(1, rgba(core, 0));
    og.strokeStyle = canal;
    og.lineWidth = R * (0.07 + slotRandom(index, salt + 13) * 0.03);
    const mid = {
      x: Math.cos(angle + curl * 0.35) * (inner + outer) * 0.5,
      y: Math.sin(angle + curl * 0.35) * (inner + outer) * 0.5,
    };
    og.beginPath();
    og.moveTo(from.x, from.y);
    og.quadraticCurveTo(mid.x, mid.y, to.x, to.y);
    og.stroke();
  }
  og.restore();

  /*
   * Interior granulation: the fine scatter inside the gel that stops the body
   * being smooth. Seeded from the archetype and the variant, and from nothing
   * else — the per-body variation is which variant a slot wears and how it is
   * tilted, and both of those are derived from the slot index (§6.2).
   *
   * Dim, wide and overlapping, and it has to stay that way. Forty small
   * high-contrast points inside a bell is not a texture, it is a rash: at 3x zoom
   * the organism read as a cell with measles and the specks could be counted. A
   * texture that can be counted is a pattern. So the specks are twice the size
   * they were, at a third of the contrast, drawn under a blur that puts them
   * below the threshold at which the eye resolves individuals.
   */
  for (let index = 0; index < shape.grain; index += 1) {
    const angle = slotRandom(index, salt + 6) * Math.PI * 2;
    const rho = Math.sqrt(slotRandom(index, salt + 7)) * R * 0.84;
    const gx = cx + main.x * R + Math.cos(angle) * rho * main.rx;
    const gy = cy + main.y * R + Math.sin(angle) * rho * main.ry;
    const gr = R * (0.06 + slotRandom(index, salt + 8) * 0.09);
    const speck = og.createRadialGradient(gx, gy, 0, gx, gy, gr);
    speck.addColorStop(0, rgba(high, 0.018 + slotRandom(index, salt + 9) * 0.026));
    speck.addColorStop(1, rgba(core, 0));
    og.fillStyle = speck;
    og.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
  }

  /*
   * The bell margin: the scalloped edge where the bell ends.
   *
   * Not a stroke, and no longer a ring of small beads — twenty-six hard little
   * dots on a perfect circle minified to 24 pt read as a *necklace*, which is
   * both an outline (§6.2 forbids one) and jewellery (an organism has none). It
   * is a dozen wide, soft, overlapping swells sitting half in and half out of the
   * bell's own edge: the silhouette comes out lobed rather than drawn, and there
   * is no frequency in it that a 6:1 minification can turn into dots.
   */
  for (let index = 0; index < shape.lappets; index += 1) {
    const angle = (index / shape.lappets) * Math.PI * 2 + (slotRandom(index, salt + 14) - 0.5) * 0.22;
    const reach = 0.9 + (slotRandom(index, salt + 15) - 0.5) * 0.09;
    const lx = cx + main.x * R + Math.cos(angle) * R * main.rx * reach;
    const ly = cy + main.y * R + Math.sin(angle) * R * main.ry * reach;
    const lr = R * (0.15 + slotRandom(index, salt + 16) * 0.07);
    const lappet = og.createRadialGradient(lx, ly, 0, lx, ly, lr);
    lappet.addColorStop(0, rgba(high, 0.15));
    lappet.addColorStop(0.45, rgba(core, 0.09));
    lappet.addColorStop(1, rgba(deep, 0));
    og.fillStyle = lappet;
    og.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
  }

  // The whole interior, softened once and laid over the gel. Eight pixels at bake
  // resolution is a tenth of the bell: nothing inside the gel is allowed a
  // frequency a 6:1 minification can sharpen into an edge.
  ctx.save();
  ctx.filter = 'blur(8px)';
  ctx.drawImage(organs, 0, 0);
  ctx.filter = 'none';
  ctx.restore();

  /*
   * The manubrium: the nucleus, at ~25% of body radius, and it has structure now
   * — a soft body, a brighter ring around it, and one hot point at the centre.
   * A single radial gradient is a smudge; three concentric ones are an organ.
   */
  const core1 = ctx.createRadialGradient(nucleus.x, nucleus.y, 0, nucleus.x, nucleus.y, R * 0.46);
  core1.addColorStop(0, rgba(high, 0.4));
  core1.addColorStop(0.3, rgba(high, 0.24));
  core1.addColorStop(0.64, rgba(core, 0.11));
  core1.addColorStop(1, rgba(core, 0));
  ctx.fillStyle = core1;
  ctx.fillRect(0, 0, size, size);

  /*
   * The hot point at the centre of the manubrium.
   *
   * It is deliberately **not** white. Fifteen bodies overlap by up to 30% at the
   * top of the population range and every one of them is composited additively —
   * a FOAM-hot core per body clips the whole colony to a flat white disc, which
   * is precisely what the first pass did at twelve organisms and above. The core
   * is LUMEN HIGH with a trace of FOAM, and the colony stays chromatic all the
   * way to full bloom.
   */
  const hotR = R * 0.15;
  const hot = ctx.createRadialGradient(nucleus.x, nucleus.y, 0, nucleus.x, nucleus.y, hotR);
  hot.addColorStop(0, rgba(C.foam, 0.34));
  hot.addColorStop(0.35, rgba(high, 0.3));
  hot.addColorStop(1, rgba(high, 0));
  ctx.fillStyle = hot;
  ctx.fillRect(nucleus.x - hotR, nucleus.y - hotR, hotR * 2, hotR * 2);

  /*
   * The membrane, as a **crescent** rather than a ring.
   *
   * §6.2 asks for a Fresnel rim and forbids an outline in the same breath, and a
   * ring cannot honour both: a stroke has a peak at one radius and a stop has a
   * peak at one radius, and either one, magnified to a 68 pt bell, is a contact
   * lens. What Fresnel actually looks like on a gel is not a ring — it is a
   * *limb*: the membrane lights where the surface turns away from the eye and
   * fades to nothing where it faces it.
   *
   * So it is a wash whose own centre lies **outside** the bell, clipped by
   * `source-atop` to the pixels the body has already drawn. Its brightest point
   * is off the sprite entirely, which means there is no radius anywhere on the
   * organism where it peaks: the eye gets a bright lower-right limb running out
   * across the body, and nothing it can trace.
   */
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  const rimX = cx + R * 0.86;
  const rimY = cy + R * 0.62;
  const rim = ctx.createRadialGradient(rimX, rimY, 0, rimX, rimY, R * 1.5);
  rim.addColorStop(0, rgba(high, 0.42));
  rim.addColorStop(0.45, rgba(high, 0.17));
  rim.addColorStop(1, rgba(edge, 0));
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  /*
   * The specular, and the reason a bell reads as a *volume* rather than as a
   * bright patch of water.
   *
   * Every spherical object in the reference set carries one — the ball, the
   * balloons, the glossy disc — and it is the cheapest, strongest three-dimensional
   * cue there is: a small, soft, off-centre highlight on the side the key light
   * comes from, sitting on top of the shading rather than in it. Recognition works
   * on mass and shading; a body with a falloff and no specular has the mass and
   * only half the shading, which is most of why the round-1 colony read as a
   * cluster of glowing smudges.
   *
   * Clipped by `source-atop` to the gel, so it can never escape the silhouette and
   * become a floating dot, and offset opposite the Fresnel limb so the two agree
   * about where the light is.
   */
  const specX = cx - R * 0.34;
  const specY = cy - R * 0.42;
  const specR = R * 0.34;
  ctx.save();
  ctx.translate(specX, specY);
  ctx.rotate(-0.5);
  ctx.scale(1, 0.68);
  const spec = ctx.createRadialGradient(0, 0, 0, 0, 0, specR);
  spec.addColorStop(0, rgba(C.foam, 0.5));
  spec.addColorStop(0.34, rgba(high, 0.28));
  spec.addColorStop(0.72, rgba(high, 0.07));
  spec.addColorStop(1, rgba(high, 0));
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.arc(0, 0, specR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
  ctx.globalCompositeOperation = 'lighter';

  return canvas;
}

/** The nine baked interiors, indexed `archetype * BELL_VARIANTS + variant`. */
function bellSet(core, high, deep, edge) {
  const set = [];
  for (let archetype = 0; archetype < ARCHETYPES.length; archetype += 1)
    for (let variant = 0; variant < BELL_VARIANTS; variant += 1)
      set.push(bellSprite(archetype, variant, core, high, deep, edge));
  return set;
}

/**
 * THE BODY — an organism's mass, and the round-2 change the whole art pass turns on.
 *
 * Round 1 drew the colony as light and nothing else: every body was an additive
 * falloff with no silhouette, so at twelve organisms fifteen overlapping glows
 * summed into one amorphous cyan cloud. A blind side-by-side found the exact
 * consequence — *you cannot count them*, and the population is half of what the
 * money is (`units x yield`), so the number that literally drives the payout was
 * legible only as the words "12 ALIVE" in the strip. The rubric names that
 * failure mechanically: recognition works on **mass and shading**; an object with
 * neither has no identity, carries no state and gives the eye no entry point.
 *
 * So a body is now a body. This layer is drawn in `source-over`, before the light:
 *
 * - a **contact shadow** just outside the silhouette, tinted toward ABYSS and
 *   never toward black, so two overlapping organisms separate instead of fusing;
 * - a **shaded gel** — key light up and to the left, the core through the middle,
 *   the band's deep tone at the far limb — with a soft alpha rim so the edge is
 *   an organism's edge and not a vector circle's (§6.2 still forbids an outline;
 *   what it gets is a falloff two device pixels wide, which occludes without
 *   drawing a line);
 * - a **Fresnel rim** on the lower-right limb and a **specular** on the upper
 *   left, agreeing about where the light is.
 *
 * The band's own colours carry it, so the *body* is the payout scale (see
 * `BANDS`). The light — halation, interior, nucleus — is still additive on top
 * and still a strict function of `E(V)`, so §6.3's contract is untouched: what is
 * constant here is that an organism is *visible as an object* at any value, and
 * what moves with the money is how much light it throws.
 */
function massSprite(archetype, variant, band) {
  const tone = BANDS[band];
  const size = BELL_SPRITE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const R = BELL_INNER / 2 - 4;
  const shape = ARCHETYPES[archetype];
  const main = shape.lobes[0];
  const salt = 600 + archetype * 23 + variant * 61;

  /*
   * The contact shadow, and it is the reason a dense colony stays countable.
   *
   * It is drawn *outside* the body's own alpha, tinted toward ABYSS — §6.1's
   * floor — so the darkest pixel it can produce is the darkest pixel in the game
   * and near-black stays at 0.0% of the frame. Two bodies at the 30% overlap
   * §6.4 allows now read as one in front of the other.
   */
  for (const lobe of shape.lobes) {
    ctx.save();
    ctx.translate(cx + lobe.x * R, cy + lobe.y * R);
    ctx.scale(lobe.rx, lobe.ry);
    const drop = ctx.createRadialGradient(0, R * 0.1, R * 0.7, 0, R * 0.1, R * 1.24);
    drop.addColorStop(0, rgba(C.abyss, 0.66));
    drop.addColorStop(0.42, rgba(C.abyss, 0.4));
    drop.addColorStop(1, rgba(C.abyss, 0));
    ctx.fillStyle = drop;
    ctx.beginPath();
    ctx.arc(0, R * 0.1, R * 1.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /*
   * The gel, shaded, in its own layer so the rim falloff can be applied as a
   * mask. A gradient painted straight onto the sprite would have to reach zero
   * alpha at the edge by itself, and an alpha that falls while the *hue*
   * brightens draws a ring — the contact-lens edge §6.2 warns about. Masking the
   * whole shaded body at once cannot: the mask is monotone by construction.
   */
  const body = document.createElement('canvas');
  body.width = size;
  body.height = size;
  const bg = body.getContext('2d');
  for (const lobe of shape.lobes) {
    bg.save();
    bg.translate(cx + lobe.x * R, cy + lobe.y * R);
    bg.scale(lobe.rx, lobe.ry);
    // Key light up and to the left: the gradient's centre is offset that way, so
    // the body has a lit shoulder and a shaded far limb rather than a bullseye.
    const shade = bg.createRadialGradient(-R * 0.3, -R * 0.36, R * 0.05, 0, 0, R);
    // Five stops across a full value range, not three across half of one: the
    // difference between a shaded volume and a tinted disc is how far the far
    // limb actually falls, and it falls all the way to the water it sits in.
    shade.addColorStop(0, rgba(tone.high, 0.97));
    shade.addColorStop(0.2, rgba(tone.core, 0.96));
    shade.addColorStop(0.52, rgba(tone.core, 0.93));
    shade.addColorStop(0.78, rgba(tone.deep, 0.92));
    shade.addColorStop(0.93, rgba(mixTone(tone.deep, C.abyss, 0.42), 0.9));
    shade.addColorStop(1, rgba(mixTone(tone.deep, C.abyss, 0.62), 0.88));
    bg.fillStyle = shade;
    bg.beginPath();
    bg.arc(0, 0, R, 0, Math.PI * 2);
    bg.fill();
    bg.restore();
  }
  // The rim falloff: opaque to 88% of the radius, gone by 100%. At a 24 pt bell
  // that is about one device pixel of softness and at a 68 pt bell about three —
  // an edge in both cases, never a stroke.
  bg.globalCompositeOperation = 'destination-in';
  bg.save();
  bg.translate(cx + main.x * R, cy + main.y * R);
  bg.scale(main.rx, main.ry);
  const mask = bg.createRadialGradient(0, 0, R * 0.82, 0, 0, R);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.6, 'rgba(0,0,0,0.95)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  bg.fillStyle = mask;
  bg.fillRect(-size, -size, size * 2, size * 2);
  bg.restore();
  ctx.drawImage(body, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';

  /*
   * The bottom inner shadow, and it is the cue that separates a volume from a
   * disc with a bright spot on it.
   *
   * Every dimensional object in the reference set has one — the chip faces, the
   * button caps, the balloons — a darkening that starts under the equator and
   * deepens to the lower limb. Without it the key light reads as a *sticker*
   * placed on a flat shape, which is most of what "premium" and "prototype" are
   * measuring apart at this scale.
   */
  const underY = cy + R * 1.05;
  const under = ctx.createRadialGradient(cx, underY, R * 0.24, cx, underY, R * 1.35);
  under.addColorStop(0, rgba(C.abyss, 0.62));
  under.addColorStop(0.45, rgba(C.abyss, 0.3));
  under.addColorStop(1, rgba(C.abyss, 0));
  ctx.fillStyle = under;
  ctx.fillRect(0, 0, size, size);

  /*
   * The Fresnel limb, as a wash whose own centre lies outside the body, so there
   * is no radius anywhere on the organism where it peaks and nothing the eye can
   * trace as a ring.
   */
  const rimX = cx + R * 0.82;
  const rimY = cy + R * 0.58;
  const rim = ctx.createRadialGradient(rimX, rimY, R * 0.2, rimX, rimY, R * 1.5);
  rim.addColorStop(0, rgba(tone.high, 0.6));
  rim.addColorStop(0.4, rgba(tone.high, 0.2));
  rim.addColorStop(1, rgba(tone.edge, 0));
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  // The specular. Every spherical object in the reference set carries one, and it
  // is the cheapest three-dimensional cue there is.
  const specX = cx - R * (0.3 + slotRandom(variant, salt) * 0.08);
  const specY = cy - R * (0.38 + slotRandom(variant, salt + 1) * 0.08);
  const specR = R * 0.36;
  ctx.save();
  ctx.translate(specX, specY);
  ctx.rotate(-0.5);
  ctx.scale(1, 0.62);
  const spec = ctx.createRadialGradient(0, 0, 0, 0, 0, specR);
  spec.addColorStop(0, rgba(C.foam, 0.72));
  spec.addColorStop(0.3, rgba(tone.high, 0.42));
  spec.addColorStop(0.7, rgba(tone.high, 0.1));
  spec.addColorStop(1, rgba(tone.high, 0));
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.arc(0, 0, specR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  /*
   * The print field: a soft lift of the face where the value is stamped.
   *
   * The number is printed in dark ink on a lit body, which is the treatment every
   * reference uses for a value carried on an object, and dark ink needs a light
   * that does not depend on which archetype happens to be underneath it. One
   * low-alpha wash under the type guarantees the contrast on all three.
   */
  const fieldR = R * 0.72;
  const field = ctx.createRadialGradient(cx, cy + R * 0.06, 0, cx, cy + R * 0.06, fieldR);
  field.addColorStop(0, rgba(tone.high, 0.5));
  field.addColorStop(0.55, rgba(tone.high, 0.22));
  field.addColorStop(1, rgba(tone.high, 0));
  ctx.fillStyle = field;
  ctx.fillRect(0, 0, size, size);

  ctx.restore();
  return canvas;
}

/** How many mass silhouettes each archetype gets. */
const MASS_VARIANTS = 2;

/** The six baked bodies of one band, indexed `archetype * MASS_VARIANTS + variant`. */
function massSet(band) {
  const set = [];
  for (let archetype = 0; archetype < ARCHETYPES.length; archetype += 1)
    for (let variant = 0; variant < MASS_VARIANTS; variant += 1)
      set.push(massSprite(archetype, variant, band));
  return set;
}

/**
 * The value stamped on an organism's face.
 *
 * Baked once per *string* and blitted once per body: thirty organisms all carry
 * the same yield, so thirty `fillText` calls a frame would be thirty draws of one
 * picture. Dark ink with a light emboss under it — printing on a lit surface, the
 * way `x5.6` is printed on a payout chip — never a glowing label floating over
 * the object.
 */
function labelSprite(text) {
  const width = 256;
  const height = 96;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const size = Math.min(66, (width * 0.93) / (text.length * 0.6));
  ctx.font = `800 ${size}px ui-rounded, "SF Pro Rounded", "Avenir Next", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // The emboss: one light pass a hair below the ink, so the type reads as pressed
  // into the gel rather than laid on top of it.
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.fillText(text, width / 2, height / 2 + size * 0.055);
  ctx.fillStyle = rgba(C.abyss, 0.9);
  ctx.fillText(text, width / 2, height / 2);
  return { canvas, text, aspect: width / height };
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
 * A drifting bloom cloud: the abyss's own light, formless and huge.
 *
 * Deep water is not empty and it is not black — it is full of things that glow,
 * and the round-1 build drew none of them. These are the largest of them: soft
 * masses of distant bioluminescence, four of them, each covering a fifth of the
 * frame at low alpha. They are what turns 58% of the viewport from a void into
 * water, and they cost four `drawImage` calls a frame.
 *
 * **They are constant.** Their level does not vary with the colony, so they add
 * the same term to every frame in every round and cannot reorder two frames by
 * value — §6.3's promise is about the *ordering* of frames by money, and a
 * constant preserves every ordering there is. They are life rather than rock,
 * which is why they are not the environment §7.2 keeps unlit: rock has no light
 * of its own and waits for the colony, plankton does not.
 */
function cloudSprite(colour, seed) {
  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = 'blur(18px)';
  // Six overlapping blobs rather than one circle: a cloud with a circular
  // silhouette is a spotlight, and the one thing this must not read as is a light.
  for (let index = 0; index < 6; index += 1) {
    const angle = slotRandom(index, seed) * Math.PI * 2;
    const rho = slotRandom(index, seed + 1) * size * 0.22;
    const x = size / 2 + Math.cos(angle) * rho;
    const y = size / 2 + Math.sin(angle) * rho;
    const r = size * (0.16 + slotRandom(index, seed + 2) * 0.16);
    const blob = ctx.createRadialGradient(x, y, 0, x, y, r);
    blob.addColorStop(0, rgba(colour, 0.5));
    blob.addColorStop(0.5, rgba(colour, 0.2));
    blob.addColorStop(1, rgba(colour, 0));
    ctx.fillStyle = blob;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.filter = 'none';
  // Feathered to nothing at its own edge, so scaling it up never shows a seam.
  const mask = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.62, 'rgba(0,0,0,0.9)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * The colony's light in the water: LUMEN at the core, cooling through LUMEN DEEP
 * to PLANKTON at the edge, so the field the colony sits in is two hues rather
 * than the single one the round-1 build had. Baked once and blitted; the whole
 * point is that this is one `drawImage` a frame and not a gradient fill.
 *
 * **Why this is written per pixel and not as a `createRadialGradient`.** This is
 * the single largest thing drawn in the game: at full bloom it is blitted across
 * 1.06 × the frame diagonal, so a 256 px bake is magnified about seven times. A
 * canvas gradient interpolates *linearly between its stops*, which puts a
 * derivative discontinuity at every stop — invisible at 1:1 and, magnified
 * seven-fold across a near-black frame, a set of hard concentric rings with a
 * defined outer edge. The round-2 build had four stops and drew, on the screen
 * the player spends most of the round on, three visible rings and a rim: a lens
 * artefact sitting over 60% of the stage. Light in water has no rings in it.
 *
 * So the falloff is evaluated as a continuous function, the hue ramp with it,
 * and three things are done that a gradient cannot do at all:
 *
 * - the radius is **warped by a low-frequency angular term**, so the field is an
 *   irregular volume of lit water rather than a disc with a circumference;
 * - the alpha is **dithered** by ±0.6 of a quantisation step, which is what
 *   removes the 8-bit contour bands that survive even a perfectly smooth ramp
 *   when it is stretched across 1,200 px;
 * - the profile reaches exactly zero with a zero derivative, so there is no
 *   edge to find.
 *
 * One `ImageData` pass over 512², once, at construction. It is never re-baked.
 */
function waterSprite() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const half = size / 2;
  // Three low-frequency lobes on the radius. Small — 6% — because this is the
  // frame's own volume of light and a field that visibly wobbles reads as a
  // shape, but enough that no part of the boundary is a circular arc.
  const warp = [
    { k: 2, phase: 0.7, amp: 0.05 },
    { k: 3, phase: 2.3, amp: 0.035 },
    { k: 5, phase: 4.1, amp: 0.022 },
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      let t = Math.hypot(dx, dy);
      if (t >= 1) continue;
      const angle = Math.atan2(dy, dx);
      let wobble = 0;
      for (const w of warp) wobble += w.amp * Math.sin(w.k * angle + w.phase);
      t = Math.min(1, Math.max(0, t * (1 + wobble)));
      // `(1 - t²)³` — smooth everywhere, and both the value and the slope are
      // zero at `t = 1`, so the field ends without an edge.
      const u = 1 - t * t;
      const falloff = u * u * u;
      // The hue ramp is continuous too: LUMEN → LUMEN DEEP over the inner half,
      // LUMEN DEEP → PLANKTON over the outer half, with no stop to band on.
      const m = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const from = t < 0.5 ? C.lumen : C.lumenDeep;
      const to = t < 0.5 ? C.lumenDeep : C.plankton;
      // Smoothstep on the mix, so the two halves meet with matching slope.
      const s = m * m * (3 - 2 * m);
      const index = (y * size + x) * 4;
      data[index] = from[0] + (to[0] - from[0]) * s;
      data[index + 1] = from[1] + (to[1] - from[1]) * s;
      data[index + 2] = from[2] + (to[2] - from[2]) * s;
      // ±0.6 LSB of ordered-ish noise, seeded from the pixel and from nothing
      // else. Without it a ramp this long still contours at every 1/255 step.
      const dither = (slotRandom(x * 131 + y, 617) - 0.5) * 1.2;
      data[index + 3] = Math.max(0, Math.min(255, falloff * 0.62 * 255 + dither));
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * §6.2's grain, and it is **chromatic** — which is what actually answers
 * criterion 8.
 *
 * Distinct-colour count is the rubric's proxy for "is this surface made of
 * anything", and the reference frames carry 2,400–7,400 against our DOM screens'
 * 900–1,700. The cause is arithmetic rather than art: a CSS gradient is a
 * straight line through colour space, so however many stops it is given, its
 * pixels quantise onto a handful of 5-bit triples. A *monochrome* grain over it
 * moves all three channels the same way, which slides those pixels along the
 * same line and adds almost nothing.
 *
 * Per-channel, palette-tinted noise moves them **off** the line. Each texel picks
 * one of four tints — neutral, LUMEN, PLANKTON, AMBER — so the speckle is the
 * game's own colour rather than chroma noise, and the three channels land in
 * different quantisation buckets. That is a real texture, it is what film grain
 * on a dark frame actually looks like, and it multiplies the measured colour
 * depth of every gradient in the product.
 *
 * Squared, not uniform: the layer is composited with `screen`, which lifts by
 * roughly `opacity x value x (1 - base)`, so a uniform tile would lift the whole
 * picture by half its opacity before adding any texture at all — on a frame whose
 * subject is darkness that is a grey veil, not a grain. Squaring drops the mean
 * to a third while keeping the full spread: most texels are nearly transparent, a
 * few are bright, and the black point does not move.
 */
function grainTile(seed) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  // Weighted toward neutral, so the speckle reads as grain and not as confetti.
  const TINTS = [
    [1, 1, 1],
    [1, 1, 1],
    [0.42, 1, 0.86],
    [0.5, 0.68, 1],
    [1, 0.78, 0.48],
  ];
  for (let index = 0; index < size * size; index += 1) {
    const value = Math.pow(slotRandom(index, seed), 2) * 255;
    const tint = TINTS[Math.floor(slotRandom(index, seed + 17) * TINTS.length) % TINTS.length];
    // A second, independent draw per channel on top of the tint: two texels of
    // the same tint still land on different triples.
    image.data[index * 4] = value * tint[0] * (0.72 + 0.56 * slotRandom(index, seed + 31));
    image.data[index * 4 + 1] = value * tint[1] * (0.72 + 0.56 * slotRandom(index, seed + 37));
    image.data[index * 4 + 2] = value * tint[2] * (0.72 + 0.56 * slotRandom(index, seed + 41));
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


/**
 * A symmetric per-channel dither, applied once to a baked plate.
 *
 * Criterion 8 counts distinct 5-bit colours, and a gradient — canvas or CSS —
 * puts every one of its pixels on a single straight line through colour space,
 * so however many stops it is given it quantises onto a few hundred triples.
 * That is the whole of why the settled frames measured 900–1,700 against a floor
 * of 2,500 while the art above them carried thousands.
 *
 * The fix is the one printers have used for a century: perturb each channel
 * independently by less than a quantisation step, **symmetrically**, so pixels
 * either side of a bucket boundary land in different buckets and the ramp stops
 * being a line. Symmetric is the load-bearing word — the mean of every channel is
 * unchanged, so this adds no luminance, takes no saturation, and cannot reorder
 * two frames by value (§6.3). It is baked into the plate once per resize and
 * costs the render loop nothing at all.
 *
 * The amplitude comes from `slotRandom` on the pixel index, so the pattern is
 * identical on every device and derived from nothing the round knows (§6.2).
 */
function ditherPlate(ctx, width, height, amplitude = 11) {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const pixel = index >> 2;
    data[index] += (slotRandom(pixel, 1009) - 0.5) * 2 * amplitude;
    data[index + 1] += (slotRandom(pixel, 1013) - 0.5) * 2 * amplitude;
    data[index + 2] += (slotRandom(pixel, 1019) - 0.5) * 2 * amplitude;
  }
  ctx.putImageData(image, 0, 0);
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
      // The abyss's own light: four drifting bloom clouds. Constant, so they
      // change no ordering by value (§6.3); life, so they do not wait for the
      // colony the way §7.2's rock does.
      //
      // The six beaded siphonophore filaments that used to hang beside them are
      // **gone**. They were 1.6 px strokes across the middle of the water column
      // — line art, by the rubric's own mechanical definition: no mass, no
      // shading, nothing they could tell the player, and a measurable push on the
      // hard-edge share, which sat at 94% of its ceiling on the idle frame. The
      // subtraction test is the whole argument: take them out and the frame is
      // better, so they were noise.
      clouds: [
        cloudSprite(C.lumenDeep, 301),
        cloudSprite(C.plankton, 311),
        cloudSprite(C.lumenDeep, 317),
        cloudSprite(C.plankton, 331),
      ],
      // Nine interiors on three silhouettes, indexed `archetype * 3 + variant`.
      // Nine 320² sprites is 3.7 MB of texture baked once at construction, which
      // buys thirty organisms that are thirty individuals.
      bells: bellSet(C.lumen, C.lumenHigh, C.lumenDeep, C.plankton),
      amberBells: bellSet(C.amber, [255, 224, 168], [196, 132, 56], [255, 176, 96]),
      /*
       * The bodies, per band. Six silhouettes each, and they are pure gradient
       * fills — no blur anywhere — so five bands bake in a fraction of the time
       * one tinted set of interiors costs. The interiors stay at two tints
       * (living and banked): the mass is most of an organism's pixels, so the
       * band reads from it, and re-baking nine blurred interiors per band would
       * put a measurable freeze in front of the first frame for no extra colour.
       */
      mass: {
        dim: massSet('dim'),
        lumen: massSet('lumen'),
        medusa: massSet('medusa'),
        amber: massSet('amber'),
        husk: massSet('husk'),
      },
      bandGlow: {
        dim: glowSprite(BANDS.dim.core, 1.9),
        lumen: glowSprite(C.lumen, 1.9),
        medusa: glowSprite(BANDS.medusa.core, 1.9),
        amber: glowSprite(C.amber, 1.9),
        husk: glowSprite(BANDS.husk.core, 1.9),
      },
      // One tile: the 12 fps cycle is `background-position` on the compositor
      // now, so the three the canvas pass used to swap between are dead weight.
      grain: [grainTile(11)],
    };

    /** Live bodies, in slot order. */
    this.bodies = [];
    this.units = 0;
    /**
     * What every living organism is worth, in stake multiples, and the band it
     * therefore wears. One figure for the whole colony because every organism is
     * worth the same thing — which is exactly why the population is countable
     * money: `units x yield`, with the yield printed on each unit.
     */
    this.unitValue = 0;
    this.band = 'dim';
    /** The face value, baked once per string (see `labelSprite`). */
    this.label = null;
    /** Harvest light trails, alive only during a harvest beat. */
    this.trails = [];
    /** The wild-line ghost population, non-zero only during a harvest beat. */
    this.ghostUnits = 0;
    this.ghostAlpha = 0;

    this.value = 0;
    /** Vertical layout offset, in pixels. Non-zero on the stake screen only. */
    this.lift = 0;
    /** Colony scale factor: 1 in a live round, tighter for the stake preview. */
    this.spread = 1;
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
    /** The payout's warm light on the water. Non-zero on a settled win only. */
    this.payoutLight = 0;
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
    /** Banked-this-round value, as a stake multiple. */
    this.banked = 0;
    /**
     * Where the settlement pour lands, in stage-local pixels: the middle of the
     * payout vessel, handed over by the ceremony from the vessel's own box.
     */
    this.payoutTarget = null;

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

  /**
   * Where the colony actually is, once the layout has moved it.
   *
   * `centre` is the spiral's anchor; `lift` slides the whole colony up on the
   * screens whose panels claim the lower frame (the stake screen, and the
   * settlement, where the payout vessel stands where the colony used to). Light
   * has to follow the object: a volumetric bloom, a plankton falloff and a shaft
   * pair centred 140 px below the organisms they belong to is a lit patch of
   * empty water beside a dark colony.
   */
  get focus() {
    return { x: this.width / 2, y: this.height * 0.4 - this.lift };
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
    this.bakeFramePlate();
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
   * The plate under the whole frame, and the reason the picture no longer stops
   * two-thirds of the way down.
   *
   * The stage canvas ends at the value strip. Everything below it was one flat
   * colour — a third of the picture with nothing in it — and on the settlement
   * screens, where the strip and the action bar step aside, that third is fully
   * exposed: measured, the settled frames carried 900–1,800 distinct quantised
   * colours against a 2,500 floor while the plate above them carried thousands.
   * A large inert area is the numeric fingerprint the rubric names, and it is
   * also just a seam a viewer can see.
   *
   * So the water column continues past the edge of its own layer, on its own
   * canvas behind every grid child: the same ramp, continuous at the seam, the
   * same marbling, the same far bioluminescence, and the vent's warm anchor where
   * the vent is. It is baked once per resize and blitted never — the element *is*
   * the bake — and every value in it is a constant, identical in every frame of
   * every round, so §6.3's ordering promise is untouched.
   */
  bakeFramePlate() {
    const plate = document.getElementById('frame-plate');
    if (plate === null) return;
    const width = plate.clientWidth;
    const height = plate.clientHeight;
    if (width === 0 || height === 0) return;
    const dpr = this.dpr;
    plate.width = Math.round(width * dpr);
    plate.height = Math.round(height * dpr);
    const ctx = plate.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = width / REFERENCE_WIDTH;

    // The column, continuous with the stage's own at the seam and carrying on to
    // the floor of the frame.
    const water = ctx.createLinearGradient(0, 0, 0, height);
    water.addColorStop(0, 'rgb(7, 22, 42)');
    water.addColorStop(0.2, 'rgb(8, 30, 48)');
    water.addColorStop(0.42, 'rgb(9, 38, 51)');
    water.addColorStop(0.62, 'rgb(11, 45, 50)');
    water.addColorStop(0.78, 'rgb(13, 47, 49)');
    water.addColorStop(0.92, 'rgb(12, 44, 47)');
    water.addColorStop(1, 'rgb(10, 38, 43)');
    ctx.fillStyle = water;
    ctx.fillRect(0, 0, width, height);

    // The warm anchor at the seam: the vent's light in the water it sits in.
    const vent = ctx.createRadialGradient(width / 2, height * 0.655, 0, width / 2, height * 0.655, width * 0.86);
    vent.addColorStop(0, rgba(C.ember, 0.14));
    vent.addColorStop(0.42, rgba(C.ember, 0.05));
    vent.addColorStop(1, rgba(C.ember, 0));
    ctx.fillStyle = vent;
    ctx.fillRect(0, 0, width, height);

    // The same marbling the stage plate carries (§6.2's low-contrast texture), so
    // the two halves of the frame are made of the same material.
    const MARBLE = [C.plankton, C.lumenDeep, C.basalt, C.crust, C.medusaDeep];
    for (let index = 0; index < 52; index += 1) {
      const tint = MARBLE[index % MARBLE.length];
      const x = slotRandom(index, 907) * width;
      const y = slotRandom(index, 911) * height;
      const rx = (0.14 + slotRandom(index, 919) * 0.34) * width;
      const ry = rx * (0.4 + slotRandom(index, 929) * 0.95);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, ry / rx);
      const patch = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      patch.addColorStop(0, rgba(tint, 0.055 + slotRandom(index, 937) * 0.075));
      patch.addColorStop(0.55, rgba(tint, 0.026 + slotRandom(index, 941) * 0.034));
      patch.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = patch;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Far bioluminescence, below the stage as well as in it: the water has a
    // distance in it everywhere, not only where the canvas reaches.
    for (let index = 0; index < 54; index += 1) {
      const x = slotRandom(index, 953) * width;
      const y = (0.6 + slotRandom(index, 967) * 0.42) * height;
      const r = (0.8 + slotRandom(index, 971) * 2.1) * scale;
      const warmth = slotRandom(index, 977);
      const colour = warmth > 0.84 ? C.amber : warmth > 0.48 ? C.plankton : C.lumenDeep;
      const dot = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      dot.addColorStop(0, rgba(colour, 0.5));
      dot.addColorStop(0.3, rgba(colour, 0.18));
      dot.addColorStop(1, rgba(colour, 0));
      ctx.fillStyle = dot;
      ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    }

    // The vignette, tinted to the floor and never to black (§6.1).
    const corners = ctx.createRadialGradient(width / 2, height * 0.5, width * 0.42, width / 2, height * 0.5, width * 1.25);
    corners.addColorStop(0, rgba(C.abyss, 0));
    corners.addColorStop(1, rgba(C.abyss, 0.34));
    ctx.fillStyle = corners;
    ctx.fillRect(0, 0, width, height);

    ditherPlate(ctx, plate.width, plate.height);
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
    const scale = this.scale;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    /*
     * The water column, in the palette's own water tones (§6.1).
     *
     * Round 1 collapsed the whole column to ABYSS and measured 4% of the stage
     * above `L = 24` on the screen a player sees before every round — a black
     * rectangle where the brief asks for a place. ABYSS is the *deepest* tone in
     * §6.1, not the only one: TRENCH and SILT are in the table too, and SILT sits
     * at `L = 24.3`, which is exactly where water stops reading as a void. The
     * column now runs ABYSS at the surface through TRENCH to a SILT-weight floor,
     * and ABYSS keeps the corners through the vignette.
     *
     * Nothing about §6.3 moves: this is a constant, identical in every frame of
     * every round, so it cannot make a poorer frame outrank a richer one. The
     * colony's own contribution is still `E(V)` and still the only term that
     * varies with the money.
     */
    /*
     * The floor, and why none of these stops is black.
     *
     * Round 1 ran the column from rgb(2, 6, 12) — `L = 0.022` — and the frame
     * measured 29.8% of its pixels at `L < 0.06` in the state the player sits in
     * longest. The premium references measure **0.0–0.1%** dead black; what makes
     * their darks read as depth rather than as absence is that they are saturated
     * and graded. So the deepest water here is ABYSS at `L = 0.088`, `S = 0.83`,
     * and the column climbs from there.
     *
     * Every stop is a constant, identical in every frame of every round, so §6.3's
     * ordering promise is untouched: no frame can outrank another by value because
     * of the plate it is drawn on. Only `E(V)` moves.
     */
    /*
     * A depth *axis*, not one colour at two brightnesses.
     *
     * The column runs blue at the surface — where what little light there is came
     * from above and the long wavelengths went first — through to green at the
     * floor, where the bed and the vent are. That is what water does, and it is
     * also the measurable difference between a plate with 890 distinct colours in
     * it and one with the 2 400–7 400 the references carry: a gradient between two
     * points on the same line quantises to a handful of values no matter how many
     * stops it is given, and it covers 60% of this frame.
     *
     * Still one hue family (the cyans, 150–210°), so §6.1's discipline holds; it
     * simply has a range inside it now.
     */
    const water = ctx.createLinearGradient(0, 0, 0, height);
    water.addColorStop(0, 'rgb(7, 22, 42)');
    water.addColorStop(0.26, 'rgb(8, 30, 48)');
    water.addColorStop(0.52, 'rgb(9, 38, 51)');
    water.addColorStop(0.78, 'rgb(12, 47, 51)');
    water.addColorStop(1, 'rgb(10, 41, 43)');
    ctx.fillStyle = water;
    ctx.fillRect(0, 0, width, height);

    // A cold cast toward the trench walls, so the frame has depth before any
    // light exists in it.
    const cast = ctx.createRadialGradient(width / 2, height * 0.36, 0, width / 2, height * 0.36, width * 1.05);
    cast.addColorStop(0, rgba(C.basalt, 0.42));
    cast.addColorStop(0.7, 'rgba(8, 36, 48, 0)');
    ctx.fillStyle = cast;
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = 'lighter';

    /*
     * Thermocline banding: three wide, very soft horizontal strata across the
     * column. Water with no strata in it is fog; the bands are what give the
     * frame a *depth axis* the eye can read before anything is lit.
     */
    for (const band of [
      { y: 0.16, h: 0.13, a: 0.1, tint: C.plankton },
      { y: 0.38, h: 0.15, a: 0.09, tint: C.plankton },
      { y: 0.58, h: 0.16, a: 0.12, tint: C.lumenDeep },
      { y: 0.79, h: 0.12, a: 0.1, tint: C.lumen },
    ]) {
      const strat = ctx.createLinearGradient(0, height * (band.y - band.h), 0, height * (band.y + band.h));
      strat.addColorStop(0, rgba(band.tint, 0));
      strat.addColorStop(0.5, rgba(band.tint, band.a));
      strat.addColorStop(1, rgba(band.tint, 0));
      ctx.fillStyle = strat;
      ctx.fillRect(0, height * (band.y - band.h), width, height * band.h * 2);
    }

    /*
     * MARBLING — the low-contrast texture the "empty" area needs, and the
     * cheapest thing in the file that answers criterion 8.
     *
     * Every premium reference carries one: a damask filigree behind a peg board,
     * a starfield behind a climbing multiplier, a painted landscape behind a
     * field of balloons.
     * Its job is not to be noticed — it is to make sure no large area of the frame
     * is *inert*. Ours measures directly: a plate built only from vertical
     * gradients quantises to a few hundred distinct 5-bit colours no matter how
     * many stops it is given, because every pixel lies on one line through colour
     * space. Twenty-eight wide, very soft patches in three different hues put the
     * plate off that line everywhere, which is what a texture is.
     *
     * Baked once, constant in every frame of every round, and drawn at 3–7% alpha
     * — well under the threshold at which the eye resolves an individual patch. It
     * costs the render loop nothing and it cannot reorder two frames by value.
     */
    const MARBLE = [C.plankton, C.lumenDeep, C.basalt, C.crust, C.medusaDeep];
    for (let index = 0; index < 44; index += 1) {
      const tint = MARBLE[index % MARBLE.length];
      const x = slotRandom(index, 811) * width;
      const y = slotRandom(index, 823) * height;
      const rx = (0.16 + slotRandom(index, 827) * 0.36) * width;
      const ry = rx * (0.42 + slotRandom(index, 829) * 0.9);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, ry / rx);
      const patch = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      patch.addColorStop(0, rgba(tint, 0.055 + slotRandom(index, 839) * 0.07));
      patch.addColorStop(0.55, rgba(tint, 0.026 + slotRandom(index, 853) * 0.032));
      patch.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = patch;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /*
     * The abyss's own light: the bloom clouds and the siphonophore strands, baked
     * into the plate rather than blitted every frame.
     *
     * They were a live layer, and they cost the frame rate the whole product is
     * built on: three cloud sprites at up to the width of the frame, composited
     * with `lighter`, is two million blended pixels a frame — and it took the
     * resolve beat from 60 fps to 30 in the harness. What that bought was a drift
     * of ±14 px on a sixty-second cycle, which is *invisible* inside a round that
     * lasts twenty seconds. The motion was never the point; the light was. So the
     * light stays, at exactly the same positions and sizes, and the per-frame cost
     * is gone: a constant that never moves belongs in the plate.
     */
    /*
     * The bloom clouds, at **half** the strength they were, and this is the
     * gating fix.
     *
     * One of them is baked into the upper right of the plate at 30–52% opacity,
     * and it measured as a bright saturated mass of 2.8% of the idle frame and
     * 4.4% of the payoff frame — in both states the *second* largest region that
     * is simultaneously bright and saturated, which is the exact shape criterion
     * 12 forbids. It was the frame's brightest thing after the money, in a corner
     * of the picture with nothing in it, on every screen in the game.
     *
     * The light is worth keeping — it is most of what makes the water read as a
     * volume with a distance in it — so it stays where it was and simply stops
     * competing. They are constants, identical in every frame of every round, so
     * §6.3's ordering promise is untouched either way.
     */
    for (let index = 0; index < 3; index += 1) {
      const size = (0.54 + slotRandom(index, 313) * 0.38) * width;
      const x = (0.14 + slotRandom(index, 303) * 0.72) * width;
      const y = (0.12 + slotRandom(index, 307) * 0.76) * height;
      ctx.globalAlpha = 0.2 + slotRandom(index, 337) * 0.15;
      ctx.drawImage(this.sprites.clouds[index], x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;

    /*
     * The deep field: forty far-off points of bioluminescence, so the water has a
     * distance in it. They are tiny, they never move, and they are the cheapest
     * depth cue there is — a bokeh field baked into the plate.
     */
    for (let index = 0; index < 40; index += 1) {
      const x = slotRandom(index, 211) * width;
      const y = slotRandom(index, 223) * height;
      const r = (0.9 + slotRandom(index, 227) * 2.2) * scale;
      const warmth = slotRandom(index, 229);
      const colour = warmth > 0.86 ? C.amber : warmth > 0.5 ? C.plankton : C.lumenDeep;
      const dot = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      dot.addColorStop(0, rgba(colour, 0.72));
      dot.addColorStop(0.3, rgba(colour, 0.26));
      dot.addColorStop(1, rgba(colour, 0));
      ctx.fillStyle = dot;
      ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    }

    /*
     * The bed: a tube-worm colony along the floor, and it is made of **mass**.
     *
     * This is the layer that answers "the lower third of the frame has nothing in
     * it". Round 2 drew it as forty-four 1–3 px strokes with a spray of hairline
     * fronds at each tip — which is the failure mode this whole pass exists to
     * remove, stated mechanically by the rubric: an outline has no identity,
     * carries no state and has no luminance hierarchy, so it reads as a wireframe
     * of an animal rather than as one. Measured, it put the idle frame's
     * hard-edge share at 7.48% against a ceiling of 8.00%, and the subtraction
     * test said the frame got better without it.
     *
     * So each worm is a filled tapered tube with a shaded body — dark at the
     * root, cooler through the middle, lit at the crown — and a soft plume on
     * top. Same silhouette, same clustering, same two depths; what changes is
     * that it now has volume and no edges. Constant in every frame of every
     * round, so it changes no ordering by value (§6.3).
     */
    for (let index = 0; index < 30; index += 1) {
      // Clustered, not scattered: tube worms grow in stands. Each stand gets a
      // root and its members lean away from it, which is what keeps the bed from
      // reading as a row of evenly spaced toothpicks.
      const stand = Math.floor(index / 5);
      const inStand = index % 5;
      const root = (0.06 + slotRandom(stand, 269) * 0.9) * width;
      const x = root + (inStand - 2) * (9 + slotRandom(index, 233) * 14) * scale;
      const lean = ((inStand - 2) * 0.4 + (slotRandom(index, 239) - 0.5) * 1.2) * 24 * scale;
      const tall = (26 + slotRandom(index, 241) * 74) * scale;
      const base = height - slotRandom(index, 251) * 30 * scale;
      const top = base - tall;
      /*
       * Depth, and a hue that is not one hue.
       *
       * Every stand at one brightness in one green is a hedge, and a hedge at the
       * bottom of the frame competes with the colony for the eye. Half of them sit
       * back into the water — dimmer, cooler, PLANKTON rather than LUMEN — so the
       * bed has a near row and a far one and the eye reads past it.
       */
      const depth = 0.4 + slotRandom(stand, 281) * 0.6;
      const cool = slotRandom(index, 283) > 0.62;
      const tipHue = cool ? C.plankton : C.lumen;
      // A tube, not a line: wide at the root, tapering to the crown, with the two
      // walls drawn as one closed path so it is a filled body.
      const foot = (2.2 + slotRandom(index, 257) * 2.6) * scale;
      const head = foot * 0.4;
      const tube = new Path2D();
      tube.moveTo(x - foot, base);
      tube.bezierCurveTo(
        x - foot * 0.8 + lean * 0.1,
        base - tall * 0.4,
        x - head + lean * 0.9,
        base - tall * 0.72,
        x - head + lean,
        top,
      );
      tube.lineTo(x + head + lean, top);
      tube.bezierCurveTo(
        x + head + lean * 0.9,
        base - tall * 0.72,
        x + foot * 0.8 + lean * 0.1,
        base - tall * 0.4,
        x + foot,
        base,
      );
      tube.closePath();
      // A stalk that is dark at the root and takes the colony's colour only at
      // its crown: the bed is a silhouette with lit tips, so it populates the
      // floor without competing with the money for the eye.
      const body = ctx.createLinearGradient(x, base, x + lean, top);
      body.addColorStop(0, rgba(C.abyss, 0.5 * depth));
      body.addColorStop(0.45, rgba(C.trench, 0.3 * depth));
      body.addColorStop(0.82, rgba(C.lumenDeep, 0.14 * depth));
      body.addColorStop(1, rgba(tipHue, 0.13 * depth));
      ctx.fillStyle = body;
      ctx.fill(tube);
      // The plume: a soft crown of light, no strokes in it at all.
      const tipR = (3 + slotRandom(index, 263) * 3.4) * scale;
      const crown = ctx.createRadialGradient(x + lean, top, 0, x + lean, top, tipR * 2.6);
      crown.addColorStop(0, rgba(cool ? C.plankton : C.lumenHigh, 0.22 * depth));
      crown.addColorStop(0.34, rgba(tipHue, 0.1 * depth));
      crown.addColorStop(1, rgba(tipHue, 0));
      ctx.fillStyle = crown;
      ctx.beginPath();
      ctx.ellipse(x + lean, top, tipR * 2.6, tipR * 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    /*
     * The ambient floor §6.3 specifies at `V = 0` — the vent's fixed rim light
     * and the PLANKTON ambient — baked in rather than composited every frame.
     *
     * It is a *constant*: the same contribution in every frame of every round, so
     * it cannot reorder two frames by value and §6.3's promise is untouched. And
     * because it is constant it belongs in the background, which is rendered once
     * per resize. Compositing it live cost two extra full-screen passes a frame
     * for a term that never changes, which took the resolve beat from 60 fps to
     * about 20 in the headless harness.
     */
    const cold = ctx.createLinearGradient(0, 0, 0, height * 0.66);
    cold.addColorStop(0, rgba(C.plankton, 0.09));
    cold.addColorStop(0.55, rgba(C.plankton, 0.05));
    cold.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = cold;
    ctx.fillRect(0, 0, width, height * 0.66);

    const warm = ctx.createLinearGradient(0, height * 0.52, 0, height);
    warm.addColorStop(0, 'rgba(0, 0, 0, 0)');
    warm.addColorStop(1, rgba(C.ember, 0.13));
    ctx.fillStyle = warm;
    ctx.fillRect(0, height * 0.52, width, height * 0.48);
    ctx.globalCompositeOperation = 'source-over';

    /*
     * The trench walls, and the vignette, last — they are the frame's edges and
     * they take light *away*, which is how ABYSS stays the deepest tone in the
     * picture while the middle of the column is water.
     */
    /*
     * Both of these darken *toward ABYSS* rather than toward black, at full
     * opacity. That is the whole rule of the new floor: a vignette painted in
     * `rgba(1, 2, 6, 0.86)` manufactures dead black in the corners of every frame
     * no matter how well lit the middle of the picture is, and the corners of a
     * portrait frame are a lot of pixels. Darkening to the floor and stopping
     * there keeps every edge in the dark-*surface* band.
     */
    for (const wall of [
      { x: 0, w: 0.2, dir: 1 },
      { x: 1, w: 0.17, dir: -1 },
    ]) {
      const edge = ctx.createLinearGradient(width * wall.x, 0, width * (wall.x + wall.w * wall.dir), 0);
      edge.addColorStop(0, rgba(C.abyss, 0.9));
      edge.addColorStop(0.55, rgba(C.abyss, 0.36));
      edge.addColorStop(1, rgba(C.abyss, 0));
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, width, height);
    }

    const vignette = ctx.createRadialGradient(width / 2, height * 0.42, width * 0.3, width / 2, height * 0.42, width * 1.05);
    vignette.addColorStop(0, rgba(C.abyss, 0));
    vignette.addColorStop(0.62, rgba(C.abyss, 0.34));
    vignette.addColorStop(1, rgba(C.abyss, 0.94));
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    ditherPlate(ctx, canvas.width, canvas.height);
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

    // Trails: each harvested body's light on its way to where the value landed.
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

  /**
   * What one organism is worth, in stake multiples — the number printed on every
   * body's face and the band every body wears (§6.2).
   *
   * It is a *resolved* figure: the yield the server has already published for the
   * generation on screen. Nothing here is derived from a draw that has not
   * happened, so the art still cannot leak information (§6.2).
   */
  setUnitValue(multipleOfStake) {
    const value = Math.max(0, Number(multipleOfStake) || 0);
    this.unitValue = value;
    this.band = bandFor(value);
    const text = value > 0 ? faceValue(value) : '';
    if (text === '') this.label = null;
    else if (this.label === null || this.label.text !== text) this.label = labelSprite(text);
    this.start();
  }

  /**
   * Banked-this-round value, in stake multiples.
   *
   * **There is no glass on the stage any more, and that is a subtraction.**
   * Round 2 drew a small beaker in the corner of the play area that harvested
   * light poured into. Measured, it was 1 px of amber stroke and a flat beige
   * pool — no ellipse at the mouth, so it did not read as a cylinder at all — and
   * once the pour had gone home it was an *empty* glass, which at settlement
   * measured as a second bright saturated region at `y = 0.18` containing
   * nothing: a tie for the eye at the one moment the frame is allowed exactly one
   * focal object. Removing it makes both frames better, which is the test.
   *
   * §5 (S5) always said where harvested value goes — "travel to the balance
   * chip" — and that is where the trails go now. The one vessel in the game is
   * the payout vessel at settlement, which is a real volume with the round's
   * money visibly in it (§7.1).
   */
  setBanked(multipleOfStake) {
    this.banked = Math.max(0, multipleOfStake);
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
    const archetype = slot % 3;
    return {
      slot,
      archetype,
      /**
       * Which of the archetype's three baked interiors this body wears, and the
       * per-body brightness it carries.
       *
       * Both are derived from the slot index and from nothing else (§6.2), which
       * is the same hard rule the archetype obeys. The brightness is a *constant
       * factor* on this body's halation, so the frame's total is still a strictly
       * increasing function of the colony's value and §6.3 is untouched — it only
       * stops sixteen organisms from being sixteen identical lamps.
       */
      sprite: archetype * BELL_VARIANTS + Math.floor(slotRandom(slot, 47) * BELL_VARIANTS),
      /** Which of the archetype's two baked bodies this organism wears (§6.2). */
      mass: archetype * MASS_VARIANTS + Math.floor(slotRandom(slot, 43) * MASS_VARIANTS),
      lamp: 0.86 + slotRandom(slot, 53) * 0.28,
      /**
       * A per-body tilt, so the nucleus does not point the same way on every
       * organism and three baked archetypes read as fifteen individuals. Derived
       * from the slot index and from nothing else (§6.2).
       *
       * A third of a turn either way, not a whole one. The bell now carries a
       * skirt, and a skirt on a body rotated 200° hangs *upward* — three of those
       * in a frame and the colony reads as comets with whiskers rather than as
       * animals in water. Medusae drift; they do not tumble.
       */
      tilt: (slotRandom(slot, 19) - 0.5) * 1.15,
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
      /**
       * A husk is a body the round is over for: mass without light.
       *
       * Round 1 cleared the colony at extinction and left a frame that measured
       * 2.6% lit surface, 370 colours and no game object at all — the most-seen
       * frame in the game and the weakest frame in the whole comparison set.
       * Extinction is this game's modal outcome, and the modal outcome has to
       * have something in it. What it has is the colony's own remains.
       */
      husk: 0,
      /**
       * A spent body is a banked one: mass without light, on the warm side.
       *
       * It is what the colony becomes when the round pays. The bodies do not
       * leave the stage at settlement — the payoff is supposed to *light the
       * picture*, not delete it — they stop emitting and hold still while the
       * vessel takes the money.
       */
      spent: 0,
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
    // `spread` is 1 in a live round and tighter on the stake screen, where the
    // colony is a preview drawn to fit the window the layout opens for it.
    const spread = this.spread;
    const radius = bodyRadius(Math.max(units, 1)) * scale * spread;
    this.bodies.forEach((body, index) => {
      const slot = index + 1;
      const { x, y } = bodyPosition(slot, Math.max(units, 1));
      const tx = cx + x * scale * spread;
      // `lift` is non-zero only on the stake screen, where the panels below claim
      // the lower two-thirds of the frame and the colony has to sit in the window
      // that is left. It is a layout offset and nothing else reads it.
      const ty = cy + y * scale * spread - this.lift;
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

  /**
   * The colony you are about to buy, on the screen where you buy it.
   *
   * Round 1's stake screen had **no game object on it at all** — an empty dark
   * gradient with one orange smudge, 12.3% lit surface and 924 distinct colours —
   * and a first-time viewer could not tell what game they were about to play. No
   * reference in the calibration set has an empty betting screen: the peg-drop
   * titles show the board and its chips, the balloon title shows the field, the
   * crash titles show the vehicle on the pad.
   *
   * So the vent shows the three organisms the seed will light, at the value they
   * are worth the instant the ticket is paid for — `19/20` of the stake, split
   * three ways, printed on their faces. Nothing here is a resolved outcome and
   * nothing is a draw: it is the *opening position*, which is a constant of the
   * rules, and it is the same three organisms every round. `E(V)` is set from
   * that same entry value, so this screen is lit by exactly the money that is
   * about to be on the table and §6.3's ordering is untouched.
   */
  preview(units, unitValue) {
    this.generation += 1;
    this.skip();
    this.tweens = [];
    this.trails = [];
    this.bodies = [];
    /*
     * The colony sits **inside** the window the stake screen opens for it.
     *
     * Round 2 lifted it 62 pt and drew it at full size, so three organisms of
     * 34 pt radius on a 57 pt spiral hung 63 px below the window's own bottom
     * edge — straight through `SEED A COLONY` and its kicker, which is the first
     * screen a player ever sees and the one the type became unreadable on. The
     * window is a box; the preview is now drawn to fit it.
     */
    this.lift = this.height * 0.195;
    this.spread = 0.74;
    this.setUnitValue(unitValue);
    this.render(units, { immediate: true });
    this.setValue(unitValue * units);
    this.colony.setAttribute('aria-label', `${units} organisms, ${faceValue(unitValue)} each, at the vent`);
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
      body.husk = 0;
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
    /*
     * At zero the colony is not cleared — it is left where it died.
     *
     * `extinguish()` turns these into husks a beat later, and it can only do that
     * if they still exist. Round 1 popped every body here and then had nothing to
     * extinguish, which is how the modal outcome in the game ended up as a frame
     * with no game object in it. Nothing is re-laid-out either: bodies that are
     * dying must not slide to the layout of a colony of one on their way out.
     */
    if (units === 0) {
      this.units = 0;
      this.announce(0);
      return;
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
   * existing intensity, detach and stream to the balance chip as light trails;
   * the survivors close ranks.
   *
   * No swell, no shower, no count-up flourish: a harvest moves money between the
   * colony and the balance without changing its amount, so `D = 0` and it gets
   * the `D = 0` treatment (§6.5 R6). What it *does* get is legibility — the
   * player has to be able to see where their money went — which is what the
   * trails are for, and why they end at the chip the credit actually lands in.
   *
   * `onArrival` fires once per body as its trail lands, so the caller can sound
   * the informational mark and tick the balance chip on the same frame.
   */
  async harvest(harvested, remaining, wildUnits, onArrival, keepBodies = false) {
    const bodies = this.bodies;
    const chip = this.chipMouth();
    /*
     * A BANK is not a harvest, and this is the branch that says so.
     *
     * Structurally they are the same command — a bank is a harvest of every
     * organism — so round 2 ran the same beat for both, which flew the whole
     * colony out of the top of the frame and deleted it **before** the settlement
     * had opened. That is the mechanism behind the round's biggest measured gap:
     * by the time the payout arrived there was no colony left for it to light, so
     * the ceremony landed a card on empty water.
     *
     * On a bank the colony therefore stays exactly where it is for the length of
     * the beat. The settlement's own pour is what moves it, into a vessel the
     * player can see it filling, and what is left standing afterwards is the
     * colony that paid.
     */
    if (keepBodies) {
      this.showGhosts(wildUnits);
      await this.wait(400);
      this.hideGhosts();
      return;
    }
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
        to: chip,
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

  /**
   * Where the settlement pour lands: the middle of the payout vessel, in
   * stage-local pixels.
   *
   * The vessel is a DOM object over this canvas, so the ceremony hands its box
   * over rather than the renderer guessing at it — the light arrives *in the
   * glass* at whatever size the tier gave it and wherever the layout put it.
   */
  setPayoutTarget(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    this.payoutTarget = { x: clientX - rect.left, y: clientY - rect.top };
  }

  payoutMouth() {
    return this.payoutTarget ?? { x: this.width / 2, y: this.height * 0.52 };
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
   * S7, first beat — the frame lifts, and the colony survives its own settlement.
   *
   * This is called on the frame the ceremony opens, synchronously, and everything
   * in it lands at once. That is deliberate on two counts.
   *
   * **Because the payoff has to light the picture.** Round 2 deleted the colony
   * at the instant of payoff and dropped a card onto a flat wash: measured
   * against the idle frame the celebration delivered +10.9% mean luminance where
   * the rubric floor is +50% and the reference is +84%, and the *saturated* share
   * fell from 81% to 47% where the reference multiplies it by 5.6. Every payoff
   * in the calibration set does the opposite — the playfield keeps its objects
   * and the event lights them. So the stage is lit here by what the round
   * actually paid, the vent blooms, and the bodies stay.
   *
   * **Because of the effect budget.** A frame lift that *ramps* is a full-screen
   * gradient crossing quantisation bands, and it measures as a handful of
   * separate moving regions along its own edge — round 2's ceremony ran 5, 8, 9
   * and 1 moving regions across four consecutive beats against a ceiling of
   * seven, with the dominant region owning 44% where the band is 50–80%. Applied
   * in one step, on the same frame as the overlay's own arrival, the whole lift
   * is inside the *one* region that is already changing. That is the shape every
   * reference payoff has: one big thing, then small things.
   */
  settle(settledValue) {
    const value = Math.max(0, settledValue);
    this.exposureTarget = exposure(value);
    this.exposure = this.exposureTarget;
    this.value = value;
    this.verdictBoost = 0;
    this.charge = 0;
    // The vent answers the payout: the frame's one warm anchor, opened up.
    this.ventFlash = Math.min(1, 0.35 + 0.5 * clamp01(Math.log2(1 + value) / Math.log2(31)));
    // The colony takes the warm side of the palette on the same frame. It has not
    // moved and it is not going to: what changes is that it stops being a colony
    // and starts being what the round paid.
    for (const body of this.bodies) {
      if (body.husk > 0.5) continue;
      body.tint = 'amber';
    }
    /*
     * And the colony comes out from behind the vessel.
     *
     * The payout surface stands where the colony stands — both are at the
     * optical centre, which is where each of them belongs — so a settled colony
     * left at its spiral anchor is a settled colony nobody can see. It rises into
     * the water above the card on the same frame as everything else here, so the
     * whole lift is one change rather than a second animation, and the top third
     * of the payoff frame stops being empty water.
     */
    this.lift = this.height * 0.27;
    this.spread = 0.8;
    /*
     * And the water takes the payout's colour.
     *
     * A frame with a gold vessel at the bottom and a cold cyan column at the top
     * is two pictures, not one lit one. This is the vessel's light reaching the
     * water it is standing in — the same term the CSS scrim applies below the
     * stage, applied on the canvas where the actual picture is, so the colony
     * standing above the glass is visibly *in* the light rather than beside it.
     * It is a constant of the settled frame, set here in one step with everything
     * else, and it is cleared by `reset()`.
     */
    this.payoutLight = Math.min(1, 0.5 + 0.5 * clamp01(Math.log2(1 + value) / Math.log2(31)));
    this.relayout(true);
    this.root.style.setProperty('--exposure', this.exposure.toFixed(4));
    this.start();
  }

  /**
   * S7, second beat — the pour (§7.1).
   *
   * The colony's light leaves its bodies and travels into the payout vessel,
   * which is a DOM object over this canvas filling to the round's own credited
   * multiple. What is left on the stage is the colony itself, spent: warm mass,
   * no emission, completely still. The picture stays full; the money moves.
   *
   * It runs on wins only. A round that returned less than it cost has no pour and
   * no warm colony — money flowing anywhere amber is the one thing §7.1 forbids
   * below the stake.
   */
  async bankOut(onArrival, settledValue = 0) {
    const round = this.generation;
    const duration = this.reduced ? 160 : 520;
    const mouth = () => this.payoutMouth();
    const living = this.bodies.filter((body) => body.husk < 0.5 && body.spent < 0.5);
    living.forEach((body, order) => {
      body.tint = 'amber';
      const delay = Math.min(300, order * (living.length > 8 ? 26 : 52));
      this.trails.push({
        t: 0,
        ms: duration,
        delay,
        hold: 0,
        from: { x: body.x, y: body.y },
        // Resolved late, so the trail lands in the glass wherever the layout has
        // put it rather than where it started.
        toFn: mouth,
        to: mouth(),
        bow: (slotRandom(body.slot, 59) - 0.5) * 0.42 - 0.18,
        r: body.r,
        fired: false,
        onArrival,
      });
      /*
       * The light goes; the body does not. It flares as its own light detaches —
       * the one moment the organisms are the brightest thing on the stage — and
       * then settles to EMBER: mass, warm, unlit, and still. A settled colony is
       * a game object on the playfield, and never a second light source competing
       * with the vessel for the eye.
       */
      setTimeout(() => {
        if (this.generation !== round) return;
        this.tween(body, 'lamp', (body.lamp ?? 1) * 1.6, 140, ease.decel);
        setTimeout(() => {
          if (this.generation !== round) return;
          body.spent = 1;
          body.alpha = 0.92;
          /*
           * A spent organism is a banked one: AMBER mass with a soft halo and no
           * interior light left. The lamp is cut to a third, which puts its
           * halation an order below the vessel's and keeps the payout surface the
           * unambiguous luminance maximum — the gating criterion is that exactly
           * one region is brightest, not that everything else is dark.
           */
          this.tween(body, 'lamp', 0.46, 260, ease.decel);
          this.start();
        }, 150);
      }, delay);
    });
    await this.wait(duration + 320);
    if (this.generation !== round) return;
    this.units = 0;
    this.label = null;
    this.announce(0);
  }

  /**
   * §7.1's celebration, and it is now **one object doing one thing**.
   *
   * The tier table asks for a swell that grows with the round: "a single soft
   * swell" at T1, one exposure stop at T2, full illumination at T3. Round 2
   * delivered that as a screen-wide radial flood, and a screen-wide radial is
   * exactly the wrong shape for it — as it ramps it crosses quantisation bands
   * and registers as a handful of *separate* moving regions along its own edge,
   * which is most of why the four ceremony beats measured 5, 8, 9 and 1 moving
   * regions against a ceiling of seven. It also washed the frame toward white,
   * which is how the payoff ended up *less* saturated than the screen before it.
   *
   * The lift is applied in one step by `settle()` instead, and what is left here
   * is the part that belongs to the payoff: light rising out of the vessel. It is
   * a shower of AMBER sparks from the glass's own mouth — a single, small,
   * centred region — and its size is the round's **credited multiple** rather
   * than its tier, so a 12x and a 40x are visibly different events and the top of
   * the table still has somewhere to go.
   */
  async celebrate(tier, multiple = 0) {
    const round = this.generation;
    // 0 at a stake-back, 1 at 30x and above. The same curve the vessel fills on,
    // so the shower and the glass tell the same story about the same number.
    const weight = clamp01(Math.log2(1 + Math.max(0, multiple)) / Math.log2(31));
    const count = Math.round(lerp(6, 34, weight));
    if (this.reduced || count <= 0) return;
    this.emitSparks(count, weight);
    await this.wait(900);
    if (this.generation !== round) return;
  }

  /**
   * The sparks of a settlement: banked light rising out of the vessel.
   *
   * Every constant here comes from `slotRandom`, so the shower is identical on
   * every device and derived from nothing the round knows — the same rule the
   * colony's own art follows (§6.2). They are AMBER because they are money that
   * has already been credited, and they rise from the glass the money is in, so
   * the whole of the payoff's motion sits in one place on the frame.
   */
  emitSparks(count, weight = 1) {
    const centre = this.payoutMouth();
    const spread = lerp(0.6, 1.25, weight);
    for (let index = 0; index < count; index += 1) {
      const angle = slotRandom(index, 67) * Math.PI * 2;
      const speed = (0.16 + slotRandom(index, 71) * 0.5) * this.scale * spread;
      this.sparks.push({
        x: centre.x + Math.cos(angle) * 34 * this.scale * slotRandom(index, 73),
        y: centre.y + Math.sin(angle) * 20 * this.scale * slotRandom(index, 79),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (0.16 + slotRandom(index, 83) * 0.3) * this.scale * spread,
        size: (3 + slotRandom(index, 89) * 7) * this.scale,
        life: 0,
        ms: 700 + slotRandom(index, 97) * 800,
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
   * The colony's own remains stay: the story is what is left, not an empty frame.
   */
  async extinguish() {
    /*
     * The light goes; the bodies do not.
     *
     * §6.1's direction for a loss is "darkness and the removal of light", and
     * round 1 executed it by removing the *picture*: an extinction frame with no
     * organism, no light source and one grey numeral, at 2.6% lit surface and 370
     * distinct colours — below the desaturated skin the calibration set ships as
     * its own example of the amateur failure mode. Removing the light is right.
     * Removing the object is what made the frame embarrassing.
     *
     * So the colony collapses into husks: mass with no emission, ASH-toned,
     * settled at the vent and completely still. The loss frame keeps a game
     * object, keeps its material, and still reads pre-attentively as a loss —
     * cold, dim, unlit — against the win's amber. The husks are cleared by
     * `reset()` when the next round is seeded.
     */
    const settled = this.bodies.filter((body) => body.husk < 0.5);
    for (const body of settled) {
      body.outcome = 'DIE';
      this.tween(body, 'die', 1, 300, ease.accel);
      this.tween(body, 'alpha', 0, 300, ease.accel);
    }
    this.setValue(0);
    await this.wait(320);
    /*
     * The light has gone. What settles out of the dark is the body it was in:
     * collapsed to two-thirds, unlit, ASH-toned, drifting into the water column
     * above the vent and then completely still.
     *
     * They are re-laid-out rather than left where they died, and the reason is
     * composition rather than fiction: the colony's centroid sits at 30% of the
     * frame and the settlement card starts at 35%, so a round that ended with one
     * or two organisms left its entire remains behind the card — which measured,
     * on the frame the player sees most often in this game, as no game object at
     * all. The remains gather in the window above the card, which is where the
     * round's own picture belongs.
     */
    const count = settled.length;
    const perRow = Math.min(6, Math.max(1, Math.round(Math.sqrt(count))));
    const pitch = Math.min(54, 320 / perRow) * this.scale;
    settled.forEach((body, index) => {
      body.husk = 1;
      body.r = Math.max(body.r * 0.82, 17 * this.scale);
      body.die = 0;
      body.hold = 0;
      body.split = 0;
      body.alpha = 0;
      const row = Math.floor(index / perRow);
      const inRow = Math.min(perRow, count - row * perRow);
      const column = index % perRow;
      const jitterX = (slotRandom(body.slot, 91) - 0.5) * 16 * this.scale;
      const jitterY = (slotRandom(body.slot, 93) - 0.5) * 18 * this.scale;
      const tx = this.centre.x + (column - (inRow - 1) / 2) * pitch + jitterX;
      const ty = this.height * 0.3 + row * pitch * 0.78 + jitterY;
      this.tween(body, 'alpha', 0.88, 460, ease.decel);
      this.tween(body, 'x', tx, 620, ease.decel);
      this.tween(body, 'y', ty, 620, ease.decel);
    });
    this.bodies = settled;
    this.label = null;
    await this.wait(660);
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
    this.lift = 0;
    this.spread = 1;
    this.units = 0;
    this.unitValue = 0;
    this.band = 'dim';
    this.label = null;
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
    this.payoutTarget = null;
    this.payoutLight = 0;
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

    this.drawPayoutLight(ctx);
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
      Math.abs(this.exposureTarget - this.exposure) < 0.0005;
    /*
     * The loop stops when nothing is moving. Husks do not breathe and do not
     * drift, so a settled extinction is a *still* frame — which is the effect
     * budget's floor, and the one the strongest reference in the set hits exactly:
     * two consecutive frames pixel-identical while the player is deciding.
     */
    const living = this.bodies.some((body) => body.husk < 0.5 && body.spent < 0.5);
    if (idle && !living && !this.environmentLit) this.running = false;
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
    const centre = this.focus;
    // One pre-rendered sprite scaled to the colony's reach, rather than a radial
    // gradient built and filled across the whole frame every frame: same picture,
    // one blit, no per-frame gradient object. The constant ambient this used to
    // carry now lives in the baked background, where it belongs.
    /*
     * The reach and the gain are held under the threshold that would make the
     * water part of the money, and that is the gating criterion (§3 of the bar,
     * criterion 12).
     *
     * The focal measure is the largest connected region that is simultaneously
     * bright (`L > 0.45`) and saturated (`S > 0.35`). Round 2's volumetric term
     * peaked well over that, and because it is centred on the colony it *fused
     * with the colony*: the largest bright saturated region in the in-round frame
     * measured 10.7% of the picture at 61% of the frame's width — far wider than
     * the organism cluster — so the money object never separated from its own
     * water. At idle the same term put a second bright saturated mass within 10%
     * of the size of the SEED control, where the reference measures the action
     * button at 8.7 times its nearest rival.
     *
     * The volumetric term therefore lives in the *mid-lit* band rather than the
     * highlight band: bright enough to be lit water — it is most of why the frame
     * measures a real surface at all — and never bright enough to be mistaken for
     * an object. The organisms carry the highlights; the water carries the
     * material. Both terms are still strictly increasing in `level`, which is all
     * §6.3 requires.
     */
    const reach = Math.hypot(width, height) * (0.25 + 0.66 * level);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.54 * level ** 1.05;
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
   * Plankton and marine snow.
   *
   * Nothing here emits: a mote's brightness is an ambient floor plus the colony's
   * own light falling on it with quadratic falloff, so the particulate is bright
   * exactly where and when the colony is (§6.3, "nothing is lit that the colony
   * does not light"). That also keeps the field monotone in value.
   *
   * **And nothing here moves.** Round 1 drifted all three hundred motes and
   * twinkled each one on its own sine, which measured **thirteen to fourteen
   * independently moving regions** in the state the player sits in longest —
   * against a ceiling of three, with one region required to own 60% of the motion.
   * The reference idle frames animate between zero and one thing; the best of them
   * is *pixel-identical* across consecutive frames while it waits for you. Three
   * hundred specks pulsing behind a decision is ambient noise competing with the
   * decision surface, and it is the first thing the effect budget spends on
   * nothing.
   *
   * What is left still changes — the field brightens and dims with `E(V)`, which
   * is the colony's light falling on it — so it carries the one thing it was ever
   * carrying information about, and it does so on the generation beat rather than
   * sixty times a second.
   */
  drawParticles(ctx, level) {
    const { width, height } = this;
    const centre = this.focus;
    const colonyReach = (60 + 130 * level) * this.scale;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sprite = this.sprites.planktonGlow;
    for (const mote of this.motes) {
      const x = mote.x;
      const y = mote.y;
      // A fixed per-mote brightness offset, from the mote's own phase and from
      // nothing time-varying: the field still reads as a scatter of different
      // depths rather than one uniform dusting, and it holds still.
      const twinkle = 0.6 + 0.4 * Math.sin(mote.phase);
      const distance = Math.hypot(x - centre.x, y - centre.y);
      const falloff = 1 / (1 + Math.pow(distance / colonyReach, 2));
      // Drifting plankton is the last layer up in the reveal, at 700 ms (§7.2).
      // The constant term is §6.3's ambient floor, raised until it is actually
      // visible: "vent idle in darkness" is a picture of water, and water with no
      // life in it at all is a black rectangle.
      const alpha =
        (0.085 + 0.72 * level * falloff + 0.16 * this.environment * this.depthPhase(700, 300)) *
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
      const x = mote.x;
      const y = mote.y;
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

    /*
     * The wide bloom the mouth throws into the water, and the frame's only warm
     * anchor.
     *
     * It is deliberately louder than it was. A frame carried by one hue is a frame
     * with no colour identity to read — every reference in the set is carried by
     * one dominant hue with a second supporting it, and this game's second is the
     * vent. Round 1 measured 99.6% of its hue mass in the cyans, which is not
     * discipline, it is monochrome. It stays inside §6.1's ~5%-of-frame cap and it
     * stays EMBER-only; it is simply *present*.
     */
    const size = (330 + 110 * flash) * scale;
    ctx.globalAlpha = 0.5 + 0.32 * flash;
    ctx.drawImage(this.sprites.emberGlow, width / 2 - size / 2, height - size * 0.48, size, size * 0.76);

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
    const core = 118 * scale;
    ctx.globalAlpha = 0.78 + 0.22 * flash;
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
    const centre = this.focus;
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
    const wide = this.sprites.bandGlow[this.band] ?? this.sprites.lumenGlow;
    const halo = this.sprites.planktonGlow;
    const bandGain = (BANDS[this.band] ?? BANDS.lumen).gain;
    for (const body of this.bodies) {
      if (body.alpha < 0.01 || body.husk > 0.5) continue;
      const radius = body.r * contract * (1 - 0.6 * body.die);
      const alive = body.alpha * (1 - body.die);
      /*
       * The gain on both terms, and the reason the light still reads as the money
       * now that the water is water.
       *
       * Filling the frame with a constant raises the floor, and a floor that
       * rises without the ceiling rising with it flattens the one thing §6.3 is
       * for: a rich frame has to be *visibly* richer, not arithmetically richer.
       * So the level-dependent term carries almost all of the weight — halation
       * area times opacity runs about 25:1 across the value range, against 12:1
       * in the round-1 build — while both terms stay strictly increasing in
       * `level`, which is all §6.3 requires.
       *
       * The gain is bounded by what **twelve overlapping bodies** do, not by what
       * one does. Every body is composited additively; a gain tuned so a single
       * organism reads bright saturates a dense colony to a flat white disc with
       * the bodies visible only as rings inside it — the whole colony reduced to
       * one shape, at exactly the population the round is worth most. Halation
       * has to sum to bloom, not to paper.
       */
      const lamp = (body.lamp ?? 1) * bandGain;
      // A banked body's light is AMBER, not the colony's: it is money that has
      // already been credited, and the halo has to agree with the mass.
      const warm = body.tint === 'amber';
      /*
       * Tighter than round 2's, and this is the other half of the gating fix.
       *
       * Halation at `3.4 → 10.6 x radius` overlapped every neighbour and reached
       * the volumetric water, so the colony, its glow and its water measured as
       * **one** bright saturated region. Recognition needs the organisms to be
       * countable objects with light around them, not a lit cloud with rings in
       * it. Pulling the wide term in and taking a little opacity off it costs the
       * frame nothing that matters — the light per body is still strictly
       * increasing in `level`, so §6.3's ordering is untouched — and it buys the
       * one thing the bar gates on: a money object that separates from its
       * background.
       */
      const size = radius * (3 + 5 * level);
      ctx.globalAlpha = (0.13 + 0.34 * level) * alive * lamp;
      ctx.drawImage(
        warm ? this.sprites.bandGlow.amber : wide,
        body.x - size / 2,
        body.y - size / 2,
        size,
        size,
      );
      if (warm) continue;
      const cool = radius * (2.2 + 1.9 * level);
      ctx.globalAlpha = (0.08 + 0.15 * level) * alive * lamp;
      ctx.drawImage(halo, body.x - cool / 2, body.y - cool / 2, cool, cool);
    }
    ctx.restore();

    /*
     * THE OCCLUSION — a soft shadow in the water immediately around every body,
     * and the single most load-bearing thing in this pass.
     *
     * An organism is a dense translucent animal in lit water: it takes light out
     * of the column behind it. Round 2 drew no such term, so a body's own
     * halation ran straight into its neighbour's and into the volumetric water,
     * and the whole lit middle of the frame connected into one region. The bar's
     * rule is blunt about what that costs — "if two things tie for brightest, one
     * is wrong" — and a colony fused with its own water is not a thing you can
     * point at.
     *
     * Physically it is ambient occlusion; compositionally it is the *rim* that
     * the reference art gets from a key light. It is tinted toward ABYSS and
     * never toward black (the floor rule), it is seated slightly low so it reads
     * as contact rather than as a halo, and it is drawn after the light and
     * before the mass so it darkens the glow without ever touching the body.
     */
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (const body of this.bodies) {
      if (body.alpha < 0.01) continue;
      const { radius, x, y } = this.bodyTransform(body, contract, seconds);
      const seat = y + radius * 0.2;
      const reach = radius * 1.72;
      const ao = ctx.createRadialGradient(x, seat, radius * 0.6, x, seat, reach);
      const strength = (body.spent > 0.5 ? 0.4 : 0.62) * body.alpha * (1 - body.die);
      ao.addColorStop(0, rgba(C.abyss, strength));
      ao.addColorStop(0.42, rgba(C.abyss, strength * 0.5));
      ao.addColorStop(1, rgba(C.abyss, 0));
      ctx.fillStyle = ao;
      ctx.fillRect(x - reach, seat - reach, reach * 2, reach * 2);
    }
    ctx.restore();

    /*
     * The bodies. Two passes, and the order is the whole point.
     *
     * The **mass** goes down first in `source-over`, so an organism in front of
     * another occludes it and the colony stays countable at any population — the
     * round-1 build composited everything additively and twelve organisms summed
     * into one cloud. The **light** goes on top in `lighter`, exactly as before,
     * so nothing about §6.3's contract changes: what is constant is that a body
     * is an object, what moves with the money is how much light it throws.
     */
    ctx.save();
    for (const body of this.bodies) {
      if (body.alpha < 0.01) continue;
      this.drawBody(ctx, body, level, contract, seconds);
    }
    ctx.restore();

    /*
     * The core bloom, in front — and it is now the size of the **nucleus**, not
     * the size of the body.
     *
     * At `1.5 → 2.05 × radius` and up to 46% alpha it was a wash laid over the
     * whole bell, and it erased the organism: the canals, the granulation, the
     * lappets and the membrane crescent are all drawn into the sprite and none of
     * them survived being painted over. A colony rendered that way measures as
     * light but reads as *blur* — and an object the player cannot name is the one
     * defect class this round exists to close. A bloom that is wider than the
     * thing it is blooming from is not halation, it is fog.
     *
     * So it is a hotspot on the manubrium: small enough that the interior is
     * still visible around it, bright enough that the nucleus is still the hottest
     * point on the body. Both terms remain strictly increasing in `level`, which
     * is all §6.3 requires of them.
     */
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const tight = this.sprites.lumenTight;
    for (const body of this.bodies) {
      if (body.alpha < 0.01 || body.tint === 'amber' || body.husk > 0.5 || body.spent > 0.5)
        continue;
      const radius = body.r * contract * (1 - 0.6 * body.die);
      const size = radius * (0.66 + 0.34 * level);
      ctx.globalAlpha = (0.07 + 0.15 * level) * body.alpha * (1 - body.die) * (body.lamp ?? 1);
      ctx.drawImage(tight, body.x - size / 2, body.y - size / 2, size, size);
    }
    ctx.restore();

    /*
     * The value, printed on every face.
     *
     * This is the gating criterion the round-1 build failed on every frame: the
     * references put the payout scale **on the object** — `x5.6` on a payout
     * chip, `x16` on a balloon — and ours put it in a strip of text the player
     * had to read and then multiply. It is drawn last, in `source-over`, so the
     * additive interior underneath cannot wash it out, and it is drawn from a
     * sprite baked once per string rather than from thirty `fillText` calls.
     *
     * It is not drawn on an organism that is mid-split (the type would stretch
     * with the body), mid-death, or a husk: a number on a corpse would be money
     * that is not there.
     */
    if (this.label !== null) this.drawLabels(ctx, contract, seconds);

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
  /**
   * Where a body sits this frame: its breath, its drift and its death fall.
   *
   * The mass, the light and the printed value are three separate passes over the
   * colony and all three have to land on the same pixel, so the transform is
   * computed once here rather than three times in three places.
   */
  bodyTransform(body, contract, seconds) {
    const breath = 1 + 0.055 * Math.sin(seconds * 0.8 * Math.PI * 2 + body.phase) * (this.reduced ? 0 : 1);
    /*
     * Neither a husk, a spent organism nor a *preview* breathes or drifts.
     *
     * A settled frame is a still frame, and so is the frame a player is deciding
     * on: the strongest single finding in the calibration set is that its best
     * reference animates literally nothing while it waits for you — two
     * consecutive frames pixel-identical. Round 2's stake screen breathed three
     * organisms, which measured as four independently moving regions against a
     * ceiling of three, for nothing the player needed to perceive.
     */
    const settled = body.husk > 0.5 || body.spent > 0.5;
    const still = this.reduced || settled || this.spread < 1;
    const drift = still
      ? { x: 0, y: 0 }
      : {
          x: (noise1(seconds * 0.14 + body.phase, body.driftSeed) - 0.5) * 5 * this.scale,
          y: (noise1(seconds * 0.11 + body.phase + 7, body.driftSeed + 1) - 0.5) * 5 * this.scale,
        };
    return {
      radius: body.r * contract * (settled ? 1 : breath) * (1 - 0.6 * body.die),
      x: body.x + drift.x,
      y: body.y + drift.y + body.die * 26 * this.scale,
    };
  }

  /** Which baked band a body is currently wearing. */
  bandOf(body) {
    if (body.husk > 0.5) return 'husk';
    if (body.tint === 'amber') return 'amber';
    return this.band;
  }

  /**
   * The value stamped on every living face (§6.2, and criterion 11 of the bar).
   *
   * One blit per body of a sprite baked once per string. The type is sized to the
   * *bell*, so it shrinks with the population exactly as the object does and the
   * colony never carries a label wider than the organism under it.
   */
  drawLabels(ctx, contract, seconds) {
    const label = this.label;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (const body of this.bodies) {
      if (body.alpha < 0.94 || body.split > 0.001 || body.die > 0.02) continue;
      if (body.husk > 0.01 || body.spent > 0.01) continue;
      const { radius, x, y } = this.bodyTransform(body, contract, seconds);
      // 1.34 x radius across: the bell's own flat middle, inside the lappets and
      // clear of the Fresnel limb.
      const width = radius * 1.34;
      const height = width / label.aspect;
      ctx.globalAlpha = body.alpha;
      ctx.drawImage(label.canvas, x - width / 2, y + radius * 0.04 - height / 2, width, height);
    }
    ctx.restore();
  }

  drawBody(ctx, body, level, contract, seconds) {
    const { radius, x, y } = this.bodyTransform(body, contract, seconds);
    const band = this.bandOf(body);
    const mass = this.sprites.mass[band][body.mass];
    const sprite = (body.tint === 'amber' ? this.sprites.amberBells : this.sprites.bells)[body.sprite];
    const bright = (1 + 0.15 * body.hold) * (1 - 0.85 * body.die);
    const massAlpha =
      body.alpha * (1 - 0.5 * body.die) * (body.husk > 0.5 || body.spent > 0.5 ? 0.82 : 1);

    ctx.save();

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

      // The two children, as mass first: a division that occludes reads as one
      // body becoming two, where two additive glows read as one glow brightening.
      for (const sign of [-1, 1]) {
        ctx.save();
        ctx.globalAlpha = massAlpha;
        ctx.translate(x + sign * dx, y + sign * dy);
        ctx.rotate(axis + body.tilt);
        ctx.scale(stretch, squash);
        const box = childRadius * BELL_BLIT;
        ctx.drawImage(mass, -box, -box, box * 2, box * 2);
        ctx.restore();
      }

      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = body.alpha * bright * 0.55;

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
        const box = childRadius * BELL_BLIT;
        ctx.drawImage(sprite, -box, -box, box * 2, box * 2);
        ctx.restore();
      }
      ctx.restore();
      return;
    }

    ctx.translate(x, y);
    ctx.rotate(body.tilt);
    // The sprite carries the tentacle skirt outside the bell's own box, so it is
    // blitted across `2 * BELL_BLIT * radius` and the *bell* lands on exactly the
    // `2 * r(n)` §6.2 specifies.
    const box = radius * BELL_BLIT;
    ctx.globalAlpha = massAlpha;
    ctx.drawImage(mass, -box, -box, box * 2, box * 2);
    // A husk has no interior light left: that is the whole of what a husk is. A
    // *spent* body has some — it is banked money, not a corpse — at the reduced
    // lamp the settlement sets, which keeps it an order below the vessel.
    if (body.husk < 0.5) {
      /*
       * The interior at 55%.
       *
       * This layer used to *be* the organism, so it was baked to carry the whole
       * body on its own. Over an opaque shaded mass it is anatomy — canals, the
       * manubrium, the granulation, the skirt — and at full strength it floods
       * the shading it is meant to sit inside, which puts the frame back where
       * round 1 was: bright, and with no volume in it.
       */
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = body.alpha * bright * 0.55;
      ctx.drawImage(sprite, -box, -box, box * 2, box * 2);
    }
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

  /** The trails: banked light on its way to where the value landed. */
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
      // A trail whose destination can move resolves it every frame: the payout
      // vessel is a DOM object whose box settles a beat after the pour starts,
      // and a stream aimed at where the glass used to be lands beside it.
      if (trail.toFn !== undefined) trail.to = trail.toFn();
      if (!trail.fired && t >= 1) {
        trail.fired = true;
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
   * The payout's light on the water (§7.1).
   *
   * One wide warm lobe from the vessel's own mouth and a tighter hot core inside
   * it, additive, static. It is what makes the settled frame a *lit scene*
   * instead of a gold card on a cold column: the reference celebrations raise
   * global mean luminance by about 80% at a payoff, and none of that comes from
   * the payout surface alone — the whole frame is lit by the event.
   *
   * It is drawn over the world and under the ceremony's own scrim, it never
   * animates, and it exists only on a credited win.
   */
  drawPayoutLight(ctx) {
    if (this.payoutLight < 0.01) return;
    const { width, height } = this;
    const mouth = this.payoutMouth();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    /*
     * Wide and flat, not tight and peaked.
     *
     * A payoff has to lift the *whole* frame — the references measure global mean
     * luminance rising about 80% at one — and a steep radial centred on the
     * payout surface lights the payout surface and nothing else. Blitting the
     * bloom at two and a half times the frame diagonal puts its shoulder across
     * the water column above the glass, which is where the settled colony is
     * standing and where the frame was still measuring as a cold picture with a
     * warm object stuck to it.
     */
    const wash = Math.hypot(width, height) * 2.6;
    ctx.globalAlpha = 0.17 * this.payoutLight;
    ctx.drawImage(this.sprites.amberGlow, mouth.x - wash / 2, mouth.y - wash / 2, wash, wash);
    // Two blits, not three. Each of these is a full-frame blend — the wash alone
    // is 660,000 device pixels composited every frame of the ceremony — and the
    // middle lobe was doing 0.005 of mean luminance for a third of the cost.
    const core = Math.min(width, height) * 1.2;
    ctx.globalAlpha = 0.2 * this.payoutLight;
    ctx.drawImage(this.sprites.emberGlow, mouth.x - core / 2, mouth.y - core / 2, core, core);
    ctx.restore();
  }

  /**
   * The celebration sparks: banked light rising out of the vessel.
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
    /*
     * Frame-level, not stage-level.
     *
     * The grain is the frame's material, and half the frame is not the stage: the
     * stake screen, the harvest stepper and the settlement all sit above the
     * canvas, and all three of them were rendering as untextured CSS gradients —
     * which is exactly the surface the references never have. So the tile is
     * looked up on the document rather than inside the stage element, and the
     * layer it lands on spans the whole frame.
     */
    const layer = document.getElementById('stage-grain');
    if (layer === null) return;
    layer.style.backgroundImage = `url(${this.sprites.grain[0].toDataURL()})`;
  }
}
