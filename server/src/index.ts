import { buildApp } from './app.ts';
import { config, describeConfig } from './lib/config.ts';
import { listMerchants } from './catalog/store.ts';

const app = buildApp();

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const base = config.publicOrigin || `http://localhost:${config.port}`;
  app.log.info('\u2014'.repeat(58));
  for (const line of describeConfig()) app.log.info(line);
  const merchants = listMerchants();
  app.log.info(`merchants ingested  ${merchants.length}`);
  for (const m of merchants) app.log.info(`  ${m.name} -> ${base}/mcp/${m.slug}`);
  app.log.info('\u2014'.repeat(58));
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
