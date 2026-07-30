import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../src/server/http.ts';
import { seedCommitment } from '../src/server/commitment.ts';
import { RoundService } from '../src/server/service.ts';
import type { Receipt, Settlement } from '../src/server/settlement.ts';
import { verifyRound, type ProofBundle } from '../src/server/verify.ts';
import { Wallet } from '../src/server/wallet.ts';

const ENTROPY = 'c'.repeat(64);
const SEED_A = '9667b8896a62186befbaf96b9ae8e4704e44d065f0ae6aa6a43a4239c63874cb';
const SEED_B = '0e4ac2893a15a0fc6a7caecedbc56d943eee45377f5ef4f2ecf9cc758bcb1ec2';
const ZERO_PACING = Object.freeze({
  roundCycleMs: 0,
  decisionDeadPeriodMs: 0,
  settlementHoldMs: 0,
});

let roundCounter = 0;

function serviceFor(
  options: ConstructorParameters<typeof RoundService>[0] = {},
): RoundService {
  return new RoundService({
    openingBalanceUnits: 2_000_000_000n,
    seedSource: () => SEED_A,
    roundIdSource: () => 'swarm-fixture-0',
    pacing: ZERO_PACING,
    ...options,
  });
}

async function openRound(
  service: RoundService,
  request: Record<string, unknown> = {},
): Promise<{ roundId: string; result: any }> {
  const roundId = service.createRound().roundId;
  const result = await service.open(
    roundId,
    {
      idempotencyKey: `open-${roundId}`,
      expectedFrameRevision: 0,
      stakeUnits: 1_000_000n,
      sideBets: [],
      clientEntropy: ENTROPY,
      ...request,
    } as any,
  );
  return { roundId, result };
}

async function bankFixture(
  service: RoundService,
  sideBets: readonly { id: string; stakeUnits: bigint }[] = [],
): Promise<{ roundId: string; settlement: Settlement }> {
  const { roundId, result: opened } = await openRound(service, { sideBets });
  const advanced = await service.advance(roundId, {
    idempotencyKey: `advance-${roundId}`,
    expectedFrameRevision: opened.frame.revision,
  });
  const banked = await service.harvest(roundId, {
    idempotencyKey: `bank-${roundId}`,
    expectedFrameRevision: advanced.frame.revision,
    units: advanced.frame.units,
  });
  const settled = await service.settle(roundId, {
    idempotencyKey: `settle-${roundId}`,
    expectedFrameRevision: banked.frame.revision,
  });
  return { roundId, settlement: settled.value };
}

function tryMutation(run: () => void): void {
  try {
    run();
  } catch {
    // A frozen public snapshot is expected to reject the write in strict mode.
  }
}

describe('SWARM-01 — custody-held round state never crosses the public boundary', () => {
  it('cannot turn a copied receipt deletion into a duplicate wallet credit', async () => {
    const service = serviceFor();
    const { roundId, result: opened } = await openRound(service);
    const advanced = await service.advance(roundId, {
      idempotencyKey: `advance-${roundId}`,
      expectedFrameRevision: opened.frame.revision,
    });
    const banked = await service.harvest(roundId, {
      idempotencyKey: `bank-${roundId}`,
      expectedFrameRevision: advanced.frame.revision,
      units: advanced.frame.units,
    });
    expect(banked.receipts[0]?.amountUnits).toBe(1_583_333n);
    const afterBank = service.wallet.balanceUnits;

    const exposed = service.book(roundId);
    tryMutation(() => {
      (exposed.receipts as Receipt[]).splice(1, 1);
    });

    const settled = await service.settle(roundId, {
      idempotencyKey: `settle-${roundId}`,
      expectedFrameRevision: banked.frame.revision,
    });
    expect(settled.value.creditedUnits).toBe(1_583_333n);
    expect(service.wallet.balanceUnits).toBe(afterBank);
    expect(service.book(roundId).receipts.map((receipt) => receipt.sequence)).toEqual([1, 2, 3]);
  });

  it('cannot forge a side bet after its wild outcome is known', async () => {
    const service = serviceFor();
    const { roundId, result: opened } = await openRound(service);
    const advanced = await service.advance(roundId, {
      idempotencyKey: `advance-${roundId}`,
      expectedFrameRevision: opened.frame.revision,
    });
    expect(advanced.frame.wildUnits).toBe(4);
    let frame = advanced.frame;
    let step = 0;
    while (frame.state === 'STAGED') {
      const next = await service.advance(roundId, {
        idempotencyKey: `advance-terminal-${roundId}-${(step += 1)}`,
        expectedFrameRevision: frame.revision,
      });
      frame = next.frame;
    }

    const exposed = service.book(roundId);
    tryMutation(() => {
      (exposed.sideBetStakes as Record<string, bigint>).FIRST_LIGHT = 100_000_000n;
    });

    const settled = await service.settle(roundId, {
      idempotencyKey: `settle-${roundId}`,
      expectedFrameRevision: frame.revision,
    });
    expect(settled.value.stakedUnits).toBe(1_000_000n);
    expect(settled.value.proof.sideBetStakes).toEqual({});
    expect(settled.value.receipts.some((receipt) => receipt.line === 'FIRST_LIGHT')).toBe(false);
  });
});

