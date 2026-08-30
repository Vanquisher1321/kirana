import { buildApp } from './app.ts';
import { config, describeConfig } from './lib/config.ts';
import { listMerchants } from './catalog/store.ts';
import { startReconciler } from './checkout/reconcile.ts';
import { seedDemoStore } from './cli/seed.ts';

const app = buildApp();

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const base = config.publicOrigin || `http://localhost:${config.port}`;
  app.log.info('\u2014'.repeat(58));
  for (const line of describeConfig()) app.log.info(line);
  // A public host with no persistent disk starts empty after every cold start.
  // Seeding on boot means the link is never a blank page for whoever opens it.
  if (listMerchants().length === 0) {
    try {
      const seeded = await seedDemoStore();
      app.log.info(`seeded demo shop     ${seeded.productCount} products (database was empty)`);
    } catch (err) {
      app.log.warn(`could not seed the demo shop: ${(err as Error).message}`);
    }
  }

  const merchants = listMerchants();
  app.log.info(`merchants ingested  ${merchants.length}`);
  for (const m of merchants) app.log.info(`  ${m.name} -> ${base}/mcp/${m.slug}`);
  if (config.razorpay.configured) {
    startReconciler();
    app.log.info('reconciler          sweeping unsettled orders every 20s (webhooks optional)');
  }
  app.log.info('\u2014'.repeat(58));
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
