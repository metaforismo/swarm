/**
 * `npm run dev` — the whole thing, locally.
 *
 * Serves the round service on `/api` and the graybox client from `src/client`.
 * Free play only: the wallet is in memory, the seeds are `node:crypto` bytes with
 * no custody worth the name, and nothing here is a real-money deployment. See
 * `docs/MATH.md` §15 for what one would need.
 *
 * Environment:
 *   PORT                          default 8787
 *   HOST                          default 127.0.0.1
 *   SWARM_OPENING_CREDITS         free-play opening balance, default 1000
 *   SWARM_ABANDON_TIMEOUT_HOURS   the §5.5 abandonment clock, default 72
 *   SWARM_REALITY_CHECK_MINUTES   the §9.9 reality check, default 30
 *   SWARM_LIMIT_COOLOFF_HOURS     wait before a *loosened* limit binds, default 24
 *
 * The last two are here so a reviewer can watch the §9.9 surfaces work inside one
 * sitting instead of waiting half an hour. The speed-of-play floors of §9.7 are
 * deliberately **not** configurable from the environment: a floor an operator can
 * switch off is not a floor.
 */
import { createRequire } from 'node:module';
import { SWARM, adapterFingerprint } from './adapter.ts';
import { ENGINE_API_VERSION } from './engine.ts';
import { createApp } from './http.ts';
import { LIMIT_COOL_OFF_HOURS, REALITY_CHECK_MINUTES } from './protection.ts';

const enginePackage = createRequire(import.meta.url)('@axiom-games/reveal-engine/package.json') as {
  name: string;
  version: string;
};

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const openingCredits = BigInt(process.env.SWARM_OPENING_CREDITS ?? '1000');
const timeoutHours = Number(
  process.env.SWARM_ABANDON_TIMEOUT_HOURS ?? SWARM.lifecycle.abandonedRoundTimeoutHours,
);

const realityCheckMinutes = Number(process.env.SWARM_REALITY_CHECK_MINUTES ?? REALITY_CHECK_MINUTES);
const limitCoolOffHours = Number(process.env.SWARM_LIMIT_COOLOFF_HOURS ?? LIMIT_COOL_OFF_HOURS);

const { server, service } = createApp({
  openingBalanceUnits: openingCredits * SWARM.money.unitsPerCredit,
  abandonedRoundTimeoutHours: timeoutHours,
  realityCheckMinutes,
  limitCoolOffHours,
});

server.listen(port, host, () => {
  process.stdout.write(
    [
      `SWARM graybox — ${SWARM.id} @ ${SWARM.adapterVersion}`,
      // Two identities, never one line: the first is SWARM's own module contract
      // (docs/ENGINE.md), implemented in src/server/; the second is the engine
      // package this repository imports its primitives from. Printing them as one
      // string reads as a conformance claim, and it would not be true.
      `  adapter contract    : ${SWARM.apiVersion} (specified and implemented here)`,
      `  engine package      : ${enginePackage.name} ${enginePackage.version} (${ENGINE_API_VERSION})`,
      `  adapter fingerprint : ${adapterFingerprint()}`,
      `  free-play balance   : ${openingCredits} credits`,
      `  abandonment timeout : ${timeoutHours} h`,
      `  speed-of-play floors: ${service.pacer.floors.roundCycleMs} / ${service.pacer.floors.decisionDeadPeriodMs} / ${service.pacer.floors.settlementHoldMs} ms (cycle / dead period / settlement hold)`,
      `  reality check       : every ${realityCheckMinutes} min · limit cool-off ${limitCoolOffHours} h`,
      `  listening           : http://${host}:${port}`,
      '',
    ].join('\n'),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
