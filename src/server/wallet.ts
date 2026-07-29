/**
 * The free-play wallet.
 *
 * In-memory, integer minor units, one session per process. It exists so the
 * graybox can move money the way the ledger says money moves — a debit at
 * `open()`, a credit at every harvest, a credit at settlement, per line — and for
 * no other reason. There is no persistence, no account, no real money, and no
 * operator wallet integration; `docs/MATH.md` §15 says what that would need.
 */
import { fail } from './errors.ts';
import type { Receipt } from './settlement.ts';

export class Wallet {
  #balanceUnits: bigint;
  #stakedUnits = 0n;
  #creditedUnits = 0n;
  readonly openingUnits: bigint;

  constructor(openingUnits: bigint) {
    if (typeof openingUnits !== 'bigint' || openingUnits < 0n)
      fail('INVALID_REQUEST', 'An opening balance must be a non-negative BigInt of minor units');
    this.openingUnits = openingUnits;
    this.#balanceUnits = openingUnits;
  }

  get balanceUnits(): bigint {
    return this.#balanceUnits;
  }

  /** Total staked and total credited this session, for the session summary. */
  get stakedUnits(): bigint {
    return this.#stakedUnits;
  }

  get creditedUnits(): bigint {
    return this.#creditedUnits;
  }

  /** Signed session result. Never hidden behind a positive-only "wins" view. */
  get netUnits(): bigint {
    return this.#balanceUnits - this.openingUnits;
  }

  assertCanAfford(units: bigint): void {
    if (units > this.#balanceUnits)
      fail('INSUFFICIENT_FUNDS', 'This ticket costs more than the free-play balance', '$.stakeUnits');
  }

  /** Applies a ledger to the balance. A DEBIT is a stake, a CREDIT is a payout. */
  post(receipts: readonly Receipt[]): void {
    for (const receipt of receipts) {
      if (receipt.direction === 'DEBIT') {
        if (receipt.amountUnits > this.#balanceUnits)
          fail('INSUFFICIENT_FUNDS', 'The free-play balance cannot cover this debit');
        this.#balanceUnits -= receipt.amountUnits;
        this.#stakedUnits += receipt.amountUnits;
      } else {
        this.#balanceUnits += receipt.amountUnits;
        this.#creditedUnits += receipt.amountUnits;
      }
    }
  }
}
