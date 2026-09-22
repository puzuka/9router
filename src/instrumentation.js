export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Periodic DB auto-backup must run from server boot, not from the first
    // page render (initializeApp): API-only deployments never render a page,
    // and a statically-prerendered /login serves from cache without evaluating
    // layout.js. Idempotent — also started from initializeApp; the global guard
    // keeps exactly one scheduler alive.
    const { startDbAutoBackup } = await import("@/lib/db/autoBackup.js");
    startDbAutoBackup();
  }
}
