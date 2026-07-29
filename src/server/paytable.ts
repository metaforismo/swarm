/**
 * The paytable this service pays from.
 *
 * It is the frozen canonical fixture, `spec/paytable.v3.json` — the artifact
 * `tools/enumerate.mjs` writes from the exhaustive exact enumeration and
 * `npm run paytable:check` compares byte for byte on every CI run. Loading it
 * rather than re-deriving it means the money path and the published numbers are
 * the same object, and `tests/server-paytable.test.mjs` re-runs the live
 * enumeration and asserts the two agree exactly.
 *
 * Everything crossing this boundary is an exact fraction. No number in a money
 * path is ever read out of the fixture as a decimal.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFixture } from '../../tools/lib/canonical.mjs';
import { fromFraction } from '../../tools/lib/rational.mjs';
import {
  SIDE_BET_IDS,
  SWARM,
  assertRiskIsHeadroom,
} from './adapter.ts';
import { equal, multiply, type Rational } from './engine.ts';
import { fail } from './errors.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../../spec/paytable.v3.json', import.meta.url));

/** The whole frozen fixture, parsed defensively: bounded size, no prototype pollution. */
export const PAYTABLE = parseFixture(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, any>;

if (PAYTABLE.adapterId !== SWARM.id || PAYTABLE.adapterVersion !== SWARM.adapterVersion)
  fail('INVALID_ADAPTER', 'The frozen paytable belongs to a different adapter', '$.paytable');

export interface SideBetPrice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly probability: Rational;
  readonly multiplier: Rational;
  readonly capMultiple: bigint;
  /** Truncated toward zero, so the credited amount is never below what was displayed. */
  readonly multiplierDecimal: string;
  readonly probabilityDecimal: string;
  readonly oneIn: string;
}

function loadSideBets(): readonly SideBetPrice[] {
  const rows = PAYTABLE.sideBets as readonly Record<string, string>[];
  if (!Array.isArray(rows) || rows.length !== SIDE_BET_IDS.length)
    fail('INVALID_ADAPTER', 'The frozen paytable declares a different side-bet set', '$.sideBets');
  return Object.freeze(
    rows.map((row, index) => {
      const id = row.id as string;
      if (id !== SIDE_BET_IDS[index])
        fail('INVALID_ADAPTER', 'Side-bet declaration order does not match the adapter', '$.sideBets');
      const probability = fromFraction(row.probability as string) as Rational;
      const multiplier = fromFraction(row.multiplier as string) as Rational;
      const capMultiple = BigInt(row.capMultiple as string);
      const declared = SWARM.sideBets.find((bet) => bet.id === id);
      if (declared === undefined || declared.maxWinMultiple !== capMultiple)
        fail('INVALID_ADAPTER', `Side bet ${id} carries a cap the adapter does not declare`, '$.sideBets');
      // Every side bet is priced at exactly the target RTP, by construction.
      if (!equal(multiply(multiplier, probability), SWARM.pricing.targetRtp))
        fail('INVALID_ADAPTER', `Side bet ${id} is not priced at the target RTP`, '$.sideBets');
      return Object.freeze({
        id,
        label: row.label as string,
        description: row.description as string,
        probability,
        multiplier,
        capMultiple,
        multiplierDecimal: row.multiplierDecimal as string,
        probabilityDecimal: row.probabilityDecimal as string,
        oneIn: row.oneIn as string,
      });
    }),
  );
}

export const SIDE_BETS: readonly SideBetPrice[] = loadSideBets();

const BY_ID = new Map(SIDE_BETS.map((bet) => [bet.id, bet]));

export function sideBetPrice(id: string): SideBetPrice {
  const bet = BY_ID.get(id);
  if (bet === undefined) fail('INVALID_REQUEST', `No such side bet: ${id}`, '$.sideBets');
  return bet;
}

/**
 * The largest total the COLONY line can credit in one round, over every draw grid
 * and every harvest policy simultaneously — `905.776494...x`, from the dynamic
 * program in `maximumRoundPayout()`. The declared cap is the smallest integer
 * strictly above it, which is what makes the cap provably unable to bite.
 */
export const COLONY_MAXIMUM_CREDIT: Rational = fromFraction(
  PAYTABLE.roundMaximum.multiplier as string,
) as Rational;

assertRiskIsHeadroom(
  COLONY_MAXIMUM_CREDIT,
  new Map(SIDE_BETS.map((bet) => [bet.id, bet.multiplier])),
);
