const { loadConfig } = require('../lib/config');
const { prepareHandoffBatches } = require('../lib/handoff');

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  const config = loadConfig();
  const prepared = prepareHandoffBatches(config, {
    latestOnly: hasFlag('--latest'),
  });

  console.log(JSON.stringify({
    preparedCount: prepared.length,
    batches: prepared,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
