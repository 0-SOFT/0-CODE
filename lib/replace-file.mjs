// Keep replacement atomic when a Windows reader briefly opens without delete sharing.
import { renameSync } from 'node:fs';

const pause = new Int32Array(new SharedArrayBuffer(4));
const temporaryWindowsErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function retryWindowsFileOperation(operation, { validate = () => {}, timeoutMs = 1000, retryCodes = temporaryWindowsErrors } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid file replacement timeout');
  const recoverable=new Set(retryCodes);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    // A path may have changed while waiting. Validation failures are never retried.
    validate();
    try { return operation(); }
    catch (error) {
      const remaining = deadline - performance.now();
      if (process.platform !== 'win32' || !recoverable.has(error.code) || remaining <= 0) throw error;
      Atomics.wait(pause, 0, 0, Math.min(25, remaining));
    }
  }
}
export function replaceFileSync(staging,destination,options={}) {
  return retryWindowsFileOperation(()=>renameSync(staging,destination),options);
}
