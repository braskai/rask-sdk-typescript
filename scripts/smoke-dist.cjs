const sdk = require('@braskai/rask-sdk');

import('./smoke-checks.mjs')
  .then(({ runSmoke }) => runSmoke(sdk, `cjs node ${process.version}`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
