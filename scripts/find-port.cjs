const net = require('net');

// Preferred port from argv (api prefers 3001, web prefers 3000); fallback
// pool start is argv[3] — keep the two pools disjoint so concurrently
// resolved ports can never collide (a probe-then-bind race otherwise lets
// both servers pick the same port).
const PREFERRED = parseInt(process.argv[2], 10) || 3000;
const FALLBACK_START = parseInt(process.argv[3], 10) || PREFERRED;
const MAX_ATTEMPTS = 100;

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main() {
  if (!(await isPortInUse(PREFERRED))) {
    console.log(String(PREFERRED));
    return;
  }

  for (let port = FALLBACK_START; port < FALLBACK_START + MAX_ATTEMPTS; port++) {
    if (!(await isPortInUse(port))) {
      console.log(String(port));
      return;
    }
  }

  console.error(`Could not find an available port in [${PREFERRED}] or ${FALLBACK_START}..${FALLBACK_START + MAX_ATTEMPTS - 1}`);
  process.exit(1);
}

main();
