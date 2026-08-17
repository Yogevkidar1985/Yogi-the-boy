/**
 * In-process event bus: lets the worker notify the API layer (SSE broadcast)
 * without a circular import. In single-service deployments (RUN_WORKER=1)
 * both sides live in one process; in split deployments the DB heartbeat is
 * the fallback signal.
 */
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

/** Live engine heartbeat, updated by the worker, read by /api/live-status. */
export const liveState: {
  lastTickAt: string | null;
  nextTickAt: string | null;
  lastRefreshAt: string | null;
} = { lastTickAt: null, nextTickAt: null, lastRefreshAt: null };
