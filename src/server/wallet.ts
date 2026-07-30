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
  #state: {
    readonly balanceUnits: bigint;
    readonly stakedUnits: bigint;
    readonly creditedUnits: bigint;
  };
  readonly openingUnits: bigint;

  constructor(openingUnits: bigint) {
    if (typeof openingUnits !== 'bigint' || openingUnits < 0n)
      fail('INVALID_REQUEST', 'An opening balance must be a non-negative BigInt of minor units');
    this.openingUnits = openingUnits;
    this.#state = Object.freeze({
      balanceUnits: openingUnits,
      stakedUnits: 0n,
      creditedUnits: 0n,
    });
  }

  get balanceUnits(): bigint {
    return this.#state.balanceUnits;
  }

  /** Total staked and total credited this session, for the session summary. */
  get stakedUnits(): bigint {
    return this.#state.stakedUnits;
  }

  get creditedUnits(): bigint {
    return this.#state.creditedUnits;
  }

  /** Signed session result. Never hidden behind a positive-only "wins" view. */
  get netUnits(): bigint {
    return this.#state.balanceUnits - this.openingUnits;
  }

  assertCanAfford(units: bigint): void {
    if (units > this.#state.balanceUnits)
      fail('INSUFFICIENT_FUNDS', 'This ticket costs more than the free-play balance', '$.stakeUnits');
  }

  /** Applies a ledger to the balance. A DEBIT is a stake, a CREDIT is a payout. */
  post(receipts: readonly Receipt[]): void {
    if (!Array.isArray(receipts))
      fail('INVALID_REQUEST', 'A wallet posting must be an array of receipts');
    let balanceUnits = this.#state.balanceUnits;
    let stakedUnits = this.#state.stakedUnits;
    let creditedUnits = this.#state.creditedUnits;
    const length = receipts.length;
    for (let index = 0; index < length; index += 1) {
      const receipt = receipts[index];
      if (typeof receipt !== 'object' || receipt === null)
        fail('INVALID_REQUEST', 'A wallet receipt must be an object', `$.receipts[${index}]`);
      const direction = receipt.direction;
      const amountUnits = receipt.amountUnits;
      if (typeof amountUnits !== 'bigint' || amountUnits < 0n)
        fail(
          'INVALID_REQUEST',
          'A wallet amount must be a non-negative BigInt',
          `$.receipts[${index}].amountUnits`,
        );
      if (direction === 'DEBIT') {
        if (amountUnits > balanceUnits)
          fail('INSUFFICIENT_FUNDS', 'The free-play balance cannot cover this debit');
        balanceUnits -= amountUnits;
        stakedUnits += amountUnits;
      } else if (direction === 'CREDIT') {
        balanceUnits += amountUnits;
        creditedUnits += amountUnits;
      } else {
        fail(
          'INVALID_REQUEST',
          'A wallet receipt direction must be DEBIT or CREDIT',
          `$.receipts[${index}].direction`,
        );
      }
    }
    // One assignment is the commit point. Every receipt and invariant above was
    // staged in locals, so no throw can expose a partially applied posting.
    this.#state = Object.freeze({ balanceUnits, stakedUnits, creditedUnits });
  }
}
