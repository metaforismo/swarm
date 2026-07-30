/**
 * The share card — `docs/DESIGN.md` §7.1, and §10's first open question decided.
 *
 * §7.1 gives T1 a share card that is available but not offered, T2 one that is
 * offered, and T3 a freeze-frame; and it forbids one outright at any total below
 * the stake. The round-1 client had none of them: grep for "share" returned two
 * comments saying losses do not get one, which is the only part of the rule that
 * was implemented. This is the rest of it.
 *
 * §10 asked whether the card should be captured client-side or rendered by the
 * server with a verification URL baked in. It is captured here, for one reason
 * that is not about effort: the picture on the card has to be *this round's own
 * frame*. A server-rendered card can carry the numbers but not the colony the
 * player was actually watching, and the whole point of §7.2 is that the picture
 * is the thing worth sharing. The verification identity travels as text instead
 * — the round id and the server's pre-commitment are printed on the card, which
 * is what a sceptical reader needs to check it and is the same pair the Verify
 * sheet starts from.
 *
 * Everything is drawn here: gradients, type, the colony glyph, the frame. No
 * image, font file or asset is fetched from anywhere, and nothing about the card
 * is copied from any other product.
 *
 * Two things on the card are not decoration and may not be removed:
 *
 * - **The free-play disclosure.** An image of a balance and a payout that
 *   travels off the device without it is a picture of money that does not exist,
 *   and §9.9 puts that marker on every screen for exactly this reason.
 * - **The signed net result.** §9.3's rule is that a return is never shown
 *   without what it cost, on *any* surface, and a shared image is the surface
 *   most likely to be seen without the round around it.
 */
import { credits, shortHex, signedCredits } from './format.js';

const W = 1080;
const H = 1350;

const NUMERALS = 'ui-monospace, "SF Mono", "Space Grotesk", Menlo, monospace';
const UI = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** §6.1, and the only place the palette appears in this file. */
const C = {
  abyss: '#02040a',
  trench: '#061019',
  crust: '#1e4a56',
  lumen: '#39f5c8',
  amber: '#ffc978',
  amberHigh: '#fff1d8',
  ash: '#8a97a6',
  foam: '#e6f4f1',
  mist: '#9fb6bd',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, value, x, y, { font, size, colour, align = 'center', track = 0, glow = null }) {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = track === 0 ? align : 'left';
  ctx.textBaseline = 'alphabetic';
  if (glow !== null) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = size * 0.7;
  }
  if (track === 0) {
    ctx.fillText(value, x, y);
    ctx.restore();
    return;
  }
  // Manual tracking: canvas has no letter-spacing everywhere yet, and the labels
  // in this game are tracked uppercase (§6.6).
  const glyphs = [...value];
  const width = glyphs.reduce((total, glyph) => total + ctx.measureText(glyph).width + track, -track);
  let cursor = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  for (const glyph of glyphs) {
    ctx.fillText(glyph, cursor, y);
    cursor += ctx.measureText(glyph).width + track;
  }
  ctx.restore();
}

/**
 * The freeze-frame: this round's own stage, cropped to the card's window.
 *
 * `object-fit: cover` by hand, because the stage is 390x844-ish and the window
 * is landscape — the crop keeps the colony, which sits at 40% height, centred in
 * what survives.
 */
function drawFreezeFrame(ctx, source, x, y, w, h) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 28);
  ctx.clip();
  ctx.fillStyle = C.abyss;
  ctx.fillRect(x, y, w, h);
  if (source !== null && source.width > 0 && source.height > 0) {
    const scale = Math.max(w / source.width, h / source.height);
    const dw = source.width * scale;
    const dh = source.height * scale;
    // The colony centroid is at 40% of the stage; keep it at 46% of the window.
    const dx = x + (w - dw) / 2;
    const dy = y + h * 0.46 - dh * 0.4;
    ctx.drawImage(source, dx, dy, dw, dh);
  }
  // A vignette, so the numerals below the window have something to sit against.
  const fade = ctx.createLinearGradient(0, y, 0, y + h);
  fade.addColorStop(0, 'rgba(2, 4, 10, 0.55)');
  fade.addColorStop(0.4, 'rgba(2, 4, 10, 0.05)');
  fade.addColorStop(1, 'rgba(2, 4, 10, 0.78)');
  ctx.fillStyle = fade;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  ctx.strokeStyle = 'rgba(30, 74, 86, 0.75)';
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 28);
  ctx.stroke();
}

