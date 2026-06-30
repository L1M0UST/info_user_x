const { loadConfig } = require('../lib/config');
const { createPostgresStore } = require('../lib/postgres');

async function main() {
  const config = loadConfig();
  if (!config.database.enabled) {
    throw new Error('database.enabled is false in config.json');
  }

  const store = await createPostgresStore(config);
  if (!store) {
    throw new Error('Database initialization failed');
  }

  await store.close();
  console.log(JSON.stringify({
    initializedAt: new Date().toISOString(),
    database: config.database.database,
    schema: config.database.schema,
    host: config.database.host,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
