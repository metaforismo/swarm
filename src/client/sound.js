/**
 * The sound layer — synthesised here, in full, with WebAudio.
 *
 * No sample is downloaded and no recording is shipped: every voice in this file
 * is an oscillator, a procedurally filled noise buffer, or a procedurally
 * generated impulse response. `docs/DESIGN.md` §8 is the brief — underwater,
 * hydrophone-flavoured, everything slightly low-passed, dark reverb with a long
 * tail and no early reflections — and the mix rules are the part that is not
 * decoration:
 *
 * - **Emphasis follows the money** (§6.5 R1). The only voice that scales with
 *   anything is the verdict, and it scales with `D` — the signed change in colony
 *   value in stake multiples. The SPLIT mark does not escalate and does not grow
 *   with the number of splits.
 * - **Loss has a channel** (§6.5 R3). The DIE mark sits at the same level as the
 *   split mark. Quiet is not absent, and there is no descending "fail" motif.
 * - **A transfer is not a gain** (§6.5 R6). A harvest gets one soft informational
 *   mark per arrival and nothing else: no pour, no swell, no rising figure.
 * - **A round that returned less than it cost gets no win sound** (§7.1, §8).
 * - **Fully playable muted.** Every audio event has a visual counterpart, so a
 *   muted phone loses nothing but pleasure. That is why the mute control is a
 *   plain toggle with no warning attached to it.
 *
 * Autoplay: no `AudioContext` is created until the player's first gesture, which
 * is what every mobile browser requires and also the honest default — a game
 * that starts making noise before it is touched is a game that made a decision
 * for the player.
 */

const STORAGE_MUTED = 'swarm.muted';

/** Decibels to a linear gain, because §8 is written in dB. */
const dB = (value) => Math.pow(10, value / 20);

/**
 * `semitones = min(7, floor(log_1.5 D))` — §6.5's chord ladder.
 *
 * Written as a walk up the powers of `3/2` rather than as a logarithm, because
 * the logarithm gets the published boundary wrong. `docs/DESIGN.md` §6.5 states
 * that the top note sounds at exactly `(3/2)^7 = 17.0859375` stakes gained, and
 * `Math.log(17.0859375) / Math.log(1.5)` is `6.999999999999999` in double
 * precision, so `floor` returns 6 — the one figure the specification names is the
 * one figure the closed form cannot reach. The walk compares against each bound
 * with a tolerance and lands on 7 there, which is what the enumerator's
 * reachability check is about.
 */