describe('SWARM-02 — caller-owned commands are copied once', () => {
  it('uses one stake snapshot for the session limit, fingerprint and debit', async () => {
    const service = serviceFor();
    service.protection.set({ budgetUnits: '100000' });
    let reads = 0;
    const request = {
      idempotencyKey: 'hostile-open',
      expectedFrameRevision: 0,
      get stakeUnits(): bigint {
        reads += 1;
        return reads === 1 ? 100_000n : 1_000_000_000n;
      },
      sideBets: [],
      clientEntropy: ENTROPY,
    };
    const roundId = service.createRound().roundId;

    const opened = await service.open(roundId, request);

    expect(reads).toBe(1);
    expect(opened.receipts[0]?.amountUnits).toBe(100_000n);
    expect(service.wallet.stakedUnits).toBe(100_000n);
  });

  it('uses one proxied harvest value for the fingerprint and execution', async () => {
    const service = serviceFor();
    const { roundId, result: opened } = await openRound(service);
    const advanced = await service.advance(roundId, {
      idempotencyKey: `advance-${roundId}`,
      expectedFrameRevision: opened.frame.revision,
    });
    let unitsReads = 0;
    const hostile = new Proxy(
      {
        idempotencyKey: 'hostile-harvest',
        expectedFrameRevision: advanced.frame.revision,
        units: 1,
      },
      {
        get(target, property, receiver) {
          if (property === 'units') {
            unitsReads += 1;
            return unitsReads === 1 ? 1 : 2;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const first = await service.harvest(roundId, hostile);
    const retried = await service.harvest(roundId, {
      idempotencyKey: 'hostile-harvest',
      expectedFrameRevision: advanced.frame.revision,
      units: 1,
    });

    expect(unitsReads).toBe(1);
    expect(first.receipts[0]?.unitsHarvested).toBe(1);
    expect(first.frame.units).toBe(3);
    expect(retried).toEqual(first);
  });
});

describe('SWARM-04 — wallet posting is one transaction', () => {
  it('leaves every total unchanged when a later debit makes the batch invalid', () => {
    const wallet = new Wallet(100n);
    const receipts = [
      { direction: 'DEBIT', amountUnits: 40n },
      { direction: 'DEBIT', amountUnits: 70n },
    ] as Receipt[];

    expect(() => wallet.post(receipts)).toThrow();
    expect(wallet.balanceUnits).toBe(100n);
    expect(wallet.stakedUnits).toBe(0n);
    expect(wallet.creditedUnits).toBe(0n);
  });
});

interface HttpHarness {
  readonly app: App;
  readonly base: string;
  readonly clock: { now: number };
}

const openApps: App[] = [];

async function startHttp(): Promise<HttpHarness> {
  const clock = { now: 1_760_000_000_000 };
  const app = createApp({
    openingBalanceUnits: 2_000_000_000n,
    seedSource: () => SEED_A,
    roundIdSource: () => `http-hardening-${(roundCounter += 1)}`,
    clock: () => clock.now,
    pacing: ZERO_PACING,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  openApps.push(app);
  const port = (app.server.address() as AddressInfo).port;
  return { app, base: `http://127.0.0.1:${port}`, clock };
}

async function postJson(base: string, path: string, body: unknown = {}): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function getJson(base: string, path: string): Promise<any> {
  const response = await fetch(`${base}${path}`);
  return response.json();
}

afterEach(async () => {
  vi.useRealTimers();
  while (openApps.length > 0) {
    const app = openApps.pop() as App;
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

describe('SWARM-05 — exact retries do not become progress', () => {
  it('keeps the progress deadline fixed and returns the request’s recorded frame over HTTP', async () => {
    const { base, clock } = await startHttp();
    const created = await postJson(base, '/api/rounds');
    const roundId = created.roundId as string;
    const openBody = {
      idempotencyKey: 'http-open',
      expectedFrameRevision: 0,
      stakeUnits: '1000000',
      sideBets: [],
      clientEntropy: ENTROPY,
    };
    const opened = await postJson(base, `/api/rounds/${roundId}/open`, openBody);
    clock.now += 100;
    const advanceBody = {
      idempotencyKey: 'http-advance',
      expectedFrameRevision: opened.frame.revision,
    };
    const advanced = await postJson(base, `/api/rounds/${roundId}/advance`, advanceBody);
    clock.now += 100;
    const harvested = await postJson(base, `/api/rounds/${roundId}/harvest`, {
      idempotencyKey: 'http-harvest',
      expectedFrameRevision: advanced.frame.revision,
      units: 1,
    });
    const progressAt = (await getJson(base, `/api/rounds/${roundId}`)).lastCommandAt;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      clock.now += 10_000;
      const retried = await postJson(base, `/api/rounds/${roundId}/advance`, advanceBody);
      expect(retried.frame).toEqual(advanced.frame);
      expect(retried.frame).not.toEqual(harvested.frame);
      expect((await getJson(base, `/api/rounds/${roundId}`)).lastCommandAt).toBe(progressAt);
    }
  });
});

describe('SWARM-06 — server seed custody and uniqueness', () => {
  it('rejects a caller-controlled predictable seed source outside the test harness', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(
        () =>
          new RoundService({
            seedSource: () => SEED_A,
            pacing: ZERO_PACING,
          }),
      ).toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('reads a hostile seedSource getter once and regenerates an issued seed', () => {
    const candidates = [SEED_A, SEED_A, SEED_B];
    let getterReads = 0;
    let sourceCalls = 0;
    const service = new RoundService({
      openingBalanceUnits: 2_000_000_000n,
      get seedSource() {
        getterReads += 1;
        return () => candidates[sourceCalls++] as string;
      },
      roundIdSource: (counter) => `unique-seed-${counter}`,
      pacing: ZERO_PACING,
    });

    const first = service.createRound();
    const second = service.createRound();

    expect(getterReads).toBe(1);
    expect(sourceCalls).toBe(3);
    expect(first.seedCommitment).toBe(seedCommitment(SEED_A, first.roundId));
    expect(second.seedCommitment).toBe(seedCommitment(SEED_B, second.roundId));
  });
});

function bundleOf(settlement: Settlement): ProofBundle {
  return structuredClone({
    ...settlement.proof,
    receipts: settlement.receipts,
  }) as ProofBundle;
}

describe('SWARM-07 — verification binds the submitted receipt content', () => {
  it('fails closed when each meaningful money/transcript field is tampered independently', async () => {
    const { settlement } = await bankFixture(serviceFor(), [
      { id: 'FIRST_LIGHT', stakeUnits: 100_000n },
    ]);
    const honest = bundleOf(settlement);
    expect(verifyRound(honest).code).toBe('VERIFIED');
    const harvestAt = honest.receipts.findIndex((receipt) => receipt.kind === 'HARVEST');
    const settleAt = honest.receipts.findIndex((receipt) => receipt.kind === 'SETTLE');
    const sideBetAt = honest.receipts.findIndex((receipt) => receipt.kind === 'SIDE_BET');
    expect(harvestAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeGreaterThanOrEqual(0);
    expect(sideBetAt).toBeGreaterThanOrEqual(0);

    const cases: readonly [string, (proof: any) => void][] = [
      ['stakeUnits', (proof) => { proof.stakeUnits += 1n; }],
      ['sideBetStakes', (proof) => { proof.sideBetStakes.FIRST_LIGHT += 1n; }],
      ['action outcome', (proof) => { proof.actionLog[0].units -= 1; }],
      ['population', (proof) => { proof.populations[0] += 1; }],
      ['terminal', (proof) => { proof.terminal = 'FINAL'; }],
      ['settlement mode', (proof) => { proof.settlementMode = 'RECONCILED'; }],
      ['side-bet outcome', (proof) => { proof.sideBetResults[0].resolved = 'LOST'; }],
      ['receipt schema', (proof) => { proof.receipts[0].schema = 'receipt-v1'; }],
      ['receipt sequence', (proof) => { proof.receipts[0].sequence += 1; }],
      ['receipt kind', (proof) => { proof.receipts[0].kind = 'SETTLE'; }],
      ['receipt line', (proof) => { proof.receipts[0].line = 'FIRST_LIGHT'; }],
      ['receipt direction', (proof) => { proof.receipts[0].direction = 'CREDIT'; }],
      ['receipt stage', (proof) => { proof.receipts[harvestAt].stage += 1; }],
      ['receipt amount', (proof) => { proof.receipts[harvestAt].amountUnits += 1n; }],
      ['receipt unitsHarvested', (proof) => { proof.receipts[harvestAt].unitsHarvested -= 1; }],
      ['receipt resolved', (proof) => { proof.receipts[sideBetAt].resolved = 'LOST'; }],
      [
        'receipt theoretical',
        (proof) => { proof.receipts[harvestAt].theoretical.numerator += 1n; },
      ],
      ['receipt capped', (proof) => { proof.receipts[harvestAt].capped = true; }],
      ['receipt terminal', (proof) => { proof.receipts[settleAt].terminal = 'FINAL'; }],
    ];

    for (const [name, tamper] of cases) {
      const proof = structuredClone(honest) as any;
      tamper(proof);
      const result = verifyRound(proof);
      expect(result.ok, name).toBe(false);
      expect(result.code, name).not.toBe('VERIFIED');
    }
  });
});

describe('SWARM-08 — pacing belongs to the service, not its transport', () => {
  it('holds a direct service command until the decision floor has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    const service = serviceFor({
      pacing: {
        roundCycleMs: 0,
        decisionDeadPeriodMs: 350,
        settlementHoldMs: 0,
      },
    });
    const { roundId, result: opened } = await openRound(service);
    let resolved = false;
    const pending = Promise.resolve(
      service.advance(roundId, {
        idempotencyKey: `paced-advance-${roundId}`,
        expectedFrameRevision: opened.frame.revision,
      }),
    ).then((result) => {
      resolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(349);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).frame.stage).toBe(1);
  });
});
