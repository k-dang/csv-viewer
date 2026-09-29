import { vi } from 'vitest';

/** A Worker that never answers, so tests decide when it fails and observe its termination. */
export class ControllableWorker extends EventTarget implements Worker {
  onerror: Worker['onerror'] = null;
  onmessage: Worker['onmessage'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  emitError(error: Error): void {
    this.dispatchEvent(Object.assign(new Event('error'), { error, message: error.message }));
  }
}