export function semitonesFor(delta) {
  let semitones = 0;
  let bound = 1.5;
  while (semitones < 7 && delta >= bound - 1e-9) {
    semitones += 1;
    bound *= 1.5;
  }
  return semitones;
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem(STORAGE_MUTED) === '1';
    this.ready = false;
    this.voices = 0;
    this.shimmerTimer = null;
    this.population = 0;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Builds the graph on the first gesture. Idempotent, and safe to call from
   * every pointer handler in the client.
   */
  unlock() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (Ctx === undefined) return;
    this.ctx = new Ctx();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    // Everything is slightly low-passed: this is a hydrophone, not a speaker in
    // air. One shelf at the end of the chain does the whole mix.
    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    this.air.frequency.value = 7200;
    this.air.Q.value = 0.4;
    this.master.connect(this.air).connect(ctx.destination);

    // The dark reverb: a long tail, and no early reflections — the impulse is
    // silent for its first 45 ms, so nothing arrives before the tail does.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.6);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.5;
    this.reverb.connect(this.wet).connect(this.master);

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.master);

    this.noise = this.noiseBuffer(3);
    this.ready = true;
    this.startBed();
  }

  /** A dark, tail-only impulse response, generated rather than recorded. */
  impulse(seconds) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, length, rate);
    const preDelay = Math.floor(rate * 0.045);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      let low = 0;
      for (let index = 0; index < length; index += 1) {
        if (index < preDelay) {
          data[index] = 0;
          continue;
        }
        const t = (index - preDelay) / (length - preDelay);
        // A soft fade-in over the first 120 ms removes the attack transient, so
        // the tail arrives without an early reflection in front of it.
        const swell = Math.min(1, ((index - preDelay) / rate) / 0.12);
        const decay = Math.pow(1 - t, 3.1);
        const white = Math.random() * 2 - 1;
        low += (white - low) * 0.12; // one-pole low-pass: the water eats the top
        data[index] = low * decay * swell * 0.7;
      }
    }
    return buffer;
  }

  /** Band-limited noise, looped for the bed and sliced for the ticks. */
  noiseBuffer(seconds) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let low = 0;
    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      low += (white - low) * 0.06;
      data[index] = low * 3.2;
    }
    return buffer;
  }

  setMuted(muted) {
    this.muted = muted;
    localStorage.setItem(STORAGE_MUTED, muted ? '1' : '0');
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(muted ? 0 : 1, now, 0.05);
  }

  get audible() {
    return this.ready && !this.muted;
  }

  // ----------------------------------------------------------------------- bed

  /**
   * §8's bed: a 40 Hz vent rumble plus band-limited noise, with a 0.05 Hz filter
   * sweep. It is static while a decision panel is open — the audio must never
   * push a decision — so nothing in this client ever modulates it on a decision.
   */
  startBed() {
    const ctx = this.ctx;
    const bed = ctx.createGain();
    bed.gain.value = dB(-32) * 12;
    bed.connect(this.dry);
    bed.connect(this.reverb);

    const rumble = ctx.createOscillator();
    rumble.type = 'sine';
    rumble.frequency.value = 40;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.6;
    rumble.connect(rumbleGain).connect(bed);
    rumble.start();

    const water = ctx.createBufferSource();
    water.buffer = this.noise;
    water.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'lowpass';
    band.frequency.value = 320;
    band.Q.value = 0.7;
    const waterGain = ctx.createGain();
    waterGain.gain.value = 0.22;
    water.connect(band).connect(waterGain).connect(bed);
    water.start();

    // The 0.05 Hz sweep: 20 s in, 20 s out, forever.
    const sweep = ctx.createOscillator();
    sweep.type = 'sine';
    sweep.frequency.value = 0.05;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 160;
    sweep.connect(sweepDepth).connect(band.frequency);
    sweep.start();

    this.bed = bed;
    this.bedLevel = bed.gain.value;
  }

  /** Ducks the bed to silence and back — §7.1's "the silence does the work". */
  duck(seconds) {
    if (!this.audible) return;
    const now = this.ctx.currentTime;
    this.bed.gain.cancelScheduledValues(now);
    this.bed.gain.setTargetAtTime(0.0001, now, 0.04);
    this.bed.gain.setTargetAtTime(this.bedLevel, now + seconds, 0.12);
  }

  /**
   * The granular shimmer: a sparse field of high grains whose density scales
   * with the population, so a big colony reads as a shimmer and a single
   * organism reads as almost nothing.
   *
   * It carries no money information — it follows the count, and the count is
   * already printed as a numeral — and it never escalates on an outcome, which is
   * what keeps it outside §6.5 R1's scope.
   */
  setPopulation(units) {
    this.population = units;
    if (!this.ready) return;
    if (this.shimmerTimer !== null) return;
    this.shimmerTimer = setInterval(() => {
      if (!this.audible || this.population <= 0) return;
      const density = Math.min(1, this.population / 18);
      if (Math.random() > 0.18 + density * 0.5) return;
      const grains = 1 + Math.floor(density * 2);
      for (let index = 0; index < grains; index += 1) {
        this.grain(density);
      }
    }, 180);
  }

  grain(density) {
    const ctx = this.ctx;
    const now = ctx.currentTime + Math.random() * 0.12;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1800 + Math.random() * 2600;
    const gain = ctx.createGain();
    const level = dB(-38) * (0.4 + density * 0.6);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.00001, now + 0.28);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    osc.connect(gain).connect(pan);
    pan.connect(this.reverb);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  // ------------------------------------------------------------------- voicing

  /**
   * One synthesised mark. Everything in §8's table is this function with
   * different arguments, which is deliberate: a table of marks that all come out
   * of one voice cannot drift out of relative level with each other.
   */
  mark({
    freq = 440,
    type = 'sine',
    attack = 0.008,
    decay = 0.18,
    gain = dB(-18),
    pan = 0,
    filter = null,
    sweepTo = null,
    wet = 0.4,
    delay = 0,
    detune = 0,
  }) {
    if (!this.audible) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (sweepTo !== null) osc.frequency.exponentialRampToValueAtTime(sweepTo, now + decay * 0.8);
    if (detune !== 0) osc.detune.value = detune;

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(gain, now + attack);
    envelope.gain.exponentialRampToValueAtTime(0.00001, now + attack + decay);

    let node = osc;
    if (filter !== null) {
      const biquad = ctx.createBiquadFilter();
      biquad.type = filter.type ?? 'lowpass';
      biquad.frequency.setValueAtTime(filter.freq ?? 900, now);
      if (filter.to !== undefined)
        biquad.frequency.exponentialRampToValueAtTime(filter.to, now + decay);
      biquad.Q.value = filter.q ?? 1;
      node = node.connect(biquad);
    }
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(envelope).connect(panner);

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1 - wet;
    panner.connect(dryGain).connect(this.dry);
    const wetGain = ctx.createGain();
    wetGain.gain.value = wet;
    panner.connect(wetGain).connect(this.reverb);

    osc.start(now);
    osc.stop(now + attack + decay + 0.05);
  }

  /** A filtered noise burst — the ticks and the reverse-reverb bloom. */
  burst({ freq = 1200, q = 3, decay = 0.06, gain = dB(-22), attack = 0.004, wet = 0.4, delay = 0, reverse = false }) {
    if (!this.audible) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 0.9 + Math.random() * 0.2;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = q;
    const envelope = ctx.createGain();
    if (reverse) {
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.exponentialRampToValueAtTime(gain, now + decay);
      envelope.gain.linearRampToValueAtTime(0.0001, now + decay + 0.05);
    } else {
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.linearRampToValueAtTime(gain, now + attack);
      envelope.gain.exponentialRampToValueAtTime(0.00001, now + attack + decay);
    }
    source.connect(band).connect(envelope);
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1 - wet;
    envelope.connect(dryGain).connect(this.dry);
    const wetGain = ctx.createGain();
    wetGain.gain.value = wet;
    envelope.connect(wetGain).connect(this.reverb);
    source.start(now, Math.random() * 2);
    source.stop(now + decay + 0.4);
  }

  // ------------------------------------------------------------------- the game

  /** §8: soft membrane taps, no clicks, 8 ms attack. */
  tap() {
    this.mark({ freq: 190, type: 'sine', attack: 0.008, decay: 0.09, gain: dB(-24), wet: 0.2, filter: { type: 'lowpass', freq: 900 } });
  }

  /** The vent pulse of the draw flash. */
  drawFlash() {
    this.mark({ freq: 62, type: 'sine', attack: 0.01, decay: 0.34, gain: dB(-20), sweepTo: 38, wet: 0.55 });
  }

  /**
   * The organism breath: a 220 Hz blip panned by screen position, voice-limited
   * to six so a big colony reads as a chord rather than a crowd.
   */
  breath(pan) {
    if (this.voices >= 6) return;
    this.voices += 1;
    setTimeout(() => {
      this.voices -= 1;
    }, 220);
    this.mark({ freq: 220, type: 'sine', attack: 0.04, decay: 0.2, gain: dB(-30), pan, wet: 0.55 });
  }

  /** §8: short wet glass tick, 880 Hz, 8 ms attack, 180 ms decay, −18 dB. */
  split(pan = 0) {
    this.mark({ freq: 880, type: 'triangle', attack: 0.008, decay: 0.18, gain: dB(-18), pan, wet: 0.55, filter: { type: 'lowpass', freq: 3400 } });
  }

  /** §8: a 30 ms filtered tick, −22 dB. Barely present. */
  hold(pan = 0) {
    this.burst({ freq: 1400, q: 4, decay: 0.03, gain: dB(-22), wet: 0.3 });
  }

  /**
   * §8: a 90 Hz thud with a fast low-pass, −18 dB — the same level as the split
   * mark. Felt and heard, with no "fail" motif and no descending pitch.
   */
  die(pan = 0) {
    this.mark({ freq: 90, type: 'sine', attack: 0.006, decay: 0.26, gain: dB(-18), pan, wet: 0.4, filter: { type: 'lowpass', freq: 700, to: 120 } });
  }

  /**
   * The verdict, and the one voice in the game that scales.
   *
   * `delta` is `D` in stake multiples. Below zero: one short low mark, no pitch
   * movement, −18 dB at or beyond a whole stake and −22 dB inside it. At zero: a
   * soft membrane tick. Above zero and under a stake: a two-note rise. At or
   * above a stake: a rising chord at `min(7, floor(log_1.5 D))` semitones, which
   * is §6.5's hook and is keyed to money and to nothing else.
   */
  verdict(delta) {
    if (!this.audible) return;
    if (delta <= -1) {
      this.mark({ freq: 116, type: 'sine', attack: 0.006, decay: 0.34, gain: dB(-18), wet: 0.5, filter: { type: 'lowpass', freq: 600 } });
      return;
    }
    if (delta < 0) {
      this.mark({ freq: 116, type: 'sine', attack: 0.006, decay: 0.3, gain: dB(-22), wet: 0.5, filter: { type: 'lowpass', freq: 600 } });
      return;
    }
    if (delta === 0) {
      this.burst({ freq: 520, q: 2.4, decay: 0.05, gain: dB(-24), wet: 0.35 });
      return;
    }
    const root = 174.61; // F3 — the bed's own key, so a gain resolves into it.
    const step = (semitones) => root * Math.pow(2, semitones / 12);
    if (delta < 1) {
      this.mark({ freq: step(0), type: 'triangle', attack: 0.01, decay: 0.3, gain: dB(-22), wet: 0.55 });
      this.mark({ freq: step(7), type: 'triangle', attack: 0.01, decay: 0.34, gain: dB(-23), wet: 0.55, delay: 0.095 });
      return;
    }
    const chord = [0, 7, 12, 12 + semitonesFor(delta)];
    chord.forEach((interval, index) => {
      this.mark({
        freq: step(interval),
        type: index === 3 ? 'triangle' : 'sine',
        attack: 0.014,
        decay: 0.62 + index * 0.1,
        gain: dB(index === 3 ? -17 : -21),
        wet: 0.62,
        delay: index * 0.07,
      });
    });
  }

  /**
   * §8: one soft "banked" click at the moment the value lands in the chip.
   * Informational, not a reward — a harvest is a transfer and its signed value
   * change is zero (§6.5 R6). No pour, no swell, no rising figure, and it does
   * not change pitch with the amount.
   */
  banked() {
    this.mark({ freq: 660, type: 'sine', attack: 0.006, decay: 0.11, gain: dB(-22), wet: 0.35, filter: { type: 'lowpass', freq: 2400 } });
    this.mark({ freq: 330, type: 'sine', attack: 0.006, decay: 0.16, gain: dB(-26), wet: 0.4, delay: 0.012 });
  }

  /**
   * §8's environment reveal: bed only for 180 ms, then a single sub-bass swell
   * (28 Hz, 900 ms) under a wide reverse-reverb bloom. No stinger, no fanfare —
   * the reveal is keyed to colony value and the picture does the work.
   */
  reveal() {
    if (!this.audible) return;
    this.duck(0.18);
    const ctx = this.ctx;
    const now = ctx.currentTime + 0.18;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(28, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(dB(-9), now + 0.42);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    sub.connect(gain).connect(this.dry);
    sub.start(now);
    sub.stop(now + 1);
    this.burst({ freq: 900, q: 0.8, decay: 0.62, gain: dB(-19), wet: 0.9, delay: 0.18, reverse: true });
    this.burst({ freq: 2600, q: 0.7, decay: 0.7, gain: dB(-25), wet: 0.9, delay: 0.24, reverse: true });
  }

  /** The extinction fall: the light leaving, not a verdict mark and not a fail. */
  extinction() {
    this.mark({ freq: 74, type: 'sine', attack: 0.02, decay: 0.9, gain: dB(-19), sweepTo: 34, wet: 0.7, filter: { type: 'lowpass', freq: 420, to: 110 } });
  }

  /**
   * The settlement, per tier (§7.1, §8).
   *
   * `T-nil` and `T0-loss` get the soft click of the value settling and nothing
   * else: a round that returned less than it cost does not get a win sound, and a
   * muted phone must not be the only thing that tells the player so. `T2` and
   * `T3` open with silence, because the silence does the work.
   */
  settle(tier) {
    if (!this.audible) return;
    if (tier === 'T-nil' || tier === 'T0-loss') {
      this.burst({ freq: 420, q: 2.2, decay: 0.06, gain: dB(-24), wet: 0.3 });
      return;
    }
    const root = 174.61;
    const step = (semitones) => root * Math.pow(2, semitones / 12);
    // The warm resolve: a major triad in the bed's key, opened out by tier.
    const voices = tier === 'T0-win' ? [0, 7] : tier === 'T1' ? [0, 7, 12] : [0, 4, 7, 12, 16];
    const silence = tier === 'T2' || tier === 'T3' ? 0.25 : 0;
    if (silence > 0) this.duck(silence);
    voices.forEach((interval, index) => {
      this.mark({
        freq: step(interval),
        type: index % 2 === 0 ? 'sine' : 'triangle',
        attack: tier === 'T3' ? 0.06 : 0.02,
        decay: 0.7 + index * 0.16,
        gain: dB(tier === 'T3' ? -15 : tier === 'T2' ? -17 : -21),
        wet: 0.66,
        delay: silence + index * (tier === 'T3' ? 0.1 : 0.06),
      });
    });
    if (tier === 'T2' || tier === 'T3') {
      this.burst({ freq: 1800, q: 0.7, decay: 0.5, gain: dB(-24), wet: 0.9, delay: silence, reverse: true });
    }
  }
}
