/**
 * `npm run dev` — the whole thing, locally.
 *
 * Serves the round service on `/api` and the graybox client from `src/client`.
 * Free play only: the wallet is in memory, the seeds are `node:crypto` bytes with
 * no custody worth the name, and nothing here is a real-money deployment. See
 * `docs/MATH.md` §15 for what one would need.
 *
 * Environment:
 *   PORT                         default 8787
 *   HOST                         default 127.0.0.1
 *   SWARM_OPENING_CREDITS        free-play opening balance, default 1000
 *   SWARM_ABANDON_TIMEOUT_HOURS  the §5.5 abandonment clock, default 72
 */
import { SWARM, adapterFingerprint } from './adapter.ts';
import { createApp } from './http.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const openingCredits = BigInt(process.env.SWARM_OPENING_CREDITS ?? '1000');
const timeoutHours = Number(
  process.env.SWARM_ABANDON_TIMEOUT_HOURS ?? SWARM.lifecycle.abandonedRoundTimeoutHours,
);

const { server } = createApp({
  openingBalanceUnits: openingCredits * SWARM.money.unitsPerCredit,
  abandonedRoundTimeoutHours: timeoutHours,
});

server.listen(port, host, () => {
  process.stdout.write(
    [
      `SWARM graybox — ${SWARM.id} @ ${SWARM.adapterVersion} on ${SWARM.apiVersion}`,
      `  adapter fingerprint : ${adapterFingerprint()}`,
      `  free-play balance   : ${openingCredits} credits`,
      `  abandonment timeout : ${timeoutHours} h`,
      `  listening           : http://${host}:${port}`,
      '',
    ].join('\n'),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
