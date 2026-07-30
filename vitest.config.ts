import { defineConfig } from 'vitest/config';

/**
 * The suite re-derives the whole paytable by exhaustive enumeration and
 * cross-checks it against 20,000-round seeded simulations, so individual tests
 * legitimately run for seconds. The default 5 s timeout is a statement about
 * ordinary unit tests and it is wrong for these — under load it fails a test that
 * is working, which is the worst kind of red.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{mjs,ts}'],
    // Exact BigInt enumeration and seeded Monte Carlo checks are proof work,
    // not latency assertions. Keep their workload intact and allow completion
    // when this checkout shares a host with other CPU-bound verification jobs.
    // The 25-minute ceiling is over 3x a 480.6 s contended paytable proof.
    testTimeout: 1_500_000,
    hookTimeout: 60_000,
    // Exact-enumeration files saturate the host. Serial file execution keeps
    // wall-clock pacing tests meaningful without changing a single assertion,
    // timeout, seed, simulation round count or enumerated state.
    fileParallelism: false,
  },
});
