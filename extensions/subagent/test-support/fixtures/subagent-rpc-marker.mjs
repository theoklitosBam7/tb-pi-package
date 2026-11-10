import * as fs from "node:fs";

export function waitForMarker(filePath, options = {}) {
  const { signal, timeoutMs = 30_000 } = options;
  if (fs.existsSync(filePath)) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve, reject) => {
    let settled = false;
    let interval;
    let timeout;

    const finish = (error, found) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(found);
    };

    const check = () => {
      if (fs.existsSync(filePath)) finish(undefined, true);
    };
    const onAbort = () => finish(undefined, false);

    interval = setInterval(check, 10);
    timeout = setTimeout(
      () => finish(new Error(`Timed out waiting for marker ${filePath}.`)),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}