/**
 * Composes the card. `frame` is the stage canvas, already frozen by the caller
 * at the moment the round settled — the picture has to be the round's own.
 */
export function drawShareCard(canvas, { view, tier, stakeMultiple, frame }) {
  const settlement = view.settlement;
  const proof = settlement.proof;
  const credited = BigInt(settlement.creditedUnits);
  const staked = BigInt(settlement.stakedUnits);
  const net = BigInt(settlement.netUnits);
  const populations = Array.isArray(proof.populations) ? proof.populations : [];
  const peak = populations.length === 0 ? 0 : Math.max(...populations);
  const loud = tier === 'T2' || tier === 'T3';

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // The ground: the same water the stage is made of.
  const water = ctx.createLinearGradient(0, 0, 0, H);
  water.addColorStop(0, '#02040a');
  water.addColorStop(0.5, '#050d16');
  water.addColorStop(1, '#02060c');
  ctx.fillStyle = water;
  ctx.fillRect(0, 0, W, H);

  // The warm wash a settlement earns, scaled by tier. AMBER, because what is
  // being shown is banked money and AMBER means exactly that (§6.1).
  const wash = ctx.createRadialGradient(W / 2, H * 0.62, 0, W / 2, H * 0.62, W * 0.9);
  wash.addColorStop(0, `rgba(255, 201, 120, ${tier === 'T3' ? 0.16 : tier === 'T2' ? 0.1 : 0.05})`);
  wash.addColorStop(1, 'rgba(255, 201, 120, 0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  // ------------------------------------------------------------------ header
  text(ctx, 'SWARM', 72, 116, {
    font: `600 46px ${UI}`,
    size: 46,
    colour: C.foam,
    align: 'left',
    track: 7,
  });
  text(ctx, 'PROVABLY FAIR', W - 72, 110, {
    font: `500 24px ${UI}`,
    size: 24,
    colour: C.lumen,
    align: 'right',
    track: 4,
  });

  // ------------------------------------------------------- the freeze-frame
  drawFreezeFrame(ctx, frame, 72, 168, W - 144, 470);

  // -------------------------------------------------------------- the figure
  const figureY = 830;
  text(ctx, `${stakeMultiple}×`, W / 2, figureY, {
    font: `700 190px ${NUMERALS}`,
    size: 190,
    colour: loud ? C.amberHigh : C.amber,
    glow: loud ? 'rgba(255, 201, 120, 0.75)' : 'rgba(255, 201, 120, 0.4)',
  });
  text(ctx, 'YOUR STAKE, RETURNED', W / 2, figureY + 58, {
    font: `500 26px ${UI}`,
    size: 26,
    colour: C.amber,
    track: 6,
  });

  // ------------------------------------------------------------- the numbers
  const panelY = figureY + 108;
  ctx.fillStyle = 'rgba(10, 27, 40, 0.55)';
  roundRect(ctx, 72, panelY, W - 144, 196, 26);
  ctx.fill();
  ctx.strokeStyle = 'rgba(57, 245, 200, 0.2)';
  ctx.lineWidth = 2;
  roundRect(ctx, 72, panelY, W - 144, 196, 26);
  ctx.stroke();

  const col = (label, value, x, colour) => {
    text(ctx, label, x, panelY + 60, { font: `500 22px ${UI}`, size: 22, colour: C.mist, track: 4 });
    text(ctx, value, x, panelY + 122, { font: `600 46px ${NUMERALS}`, size: 46, colour });
  };
  col('RETURNED', credits(credited), W * 0.28, C.foam);
  col('NET', signedCredits(net), W * 0.72, C.amber);
  // A hairline between the two, so the panel reads as two readings and not one.
  ctx.strokeStyle = 'rgba(30, 74, 86, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(W / 2, panelY + 34);
  ctx.lineTo(W / 2, panelY + 162);
  ctx.stroke();

  text(
    ctx,
    `STAKED ${credits(staked)}  ·  ${proof.terminal}  ·  ${populations.length} GEN  ·  PEAK ${peak}`,
    W / 2,
    panelY + 246,
    { font: `500 24px ${UI}`, size: 24, colour: C.mist, track: 3 },
  );

  // ------------------------------------------------------------- the footing
  text(ctx, `ROUND ${shortHex(proof.roundId, 10, 6)}`, 72, H - 96, {
    font: `400 21px ${NUMERALS}`,
    size: 21,
    colour: C.ash,
    align: 'left',
  });
  text(ctx, `COMMITMENT ${shortHex(proof.seedCommitment, 10, 8)}`, W - 72, H - 96, {
    font: `400 21px ${NUMERALS}`,
    size: 21,
    colour: C.ash,
    align: 'right',
  });
  // Not removable: an image of a payout that leaves the device without this is a
  // picture of money that does not exist (§9.9).
  text(ctx, 'FREE-PLAY DEMO CREDITS · NO CASH VALUE', W / 2, H - 44, {
    font: `500 22px ${UI}`,
    size: 22,
    colour: C.ash,
    track: 5,
  });

  return canvas;
}

/**
 * The share sheet: the card, and the two things a player can do with it.
 *
 * Saving is an `<a download>` over a blob the page made itself, and copying goes
 * through the clipboard's image path where the browser has one. Neither route
 * uploads anything: there is no endpoint in this product that a share card is
 * posted to, and adding one would be a different decision than §7.1 made.
 */
export function shareSheet({ view, tier, stakeMultiple, frame, onToast }) {
  const fragment = document.createDocumentFragment();

  const note = document.createElement('p');
  note.className = 'small muted';
  note.textContent =
    'Your own frame, this round’s numbers, and the two values anyone needs to check it: the round id and the seed the server sealed before you played.';
  fragment.append(note);

  const settlement = view.settlement;
  const proof = settlement.proof;
  const populations = Array.isArray(proof.populations) ? proof.populations : [];
  const canvas = document.createElement('canvas');
  canvas.className = 'share-canvas';
  canvas.setAttribute('role', 'img');
  /*
   * Everything on the card, as text.
   *
   * §9.6's rule is that no channel is the only channel, and a canvas is the most
   * opaque channel in the client: without this the round id and the server's
   * pre-commitment — the two values the copy above promises are on the card —
   * exist for a screen-reader user only as pixels.
   */
  canvas.setAttribute(
    'aria-label',
    [
      `Share card. ${stakeMultiple} times your stake returned.`,
      `Returned ${credits(settlement.creditedUnits)}, staked ${credits(settlement.stakedUnits)}, net ${signedCredits(BigInt(settlement.netUnits))}.`,
      `Terminal ${proof.terminal}, ${populations.length} generation${populations.length === 1 ? '' : 's'}, peak ${populations.length === 0 ? 0 : Math.max(...populations)} organisms.`,
      `Round ${proof.roundId}. Server seed commitment ${proof.seedCommitment}.`,
      'Free-play demo credits with no cash value.',
    ].join(' '),
  );
  drawShareCard(canvas, { view, tier, stakeMultiple, frame });
  fragment.append(canvas);

  const row = document.createElement('div');
  row.className = 'linkrow';

  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save image';
  save.addEventListener('click', () => {
    canvas.toBlob((blob) => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `swarm-${view.settlement.proof.roundId.slice(0, 10)}.png`;
      anchor.click();
      // Revoked on the next turn of the loop: revoking synchronously races the
      // click on some engines and produces a saved file of zero bytes.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  });
  row.append(save);

  if (typeof ClipboardItem === 'function' && navigator.clipboard?.write !== undefined) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy image';
    copy.addEventListener('click', () => {
      canvas.toBlob(async (blob) => {
        if (blob === null) return;
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          onToast?.('Share card copied.');
        } catch {
          onToast?.('This browser would not take the image. Save it instead.');
        }
      }, 'image/png');
    });
    row.append(copy);
  }

  fragment.append(row);
  return fragment;
}
