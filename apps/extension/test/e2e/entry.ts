/**
 * The real background monitoring code, as the end-to-end harness drives it.
 *
 * Nothing here is a test double: the manager, sync engine, outbox, agent bridge
 * and inactivity policy are bundled exactly as the extension ships them. Only
 * their surroundings — chrome.*, IndexedDB, fetch, the native agent, the clock
 * — are simulated, by monitoring.e2e.test.mjs.
 */

export {
  configureMonitoringOffscreen,
  startMonitoringSession,
  stopMonitoringSession,
  pauseMonitoringSession,
  resumeMonitoringSession,
  loadMonitoringState,
  restoreMonitoringSession,
  handleMonitoringAlarm,
  handleMonitoringSyncAlarm,
} from '../../src/background/monitoring.manager';

import { stopSyncSweep } from '../../src/background/monitoring.sync';
import { disconnectNativeAgent } from '../../src/background/native-agent.manager';

/** Release timers so one scenario's worker cannot act inside the next. */
export function shutdownForTest(): void {
  stopSyncSweep();
  disconnectNativeAgent();
}
