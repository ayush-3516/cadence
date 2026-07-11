// Test-only stand-in for Ponder's virtual "ponder:registry" module, which
// only resolves inside Ponder's own dev/build runtime. Handler modules call
// `ponder.on(...)` at import time purely to register callbacks with that
// runtime; for unit tests we only care about the exported handler
// functions, so a no-op `on` is sufficient to let the module load under
// plain vitest (see apps/indexer/vitest.config.ts).
export const ponder = {
  on: (_name: string, _handler: unknown) => {},
};
