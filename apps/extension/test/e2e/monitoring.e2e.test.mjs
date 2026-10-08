/**
 * End-to-end scenarios for screen monitoring.
 *
 * Runs the REAL background code — manager, sync engine, IndexedDB outbox, agent
 * bridge, inactivity policy — bundled exactly as shipped, against simulations of
 * everything around it:
 *
 *   clock      Date is replaced; scenarios move time explicitly.
 *   OS         last-input time, which `chrome.idle.queryState` reads.
 *   agent      a native agent process that samples that OS the way the Go agent
 *              does, sends frames and heartbeats, and can crash, restart, or
 *              lose an event.
 *   server     the monitoring API's session rules: one live session per user,
 *              idempotent start, expiry, late ingestion, heartbeat healing.
 *   chrome.*   storage, alarms, idle, native messaging, badge.
 *
 * Each scenario replays one way a report went wrong in production, or an edge
 * around it, and asserts on what the SERVER ends up holding — the numbers a
 * manager would read.
 *
 * Needs `fake-indexeddb` (Node has no IndexedDB). It is not a dependency of the
 * extension; point FAKE_INDEXEDDB at an install, or add it:
 *   pnpm add -D fake-indexeddb --filter @snaptrace/extension
 */

import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, mkdirSync } from 'fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const require = createRequire(import.meta.url);

// ─── Dependencies ─────────────────────────────────────────────────────────────

async function loadFakeIndexedDb() {
  const candidates = [process.env.FAKE_INDEXEDDB, 'fake-indexeddb'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const url = candidate.startsWith('/') ? pathToFileURL(resolve(candidate, 'build/esm/index.js')).href : candidate;
      return await import(url);
    } catch {
      /* try the next */
    }
  }
  return null;
}

const fakeIdb = await loadFakeIndexedDb();
if (!fakeIdb) {
  console.log('  SKIP monitoring end-to-end — fake-indexeddb is not installed (see the header of this file)');
  process.exit(0);
}

const esbuild = createRequire(require.resolve('vite'))('esbuild');

// ─── Bundle the real code ─────────────────────────────────────────────────────

const outDir = resolve(here, '..', '.build');
mkdirSync(outDir, { recursive: true });
const bundlePath = resolve(outDir, 'monitoring.e2e.bundle.mjs');

await esbuild.build({
  entryPoints: [resolve(here, 'entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: bundlePath,
  logLevel: 'error',
  define: {
    'import.meta.env': JSON.stringify({
      VITE_API_BASE_URL: 'http://api.test',
      VITE_RP_HOST: 'http://rp.test',
    }),
  },
  plugins: [
    {
      name: 'at-alias',
      setup(build) {
        build.onResolve({ filter: /^@\// }, async (args) => {
          const base = resolve(root, 'src', args.path.slice(2));
          for (const ext of ['.ts', '.tsx', '/index.ts']) {
            if (existsSync(base + ext)) return { path: base + ext };
          }
          return { path: base };
        });
      },
    },
  ],
});

// ─── Clock ────────────────────────────────────────────────────────────────────

const RealDate = Date;
const T0 = RealDate.parse('2026-09-18T04:00:00.000Z');
let NOW = T0;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(NOW);
    else super(...args);
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = FakeDate;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const iso = (ms) => new RealDate(ms).toISOString();

/** Let promises, fake IndexedDB and queued port messages run to completion. */
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

// ─── Simulated server ─────────────────────────────────────────────────────────

const THRESHOLD = 120;
const HEARTBEAT_TIMEOUT = 3 * 60 * 1000;
const DISCONNECTED_AFTER = 120 * 1000;

class FakeServer {
  constructor() {
    this.sessions = new Map();
    this.down = false;
    this.nextId = 1;
    // The sign-in server, which is what the extension must keep alive on its
    // own: tokens expire, refreshing rotates them, and an expired or unknown
    // token is answered with a plain 401.
    this.access = new Map(); // token -> expiry
    this.refreshable = new Set(); // refresh tokens still usable
    this.tokenLifetimeMs = 60 * MIN;
    this.ssoDown = false;
    this.requireAuth = true;
    this.refreshes = 0;
    this.unauthorized = 0;
    this.nextToken = 1;
    /** The sweeper runs every minute while the server is up. */
    this.sweeping = true;
    /** No expiry before this: a restarted server gives clients a full timeout to be heard. */
    this.graceUntil = 0;
  }

  /** MonitoringSessionExpiryJob. */
  sweep() {
    if (this.down || !this.sweeping || NOW < this.graceUntil) return;
    for (const s of this.sessions.values()) {
      const live = s.status === 'ACTIVE' || s.status === 'PAUSED';
      if (live && s.lastHeartbeatAt < NOW - HEARTBEAT_TIMEOUT) this.expire(s.id);
    }
  }

  /** Issue a fresh pair, as signing in does. */
  signIn() {
    const n = this.nextToken++;
    const accessToken = `access-${n}`;
    const refreshToken = `refresh-${n}`;
    this.access.set(accessToken, NOW + this.tokenLifetimeMs);
    this.refreshable.add(refreshToken);
    return { accessToken, refreshToken, expiresAt: NOW + this.tokenLifetimeMs };
  }

  /** Every sign-in is revoked — as a password change or a server restart does. */
  revokeSignIns() {
    this.access.clear();
    this.refreshable.clear();
  }

  tokenOf(init) {
    const header = init?.headers?.Authorization ?? init?.headers?.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
  }

  authorized(init) {
    if (!this.requireAuth) return true;
    const token = this.tokenOf(init);
    const expiry = token == null ? null : this.access.get(token);
    return expiry != null && expiry > NOW;
  }

  sso(init) {
    if (this.ssoDown) throw new TypeError('Failed to fetch');
    const body = new URLSearchParams(init?.body ?? '');
    const presented = body.get('refresh_token');
    if (!presented || !this.refreshable.has(presented)) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }
    // Rotation: the token just used stops working, which is what makes two
    // parts of the extension refreshing at once a race.
    this.refreshable.delete(presented);
    this.refreshes += 1;
    const next = this.signIn();
    return new Response(
      JSON.stringify({
        access_token: next.accessToken,
        refresh_token: next.refreshToken,
        expires_in: Math.round(this.tokenLifetimeMs / SEC),
      }),
      { status: 200 },
    );
  }

  /** The API process restarts after being down: its sweeper starts with a grace period. */
  restart() {
    this.down = false;
    this.graceUntil = NOW + HEARTBEAT_TIMEOUT;
  }

  totalSnapshots() {
    return [...this.sessions.values()].reduce((sum, s) => sum + s.snapshots.size, 0);
  }

  uuid() {
    const n = String(this.nextId++).padStart(12, '0');
    return `00000000-0000-4000-8000-${n}`;
  }

  resource(s) {
    return {
      id: s.id,
      startedAt: iso(s.startedAt),
      endedAt: s.endedAt == null ? null : iso(s.endedAt),
      durationSeconds: 0,
      pausedSeconds: 0,
      screenshotCount: s.snapshots.size,
      inactiveSeconds: this.inactiveSeconds(s.id),
      activityCount: s.activities.size,
      intervalSeconds: 30,
      status: s.status,
      lastHeartbeatAt: s.lastHeartbeatAt == null ? null : iso(s.lastHeartbeatAt),
      endReason: s.endReason ?? null,
    };
  }

  live() {
    return [...this.sessions.values()].find((s) => s.status === 'ACTIVE' || s.status === 'PAUSED');
  }

  seedLiveSession({ clientSessionId, startedAt, lastHeartbeatAt }) {
    const s = this.newSession(clientSessionId, startedAt);
    s.lastHeartbeatAt = lastHeartbeatAt;
    return s;
  }

  newSession(clientSessionId, startedAt) {
    const s = {
      id: this.uuid(),
      clientSessionId,
      status: 'ACTIVE',
      startedAt,
      endedAt: null,
      lastHeartbeatAt: NOW,
      periods: [],
      snapshots: new Set(),
      reservations: new Set(),
      activities: new Map(),
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** The sweeper: a live session silent for fifteen minutes ends at its last heartbeat. */
  /** POST /daily/{id}/stop — a manager stops a member: now, or at the last beat if silent. */
  adminStop(id) {
    const s = this.sessions.get(id);
    const silent = s.lastHeartbeatAt < NOW - DISCONNECTED_AFTER;
    s.endedAt = silent ? s.lastHeartbeatAt : NOW;
    s.status = 'COMPLETED';
    s.endReason = 'ADMIN';
    this.closeOpen(s, s.endedAt);
  }

  expire(id) {
    const s = this.sessions.get(id);
    s.status = 'EXPIRED';
    s.endReason = 'EXPIRED';
    s.endedAt = s.lastHeartbeatAt;
    this.closeOpen(s, s.endedAt);
  }

  openPeriod(s) {
    return s.periods.find((p) => p.end == null);
  }

  closeOpen(s, at) {
    const open = this.openPeriod(s);
    if (!open) return false;
    const end = Math.max(open.start, s.endedAt != null ? Math.min(at, s.endedAt) : at);
    if ((end - open.start) / SEC < THRESHOLD) s.periods.splice(s.periods.indexOf(open), 1);
    else open.end = end;
    return true;
  }

  inactiveSeconds(id) {
    const s = this.sessions.get(id);
    return s.periods.filter((p) => p.end != null).reduce((sum, p) => sum + (p.end - p.start) / SEC, 0);
  }

  acceptsLate(s) {
    return s.status === 'COMPLETED' || s.status === 'EXPIRED';
  }

  async fetch(url, init = {}) {
    const rawPath = new URL(url).pathname;
    if (rawPath.endsWith('/sso/oauth/token')) return this.sso(init);
    if (this.down) throw new TypeError('Failed to fetch');
    if (!this.authorized(init)) {
      this.unauthorized += 1;
      return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
    }
    const path = rawPath.replace(/^\/v1\/[^/]+\/monitoring/, '');
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const reply = (status, payload) =>
      new Response(status === 204 ? null : JSON.stringify(payload ?? {}), { status });
    const refuse = (status, code, detail) => reply(status, { message: `${code}: ${detail}` });

    if (path === '/start') {
      const existing = [...this.sessions.values()].find((s) => s.clientSessionId === body.clientSessionId);
      if (existing) return reply(200, this.startResponse(existing));
      let live = this.live();
      // A live session whose client has gone silent is taken over, not refused.
      if (live && live.lastHeartbeatAt < NOW - DISCONNECTED_AFTER) {
        this.expire(live.id);
        live = this.live();
      }
      if (live) {
        return refuse(409, 'MONITORING_ALREADY_ACTIVE',
          `session ${live.id} is already running on this project; stop it first`);
      }
      const started = body.startedAt ? Date.parse(body.startedAt) : NOW;
      return reply(200, this.startResponse(this.newSession(body.clientSessionId, started)));
    }

    const match = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return reply(404, { message: 'not found' });
    const s = this.sessions.get(match[1]);
    if (!s) return refuse(404, 'MONITORING_SESSION_NOT_FOUND', 'no such session');
    const action = match[2] ?? '';
    const isLive = s.status === 'ACTIVE' || s.status === 'PAUSED';
    const notActive = () => refuse(406, 'MONITORING_SESSION_NOT_ACTIVE', `session is ${s.status}`);

    switch (action) {
      case '':
        return reply(200, this.resource(s));
      case '/heartbeat': {
        if (!isLive) return notActive();
        s.lastHeartbeatAt = NOW;
        if (body.idle === false && this.openPeriod(s)) {
          const hint = body.lastActivityAt ? Date.parse(body.lastActivityAt) : null;
          const open = this.openPeriod(s);
          this.closeOpen(s, hint != null && hint > open.start && hint < NOW ? hint : NOW);
          this.healed = (this.healed ?? 0) + 1;
        }
        return reply(202, this.resource(s));
      }
      case '/stop': {
        const requested = body.endedAt ? Date.parse(body.endedAt) : NOW;
        if (s.status === 'EXPIRED') {
          // Re-settle: never shorter, always COMPLETED.
          s.endedAt = Math.max(s.endedAt, Math.min(requested, NOW));
          s.status = 'COMPLETED';
          s.endReason = 'CLIENT';
          return reply(200, {});
        }
        if (!isLive) return reply(200, {});
        s.endedAt = Math.max(s.startedAt, Math.min(requested, NOW));
        s.status = 'COMPLETED';
        s.endReason = 'CLIENT';
        this.closeOpen(s, s.endedAt);
        return reply(200, {});
      }
      case '/pause':
        if (!isLive) return notActive();
        this.closeOpen(s, Date.parse(body.at));
        s.status = 'PAUSED';
        return reply(200, this.resource(s));
      case '/resume':
        if (s.status !== 'PAUSED') return isLive ? reply(200, this.resource(s)) : notActive();
        s.status = 'ACTIVE';
        return reply(200, this.resource(s));
      case '/inactivity/start': {
        if (!isLive && !this.acceptsLate(s)) return notActive();
        const start = Date.parse(body.startedAt);
        if (s.endedAt != null && start > s.endedAt) return notActive();
        if (start < s.startedAt) return refuse(400, 'MONITORING_INVALID_PERIOD', 'before the session');
        if (!this.openPeriod(s)) s.periods.push({ start, end: null });
        return reply(201, {});
      }
      case '/inactivity/end': {
        if (!isLive && !this.acceptsLate(s)) return notActive();
        if (!this.openPeriod(s)) {
          // The period the sweeper cut at the last heartbeat is carried on to the real end.
          const requested = Date.parse(body.endedAt);
          const cut = !isLive && s.periods.find((p) => p.end === s.lastHeartbeatAt);
          if (cut && requested > cut.end) {
            cut.end = s.endedAt != null ? Math.min(requested, s.endedAt) : requested;
            return reply(200, {});
          }
          return refuse(404, 'MONITORING_INACTIVITY_NOT_FOUND', 'nothing open');
        }
        this.closeOpen(s, Date.parse(body.endedAt));
        return reply(200, {});
      }
      case '/activities/batch': {
        if (!isLive && !this.acceptsLate(s)) return notActive();
        // Bean validation, as the real API does it: one over-long field refuses
        // the whole batch with a plain 400 and no monitoring code.
        const tooLong = body.activities.find((a) => (a.url?.length ?? 0) > 2048 || (a.pageTitle?.length ?? 0) > 1024);
        if (tooLong) return reply(400, { errorCode: 4001, message: "Incorrect Request. [Field 'activities[0].url' should have size from 0 to 2048.]" });
        let accepted = 0, duplicates = 0;
        for (const a of body.activities) {
          if (s.activities.has(a.clientActivityId)) duplicates++;
          else { s.activities.set(a.clientActivityId, a); accepted++; }
        }
        return reply(200, { accepted, duplicates, rejected: 0, errors: [] });
      }
      case '/snapshots/upload-url': {
        if (!isLive && !this.acceptsLate(s)) return notActive();
        if (s.snapshots.has(body.clientSnapshotId)) {
          return refuse(409, 'MONITORING_DUPLICATE_SNAPSHOT', 'already uploaded');
        }
        if (s.endedAt != null && Date.parse(body.capturedAt) > s.endedAt) return notActive();
        s.reservations.add(body.clientSnapshotId);
        return reply(201, {
          snapshotId: body.clientSnapshotId,
          uploadUrl: null,
          storageKey: `k/${body.clientSnapshotId}`,
          expiresAt: iso(NOW + 10 * MIN),
          uploadMethod: 'POST',
          uploadStrategy: 'PROXY',
        });
      }
      case '/snapshots/complete':
        if (!isLive && !this.acceptsLate(s)) return notActive();
        if (!s.reservations.has(body.clientSnapshotId)) {
          return refuse(404, 'MONITORING_SNAPSHOT_NOT_FOUND', 'no reservation');
        }
        s.snapshots.add(body.clientSnapshotId);
        return reply(200, {});
      default:
        if (/^\/snapshots\/[^/]+\/content$/.test(action)) {
          if (!isLive && !this.acceptsLate(s)) return notActive();
          return reply(204);
        }
        return reply(404, { message: `unhandled ${action}` });
    }
  }

  startResponse(s) {
    return {
      session: this.resource(s),
      dailyReport: { id: 'report-1' },
      inactivityThresholdSeconds: THRESHOLD,
    };
  }
}

// ─── Simulated OS + native agent ──────────────────────────────────────────────

class FakeOs {
  constructor() {
    this.lastInputAt = NOW;
    this.working = true;
    /**
     * After a wake-up the person's first keypress comes a little later. Until
     * then the OS idle counter still includes the whole time asleep — which is
     * what a real machine reports, and what the agent samples first.
     */
    this.inputResumesAt = 0;
  }
  idleSeconds() {
    return Math.max(0, (NOW - this.lastInputAt) / SEC);
  }
}

/**
 * One native agent process at a time, launched by connectNative the way Chrome
 * does. A new process knows nothing of the previous one — which is exactly how
 * an open idle period used to be forgotten.
 */
class FakeAgent {
  constructor(env) {
    this.env = env;
    this.installed = true;
    this.link = null;
    this.dropIdleEnds = false;
    this.launches = 0;
  }

  connect() {
    if (!this.installed) {
      const link = this.makeLink();
      queueMicrotask(() => {
        this.env.chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
        link.disconnectListeners.forEach((f) => f());
        this.env.chrome.runtime.lastError = undefined;
      });
      return link.port;
    }
    this.launches++;
    this.link = this.makeLink();
    this.process = { session: null, paused: false, idle: false, idleSince: null, countFrom: NOW, threshold: THRESHOLD };
    return this.link.port;
  }

  makeLink() {
    const link = { messageListeners: new Set(), disconnectListeners: new Set(), open: true };
    link.port = {
      postMessage: (msg) => {
        if (!link.open) throw new Error('port closed');
        queueMicrotask(() => this.receive(msg));
      },
      disconnect: () => {
        link.open = false;
        if (this.link === link) this.link = null;
      },
      onMessage: { addListener: (f) => link.messageListeners.add(f) },
      onDisconnect: { addListener: (f) => link.disconnectListeners.add(f) },
    };
    return link;
  }

  send(msg) {
    const link = this.link;
    if (!link || !link.open) return;
    queueMicrotask(() => link.messageListeners.forEach((f) => f({ protocolVersion: 1, ...msg })));
  }

  receive(msg) {
    const p = this.process;
    switch (msg.type) {
      case 'HELLO':
        this.send({
          type: 'READY',
          agentVersion: '1.0.0',
          platform: 'darwin',
          architecture: 'arm64',
          capabilities: {
            foregroundApplication: true, windowTitle: true, processIdentifier: true,
            browserProfile: true, idleDetection: true, screenCapture: true,
          },
          permissions: { accessibility: true, screenRecording: true },
        });
        return;
      case 'START_MONITORING':
        if (p.session !== msg.sessionId) {
          if (p.session && p.idle) this.emitIdleEnd();
          p.session = msg.sessionId;
          p.idle = false;
          p.countFrom = NOW;
        }
        if (msg.idleThresholdSeconds) p.threshold = msg.idleThresholdSeconds;
        this.send({ type: 'STARTED', sessionId: msg.sessionId });
        return;
      case 'STOP_MONITORING':
        if (p.idle) this.emitIdleEnd();
        p.session = null;
        this.send({ type: 'STOPPED' });
        return;
      case 'PAUSE_MONITORING':
        if (p.idle) this.emitIdleEnd();
        p.paused = true;
        this.send({ type: 'PAUSED' });
        return;
      case 'RESUME_MONITORING':
        p.paused = false;
        p.countFrom = NOW;
        this.send({ type: 'RESUMED' });
        return;
      case 'FLUSH':
        this.send({ type: 'FLUSHED' });
        return;
      default:
    }
  }

  /** The Go IdleTracker's rule, against the simulated OS. */
  sample() {
    const p = this.process;
    if (!this.link || !p?.session || p.paused) return;
    const idleFor = this.env.os.idleSeconds();
    if (!p.idle && idleFor >= p.threshold) {
      p.idle = true;
      p.idleSince = Math.max(NOW - idleFor * SEC, p.countFrom);
      this.send({ type: 'IDLE_CHANGED', idle: true, idleStartedAt: iso(p.idleSince) });
    } else if (p.idle && idleFor < p.threshold) {
      this.emitIdleEnd();
    }
  }

  emitIdleEnd() {
    const p = this.process;
    p.idle = false;
    if (this.dropIdleEnds) return;
    this.send({
      type: 'IDLE_CHANGED', idle: false, idleStartedAt: iso(p.idleSince), idleEndedAt: iso(NOW),
      idleSeconds: Math.round((NOW - p.idleSince) / SEC),
    });
  }

  frame() {
    if (!this.link || !this.process?.session || this.process.paused) return;
    this.framesSent = (this.framesSent ?? 0) + 1;
    this.send({
      type: 'SCREEN_FRAME',
      frame: { mimeType: 'image/jpeg', data: Buffer.from('frame').toString('base64'), bytes: 5,
        width: 10, height: 10, capturedAt: iso(NOW), displayCount: 1 },
    });
  }

  heartbeat() {
    this.send({ type: 'HEARTBEAT' });
  }

  /** The process dies; Chrome tells the extension the port closed. */
  crash() {
    const link = this.link;
    if (!link) return;
    link.open = false;
    this.link = null;
    this.env.chrome.runtime.lastError = { message: 'Native host has exited.' };
    link.disconnectListeners.forEach((f) => f());
    this.env.chrome.runtime.lastError = undefined;
  }
}

// ─── Simulated chrome.* ───────────────────────────────────────────────────────

function makeChrome(env) {
  const store = env.store;
  const idleListeners = env.idleListeners;
  return {
    runtime: {
      lastError: undefined,
      id: 'test-extension',
      sendMessage: () => Promise.resolve(),
      connectNative: () => env.agent.connect(),
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const key of [].concat(keys ?? [])) {
            if (store.has(key)) out[key] = structuredClone(store.get(key));
          }
          return out;
        },
        set: async (items) => {
          for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value));
        },
        remove: async (keys) => {
          for (const key of [].concat(keys)) store.delete(key);
        },
      },
    },
    alarms: {
      create: async (name, options) => void env.alarms.set(name, options),
      clear: async (name) => env.alarms.delete(name),
      get: async (name) => (env.alarms.has(name) ? { name } : undefined),
    },
    idle: {
      queryState: async (seconds) => (env.os.idleSeconds() >= seconds ? 'idle' : 'active'),
      setDetectionInterval: () => {},
      onStateChanged: {
        addListener: (f) => idleListeners.add(f),
        removeListener: (f) => idleListeners.delete(f),
        hasListener: (f) => idleListeners.has(f),
      },
    },
    action: {
      setBadgeText: async ({ text }) => {
        env.badge = text;
      },
      setBadgeBackgroundColor: async () => {},
    },
    tabs: { query: async () => [] },
  };
}

// ─── Scenario environment ─────────────────────────────────────────────────────

let scenarioCount = 0;

async function environment({ store, server, keepClock = false } = {}) {
  if (!keepClock) NOW = T0;
  const env = {
    store: store ?? new Map(),
    alarms: new Map(),
    idleListeners: new Set(),
    server: server ?? new FakeServer(),
  };
  env.os = new FakeOs();
  env.agent = new FakeAgent(env);
  env.chrome = makeChrome(env);
  // Signed in, as the person is before they start monitoring. Carried over
  // when a scenario reuses a store, so a restarted worker keeps its sign-in.
  if (!env.store.has('st_auth_tokens')) {
    env.store.set('st_auth_tokens', env.server.signIn());
  }
  env.signIn = () => env.store.set('st_auth_tokens', env.server.signIn());
  env.tokens = () => env.store.get('st_auth_tokens') ?? null;
  globalThis.chrome = env.chrome;
  globalThis.indexedDB = new fakeIdb.IDBFactory();
  globalThis.IDBKeyRange = fakeIdb.IDBKeyRange;
  // The device's own connectivity: offline, `navigator.onLine` is false and no
  // request leaves the machine.
  env.online = true;
  Object.defineProperty(globalThis, 'navigator', {
    value: { get onLine() { return env.online; } },
    configurable: true,
    writable: true,
  });
  globalThis.fetch = (url, init) =>
    env.online ? env.server.fetch(url, init) : Promise.reject(new TypeError('Failed to fetch'));
  env.setOnline = (online) => { env.online = online; };
  env.badge = '';
  env.recording = false;

  // A fresh module instance per scenario: its own in-memory worker state, as
  // a fresh service worker would have.
  env.worker = await import(`${pathToFileURL(bundlePath).href}?scenario=${++scenarioCount}`);
  env.worker.configureMonitoringOffscreen({
    ensureDocument: async () => {},
    send: async () => {},
    isRecording: () => env.recording,
  });
  await env.worker.restoreMonitoringSession();
  await settle();

  env.state = () => env.worker.loadMonitoringState();

  env.start = async () => {
    const result = await env.worker.startMonitoringSession({ intervalSeconds: 30, project: 'bestq' });
    await settle();
    return result;
  };
  env.stop = async () => {
    const result = await env.worker.stopMonitoringSession();
    await settle();
    return result;
  };

  /**
   * Let `ms` of simulated time pass: the person works or not, the agent samples
   * every 5s and sends a frame and heartbeat every 30s, and the minute alarms fire.
   */
  env.advance = async (ms) => {
    const end = NOW + ms;
    while (NOW < end) {
      NOW = Math.min(NOW + 5 * SEC, end);
      if (env.os.working && NOW >= env.os.inputResumesAt) env.os.lastInputAt = NOW;
      env.agent.sample();
      if ((NOW - T0) % (30 * SEC) === 0) {
        env.agent.frame();
        env.agent.heartbeat();
      }
      await settle(4);
      if ((NOW - T0) % MIN === 0) {
        env.server.sweep();
        await env.worker.handleMonitoringAlarm();
        await env.worker.handleMonitoringSyncAlarm();
        await settle();
      }
    }
    await settle();
  };

  /**
   * The machine is not running anything for `ms` — asleep, lid shut, powered off.
   * No ticks, no agent samples; the server's sweeper keeps running.
   */
  env.jump = async (ms) => {
    const end = NOW + ms;
    while (NOW < end) {
      NOW = Math.min(NOW + MIN, end);
      env.server.sweep();
    }
    // Waking is not input: the counter keeps the time asleep until the first keypress.
    env.os.inputResumesAt = NOW + 20 * SEC;
    await settle();
  };

  env.session = (id) => env.server.sessions.get(id);
  env.shutdown = () => env.worker.shutdownForTest();
  return env;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
async function scenario(name, run) {
  let env;
  try {
    env = await run();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`);
  } finally {
    try {
      (env ?? globalThis.__lastEnv)?.shutdown();
    } catch {
      /* ignore */
    }
  }
}
const ok = (cond, message) => { if (!cond) throw new Error(message ?? 'expected true'); };
const near = (actual, expected, tolerance, what) =>
  ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} not within ${tolerance} of ${expected}`);
const minutes = (seconds) => Math.round((seconds / 60) * 10) / 10;
/** Inactive minutes across every session on the server, with the periods, for failure messages. */
const inactiveReport = (server) => {
  const total = [...server.sessions.values()].reduce((sum, s) => sum + server.inactiveSeconds(s.id), 0);
  const detail = [...server.sessions.values()].map((s) =>
    `${s.id.slice(-3)}[${s.status}/${s.endReason ?? '-'} ${((s.startedAt - T0) / MIN).toFixed(1)}→${s.endedAt == null ? 'live' : ((s.endedAt - T0) / MIN).toFixed(1)}] ` +
    s.periods.map((p) => `${((p.start - T0) / MIN).toFixed(1)}→${p.end == null ? 'open' : ((p.end - T0) / MIN).toFixed(1)}`).join(','),
  ).join(' | ');
  return { minutes: minutes(total), detail };
};

// ─── Issue 1: working, but reported inactive ──────────────────────────────────

await scenario('agent restarts during an idle period; person then works 3h → not inactive for 3h', async () => {
  const env = await environment();
  const { sessionId } = await env.start();
  await env.advance(10 * MIN);
  env.os.working = false;
  await env.advance(10 * MIN); // away; agent opens a period
  ok(env.server.openPeriod(env.session(sessionId)), 'the idle period should be open on the server');
  env.agent.crash(); // e.g. killed by a stale-heartbeat check after sleep
  env.os.working = true;
  await new Promise((r) => setTimeout(r, 1200)); // the extension's 1s reconnect
  await env.advance(3 * HOUR);
  await env.stop();
  const inactive = env.server.inactiveSeconds(sessionId);
  ok(env.agent.launches >= 2, 'the agent should have been relaunched');
  near(minutes(inactive), 10, 2, 'inactive minutes');
  return env;
});

await scenario('the agent loses every "idle ended" event → inactivity still ends when input resumes', async () => {
  const env = await environment();
  const { sessionId } = await env.start();
  env.agent.dropIdleEnds = true;
  for (let i = 0; i < 3; i++) {
    await env.advance(20 * MIN);
    env.os.working = false;
    await env.advance(8 * MIN);
    env.os.working = true;
  }
  await env.advance(60 * MIN);
  await env.stop();
  near(minutes(env.server.inactiveSeconds(sessionId)), 3 * 8, 4, 'inactive minutes over three absences');
  return env;
});

await scenario('chrome.idle opens a period while the agent is gone; agent returns; the "active" is lost', async () => {
  const env = await environment();
  const { sessionId } = await env.start();
  await env.advance(5 * MIN);
  env.agent.installed = false;
  env.agent.crash(); // agent gone for a while
  await settle();
  env.os.working = false;
  await env.advance(3 * MIN);
  for (const listener of env.idleListeners) listener('idle'); // chrome.idle crosses its threshold
  await settle();
  ok(env.server.openPeriod(env.session(sessionId)), 'chrome.idle should have opened a period');
  env.agent.installed = true; // agent comes back and owns detection again
  env.os.working = true; // …and the "active" event never arrives
  await new Promise((r) => setTimeout(r, 2500));
  await env.advance(2 * HOUR);
  await env.stop();
  ok(minutes(env.server.inactiveSeconds(sessionId)) <= 5,
    `inactive ${minutes(env.server.inactiveSeconds(sessionId))} min for a person who worked 2h`);
  return env;
});

await scenario('genuine absences are still recorded, back-dated to the last input', async () => {
  const env = await environment();
  const { sessionId } = await env.start();
  await env.advance(20 * MIN);
  env.os.working = false;
  await env.advance(30 * MIN);
  env.os.working = true;
  await env.advance(20 * MIN);
  await env.stop();
  const s = env.session(sessionId);
  near(minutes(env.server.inactiveSeconds(sessionId)), 30, 1, 'inactive minutes');
  near((s.periods[0].start - T0) / MIN, 20, 0.2, 'period start (minutes into the session)');
  return env;
});

await scenario('the server heals a period the client no longer has open (heartbeat idle=false)', async () => {
  const env = await environment();
  const { sessionId } = await env.start();
  await env.advance(5 * MIN);
  // A period the client knows nothing about — e.g. re-opened by a midnight split.
  env.session(sessionId).periods.push({ start: NOW - MIN, end: null });
  await env.advance(3 * MIN);
  ok(!env.server.openPeriod(env.session(sessionId)), 'the orphaned period should be closed by a heartbeat');
  ok(env.server.healed >= 1, 'healed through the heartbeat');
  return env;
});

await scenario('pause while idle closes the period at the pause; resume starts clean', async () => {
  const env = await environment();
  const { sessionId } = await env.start();
  await env.advance(5 * MIN);
  env.os.working = false;
  await env.advance(10 * MIN);
  await env.worker.pauseMonitoringSession();
  await settle();
  await env.advance(30 * MIN); // paused: not monitored, not inactive
  env.os.working = true;
  await env.worker.resumeMonitoringSession();
  await settle();
  await env.advance(20 * MIN);
  await env.stop();
  near(minutes(env.server.inactiveSeconds(sessionId)), 10, 1, 'inactive minutes');
  return env;
});

// ─── Issue 2: stopped, started again, nothing recorded ────────────────────────

await scenario('stop then start immediately → a new session that really records', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(5 * MIN);
  await env.stop();
  const second = await env.start();
  ok(second.status === 'monitoring', `status ${second.status}: ${second.error}`);
  ok(second.sessionId && second.sessionId !== first.sessionId, 'a new server session');
  ok(env.session(first.sessionId).status === 'COMPLETED', 'the first session is completed');
  await env.advance(5 * MIN);
  const s = env.session(second.sessionId);
  ok(s.snapshots.size >= 8, `only ${s.snapshots.size} screenshots in the new session`);
  return env;
});

await scenario('stop while the server is down, start once it is back → old settled at the stop time, new records', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(10 * MIN);
  env.server.down = true;
  const stopWall = RealDate.now();
  const stopAt = NOW;
  const stopped = await env.stop();
  ok(stopped.status === 'idle', `status after stop: ${stopped.status}`);
  ok(RealDate.now() - stopWall < 20_000, 'stop must not hang on a dead server');
  await env.advance(3 * MIN);
  env.server.down = false;
  const second = await env.start();
  ok(second.status === 'monitoring' && second.sessionId, `start after recovery: ${second.status} ${second.error}`);
  const old = env.session(first.sessionId);
  ok(old.status === 'COMPLETED', `old session is ${old.status}`);
  near((old.endedAt - stopAt) / SEC, 0, 1, 'old session end vs. the real stop (s)');
  await env.advance(3 * MIN);
  ok(env.session(second.sessionId).snapshots.size >= 4, 'the new session records');
  return env;
});

await scenario('start while another browser is still heartbeating → latest start wins, the other settled at its last beat', async () => {
  const env = await environment();
  const other = env.server.seedLiveSession({
    clientSessionId: 'other-browser', startedAt: T0 - 2 * HOUR, lastHeartbeatAt: T0 - 60 * SEC,
  });
  const started = await env.start();
  ok(started.status === 'monitoring' && started.sessionId !== other.id, `start: ${started.status} ${started.error}`);
  ok(env.session(other.id).status === 'COMPLETED', `the other session is ${env.session(other.id).status}`);
  near((env.session(other.id).endedAt - (T0 - 60 * SEC)) / SEC, 0, 1, 'other session end vs its last heartbeat (s)');
  return env;
});

await scenario('the server refuses and cannot be settled → idle with a message, never "monitoring" without a session', async () => {
  const env = await environment();
  const live = env.server.seedLiveSession({ clientSessionId: 'x', startedAt: T0 - HOUR, lastHeartbeatAt: T0 });
  const realFetch = env.server.fetch.bind(env.server);
  // Stop requests fail: the conflict cannot be resolved.
  env.server.fetch = (url, init) => (url.endsWith('/stop') ? Promise.reject(new TypeError('Failed to fetch')) : realFetch(url, init));
  const started = await env.start();
  ok(started.status === 'idle', `status ${started.status}`);
  ok(!started.sessionId, 'no session id');
  ok(started.error, 'an error message is shown');
  ok(env.session(live.id).status === 'ACTIVE');
  return env;
});

await scenario('worker torn down mid-stop → the next worker finishes the stop', async () => {
  const first = await environment();
  const { sessionId } = await first.start();
  await first.advance(5 * MIN);
  // The worker dies: nothing of it runs again.
  first.shutdown();
  await settle(200);
  const store = new Map([...first.store].map(([k, v]) => [k, structuredClone(v)]));
  // It died after persisting 'stopping' and before finishing.
  store.set('st_monitoring_state', { ...store.get('st_monitoring_state'), status: 'stopping' });
  const second = await environment({ store, server: first.server, keepClock: true });
  const server = second.server;
  await settle(200);
  await new Promise((r) => setTimeout(r, 300));
  await settle(200);
  const state = await second.state();
  ok(state.status === 'idle', `status ${state.status}`);
  ok(server.sessions.get(sessionId).status === 'COMPLETED', 'the stop reached the server');
  return second;
});

await scenario('persisted "monitoring" with no session id is reset on restore', async () => {
  const store = new Map([['st_monitoring_state', { status: 'monitoring', sessionId: null, project: 'bestq' }]]);
  const env = await environment({ store });
  const state = await env.state();
  ok(state.status === 'idle', `status ${state.status}`);
  ok(state.error, 'explains itself');
  return env;
});

// ─── Auto-stop after an hour of inactivity ────────────────────────────────────

await scenario('an hour without input stops the session at the hour, with a notice', async () => {
  const env = await environment();
  const { sessionId } = await env.start();
  await env.advance(10 * MIN);
  const lastInput = NOW;
  env.os.working = false;
  await env.advance(75 * MIN);
  const state = await env.state();
  ok(state.status === 'idle', `status ${state.status}`);
  ok(/inactivity/i.test(state.stopNotice ?? ''), `notice: ${state.stopNotice}`);
  const s = env.session(sessionId);
  ok(s.status === 'COMPLETED');
  near((s.endedAt - lastInput) / MIN, 60, 1.5, 'session end (minutes after the last input)');
  near(minutes(env.server.inactiveSeconds(sessionId)), 60, 1.5, 'inactive minutes');
  return env;
});

await scenario('59 minutes away then back → keeps monitoring', async () => {
  const env = await environment();
  await env.start();
  env.os.working = false;
  await env.advance(58 * MIN);
  env.os.working = true;
  await env.advance(10 * MIN);
  ok((await env.state()).status === 'monitoring');
  return env;
});

await scenario('a stale open period (lost end) never triggers the auto-stop for a working person', async () => {
  const env = await environment();
  await env.start();
  env.agent.dropIdleEnds = true;
  env.os.working = false;
  await env.advance(5 * MIN);
  env.os.working = true;
  await env.advance(90 * MIN);
  ok((await env.state()).status === 'monitoring', 'auto-stopped a working person');
  return env;
});

await scenario('start again after an auto-stop → a fresh session, notice cleared', async () => {
  const env = await environment();
  const first = await env.start();
  env.os.working = false;
  await env.advance(62 * MIN);
  ok((await env.state()).status === 'idle');
  env.os.working = true;
  const second = await env.start();
  ok(second.status === 'monitoring' && second.sessionId !== first.sessionId);
  ok(second.stopNotice == null, 'notice cleared');
  return env;
});

// ─── Client disappears: heartbeat, timeout, recovery, cleanup ─────────────────

/**
 * Chrome, the extension and the agent all die at once — laptop shut down,
 * system restart, browser crash, extension force-closed. Returns the next
 * worker, started on the same storage when the machine comes back after `awayMs`.
 */
async function machineGone(env, awayMs) {
  env.agent.crash();
  env.shutdown();
  await settle(200);
  const store = new Map([...env.store].map(([k, v]) => [k, structuredClone(v)]));
  await env.jump(awayMs);
  const next = await environment({ store, server: env.server, keepClock: true });
  next.agent.framesSent = env.agent.framesSent;
  await settle(200);
  await new Promise((r) => setTimeout(r, 300));
  await settle(200);
  return next;
}

await scenario('internet lost while working → stops within ~2 min, ends where capture did; nothing refused or stuck', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(10 * MIN);
  const lostAt = NOW;
  env.setOnline(false);
  await env.advance(3 * MIN);
  const state = await env.state();
  ok(state.status === 'idle', `status ${state.status} three minutes after the network went`);
  ok(/lost its internet connection/.test(state.stopNotice ?? ''), `notice: ${state.stopNotice}`);
  env.setOnline(true);
  await env.advance(10 * MIN); // back online: queued data and the stop go up
  const old = env.session(first.sessionId);
  ok(old.status === 'COMPLETED', `session ${old.status}`);
  // Not at the moment the network went: at the moment monitoring really
  // stopped. The minute in between was worked and captured, and ending the
  // session before it is what used to have the server refuse those frames.
  ok(old.endedAt >= lostAt, 'the end is not before the loss');
  near((old.endedAt - lostAt) / MIN, 1.5, 1.5, 'session end vs the network loss (min)');
  ok(env.server.sessions.size === 1, 'no new session was started by itself');
  ok(env.session(first.sessionId).snapshots.size >= 19, 'everything from before the loss was uploaded');
  const after = await env.state();
  ok(after.queuedSnapshots + after.pendingSyncItems === 0,
    `still "uploading": ${after.queuedSnapshots} screenshots, ${after.pendingSyncItems} records`);
  // The session ends where contact was lost, but the machine went on capturing
  // for the minute it took to notice. That minute is real work, so the end
  // covers it and the server takes it — it used to be refused and dropped.
  ok(after.failedSnapshots === 0, `${after.failedSnapshots} screenshots refused after the stop`);
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  ok(inactiveReport(env.server).minutes === 0, inactiveReport(env.server).detail);
  const again = await env.start();
  ok(again.status === 'monitoring' && again.sessionId !== first.sessionId, 'starts again normally');
  return env;
});

await scenario('network switch (Wi-Fi → hotspot, 40 s offline) → same session, nothing lost', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(5 * MIN);
  env.setOnline(false);
  await env.advance(40 * SEC);
  env.setOnline(true);
  await env.advance(8 * MIN);
  const state = await env.state();
  ok(state.status === 'monitoring' && state.sessionId === first.sessionId, `${state.status}`);
  ok(env.session(first.sessionId).status === 'ACTIVE');
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  return env;
});

await scenario('laptop shut down for 3 h → server expires it within minutes; on boot the session ends at shutdown; start works', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(30 * MIN);
  const shutdownAt = NOW;
  env.agent.crash();
  env.shutdown();
  await settle(200);
  // The server does not wait for the client to come back.
  await env.jump(7 * MIN);
  ok(env.session(first.sessionId).status === 'EXPIRED', `after 7 min: ${env.session(first.sessionId).status}`);
  const next = await machineGone(env, 3 * HOUR);
  const state = await next.state();
  ok(state.status === 'idle', `status on boot ${state.status}`);
  ok(/off, asleep or not running Chrome/.test(state.stopNotice ?? ''), `notice ${state.stopNotice}`);
  const old = next.session(first.sessionId);
  near((old.endedAt - shutdownAt) / MIN, 0, 1.5, 'session end vs shutdown (min)');
  const idle2 = inactiveReport(next.server);
  ok(idle2.minutes === 0, `worked until shutdown, yet ${idle2.minutes} min inactive: ${idle2.detail}`);
  const started = await next.start();
  ok(started.status === 'monitoring' && started.sessionId !== first.sessionId, `start: ${started.error}`);
  return next;
});

await scenario('laptop asleep 20 min → server ends it within minutes; on wake monitoring stays stopped', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(15 * MIN);
  const sleptAt = NOW;
  await env.jump(5 * MIN);
  ok(env.session(first.sessionId).status === 'EXPIRED', `after 5 min asleep: ${env.session(first.sessionId).status}`);
  await env.jump(15 * MIN);
  await env.advance(3 * MIN);
  const state = await env.state();
  ok(state.status === 'idle', `status on wake ${state.status}`);
  ok(/offline, asleep or switched off/.test(state.stopNotice ?? ''), `notice ${state.stopNotice}`);
  ok(env.server.sessions.size === 1, 'no new session was started by itself');
  near((env.session(first.sessionId).endedAt - sleptAt) / MIN, 0, 1.5, 'session end vs sleep (min)');
  const after = await env.state();
  ok(after.queuedSnapshots + after.pendingSyncItems === 0, 'nothing left "uploading"');
  return env;
});

await scenario('Chrome crash or restart, back within 2 min → the same session carries on', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(10 * MIN);
  const next = await machineGone(env, 2 * MIN);
  await next.advance(5 * MIN);
  const state = await next.state();
  ok(state.status === 'monitoring' && state.sessionId === first.sessionId, `${state.status} ${state.sessionId}`);
  ok(next.session(first.sessionId).status === 'ACTIVE');
  ok(next.session(first.sessionId).snapshots.size >= 28, 'frames keep arriving after the restart');
  return next;
});

await scenario('browser closed 40 min, reopened → the session was ended; monitoring stays stopped', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(10 * MIN);
  const closedAt = NOW;
  const next = await machineGone(env, 40 * MIN);
  await next.advance(3 * MIN);
  const state = await next.state();
  ok(state.status === 'idle', `${state.status}`);
  ok(next.server.sessions.size === 1, 'no new session was started by itself');
  near((next.session(first.sessionId).endedAt - closedAt) / MIN, 0, 1.5, 'session end vs close (min)');
  return next;
});

await scenario('extension data lost (reinstalled) while the server still shows the old session live → start works', async () => {
  const env = await environment();
  const orphan = env.server.seedLiveSession({ clientSessionId: 'lost', startedAt: T0 - HOUR, lastHeartbeatAt: T0 - 3 * MIN });
  const started = await env.start();
  ok(started.status === 'monitoring' && started.sessionId !== orphan.id, `start: ${started.error}`);
  ok(env.session(orphan.id).status !== 'ACTIVE', 'the orphan is no longer live');
  near((env.session(orphan.id).endedAt - (T0 - 3 * MIN)) / SEC, 0, 1, 'orphan ends at its last heartbeat (s)');
  return env;
});

await scenario('backend down 30 min, then restarted → no mass expiry; same session; backlog delivered', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(5 * MIN);
  env.server.down = true;
  await env.advance(30 * MIN);
  env.server.restart();
  await env.advance(25 * MIN);
  const state = await env.state();
  ok(state.sessionId === first.sessionId, 'the same session continued');
  ok(env.session(first.sessionId).status === 'ACTIVE', env.session(first.sessionId).status);
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  return env;
});

await scenario('stop while offline; the server expires it meanwhile; back online → settled at the real stop; start works', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(10 * MIN);
  const realFetch = env.server.fetch.bind(env.server);
  env.server.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  await env.advance(2 * MIN);
  const stopAt = NOW;
  const stopped = await env.stop();
  ok(stopped.status === 'idle');
  await env.jump(10 * MIN);
  ok(env.session(first.sessionId).status === 'EXPIRED');
  env.server.fetch = realFetch;
  await env.worker.handleMonitoringSyncAlarm();
  await settle(100);
  await env.worker.handleMonitoringSyncAlarm();
  await settle(100);
  const old = env.session(first.sessionId);
  ok(old.status === 'COMPLETED', `old ${old.status}`);
  near((old.endedAt - stopAt) / SEC, 0, 60, 'old end vs the real stop (s)');
  const again = await env.start();
  ok(again.status === 'monitoring' && again.sessionId, `start: ${again.error}`);
  return env;
});

await scenario('no heartbeat for hours with Chrome running but asleep → never stays live on the server', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(5 * MIN);
  await env.jump(6 * HOUR);
  ok(env.session(first.sessionId).status === 'EXPIRED', env.session(first.sessionId).status);
  await env.advance(2 * MIN); // wakes: over the limit, so it ends rather than resumes
  const state = await env.state();
  ok(state.status === 'idle', `status ${state.status}`);
  ok(!env.server.live(), 'nothing left live on the server');
  return env;
});

// ─── Inactivity across a disconnect: active time stays active ─────────────────

await scenario('Wi-Fi drops while working → the session ends at the drop, with no inactivity', async () => {
  const env = await environment();
  await env.start();
  await env.advance(15 * MIN);
  env.setOnline(false);
  await env.advance(20 * MIN);
  env.setOnline(true);
  await env.advance(10 * MIN);
  const idle = inactiveReport(env.server);
  ok(idle.minutes === 0, `${idle.minutes} min inactive for someone who worked: ${idle.detail}`);
  return env;
});

await scenario('laptop lid closed 20 min, opened, work → the sleep is not inactivity and work is active', async () => {
  const env = await environment();
  await env.start();
  await env.advance(30 * MIN);
  await env.jump(20 * MIN);
  await env.advance(15 * MIN);
  await env.stop();
  const idle = inactiveReport(env.server);
  ok(idle.minutes <= 1, `${idle.minutes} min inactive: ${idle.detail}`);
  return env;
});

await scenario('laptop lid closed 40 min, opened, work → no inactivity', async () => {
  const env = await environment();
  await env.start();
  await env.advance(30 * MIN);
  await env.jump(40 * MIN);
  await env.advance(15 * MIN);
  await env.stop();
  const idle = inactiveReport(env.server);
  ok(idle.minutes <= 1, `${idle.minutes} min inactive: ${idle.detail}`);
  return env;
});

await scenario('laptop shut down after 1 h of work, back 30 min later → first session has no inactivity', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(60 * MIN);
  const next = await machineGone(env, 30 * MIN);
  next.os.inputResumesAt = NOW + 20 * SEC;
  await next.advance(10 * MIN);
  await next.stop();
  ok(next.server.inactiveSeconds(first.sessionId) === 0, inactiveReport(next.server).detail);
  const idle = inactiveReport(next.server);
  ok(idle.minutes <= 1, `${idle.minutes} min inactive: ${idle.detail}`);
  return next;
});

await scenario('idle, then Wi-Fi drops while still idle → inactive up to the drop, the session ends there', async () => {
  const env = await environment();
  await env.start();
  await env.advance(15 * MIN);
  env.os.working = false;
  await env.advance(5 * MIN);
  env.setOnline(false);
  await env.advance(5 * MIN);
  env.os.working = true;
  env.setOnline(true);
  await env.advance(10 * MIN);
  const idle = inactiveReport(env.server);
  // Idle from 15 until the session ended at the loss (seen at the next minute tick).
  near(idle.minutes, 6, 1.5, `inactive minutes (${idle.detail})`);
  return env;
});

await scenario('walks away (idle), laptop sleeps 30 min, wakes, agent restarted, works 1 h → only the real idle', async () => {
  const env = await environment();
  await env.start();
  await env.advance(30 * MIN);
  env.os.working = false;
  await env.advance(6 * MIN); // idle period opens (threshold 2 min)
  await env.jump(30 * MIN); // lid closes
  env.os.working = true;
  env.agent.crash(); // the old stale-heartbeat check killed it on wake
  await new Promise((r) => setTimeout(r, 1200));
  await env.advance(60 * MIN);
  await env.stop();
  const idle = inactiveReport(env.server);
  // Idle from 30 min until the lid closed at 36 — not the sleep, not the hour of work after.
  near(idle.minutes, 6, 1.5, `inactive minutes (${idle.detail})`);
  return env;
});

// ─── Uploads that never finished; the MON badge ───────────────────────────────

await scenario('a page with a very long URL and title does not hold up its batch', async () => {
  const env = await environment();
  await env.start();
  await env.advance(MIN);
  await env.worker.noteActivePage({ id: 1, url: 'https://jira.example.com/browse/X?' + 'q'.repeat(5000), title: 't'.repeat(3000) });
  await env.advance(MIN);
  await env.worker.noteActivePage({ id: 2, url: 'https://example.com/other', title: 'Other' });
  await env.advance(3 * MIN);
  const state = await env.state();
  const rows = [...[...env.server.sessions.values()][0].activities.values()];
  ok(rows.some((a) => a.url?.startsWith('https://jira.example.com') && a.url.length === 2048), 'the long row landed, trimmed');
  ok(state.pendingSyncItems === 0, `${state.pendingSyncItems} activity records still "uploading"`);
  return env;
});

await scenario('MON shows while monitoring, survives a recording, and clears when stopped', async () => {
  const env = await environment();
  await env.start();
  await env.advance(MIN);
  ok(env.badge === 'MON', `badge "${env.badge}" while monitoring`);
  env.recording = true; // a screen recording starts and shows REC
  env.badge = 'REC';
  await env.advance(2 * MIN);
  ok(env.badge === 'REC', `the minute tick overwrote the recording badge: "${env.badge}"`);
  env.recording = false; // recording ends: index.ts calls refreshMonitoringBadge()
  await env.worker.refreshMonitoringBadge();
  ok(env.badge === 'MON', `badge "${env.badge}" after the recording ended`);
  await env.stop();
  ok(env.badge === '', `badge "${env.badge}" after stopping`);
  return env;
});

// MON is the only thing most people look at, so it gets a case per way a
// session can end — and one for a session that is open but capturing nothing.

await scenario('MON goes when the agent dies, and comes back when it does', async () => {
  const env = await environment();
  await env.start();
  await env.advance(2 * MIN);
  ok(env.badge === 'MON', `badge "${env.badge}" while capturing`);

  env.agent.crash(); // nothing is being captured from here
  await env.advance(3 * MIN);
  ok(env.badge !== 'MON', `badge still "${env.badge}" with no agent and no frames`);

  await new Promise((r) => setTimeout(r, 1200)); // the extension relaunches it
  await env.advance(3 * MIN);
  ok(env.badge === 'MON', `badge "${env.badge}" once frames are landing again`);
  return env;
});

await scenario('every way a session can end clears MON', async () => {
  // The user stops.
  let env = await environment();
  await env.start();
  await env.advance(2 * MIN);
  ok(env.badge === 'MON');
  await env.stop();
  ok(env.badge === '', `after a stop: "${env.badge}"`);
  env.shutdown();

  // An hour with no input.
  env = await environment();
  await env.start();
  await env.advance(2 * MIN);
  env.os.working = false;
  await env.advance(62 * MIN);
  ok((await env.state()).status === 'idle', 'the hour should have ended it');
  ok(env.badge === '', `after an auto-stop: "${env.badge}"`);
  env.shutdown();

  // The network goes.
  env = await environment();
  await env.start();
  await env.advance(2 * MIN);
  env.setOnline(false);
  await env.advance(3 * MIN);
  ok(env.badge === '', `after losing the network: "${env.badge}"`);
  env.shutdown();

  // An administrator stops it.
  env = await environment();
  const admin = await env.start();
  await env.advance(2 * MIN);
  env.server.adminStop(admin.sessionId);
  await env.advance(3 * MIN);
  ok(env.badge === '', `after an administrator stop: "${env.badge}"`);
  return env;
});

await scenario('a worker that died mid-session shows no MON for a session that ended meanwhile', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(5 * MIN);
  ok(env.badge === 'MON');
  // The machine goes off with MON on the toolbar; the server expires the
  // session while it is away; Chrome comes back.
  const next = await machineGone(env, 20 * MIN);
  next.badge = 'MON'; // what the toolbar still shows from before
  await next.worker.restoreMonitoringSession();
  await settle(100);
  await next.advance(2 * MIN);
  ok(next.session(first.sessionId).status !== 'ACTIVE', 'the session should be over');
  ok((await next.state()).status === 'idle', `status ${(await next.state()).status}`);
  ok(next.badge === '', `badge "${next.badge}" after coming back to an ended session`);
  return next;
});

await scenario('signed out, still capturing → the toolbar asks for a sign-in, nothing is lost', async () => {
  const env = await environment();
  await env.start();
  await env.advance(5 * MIN);
  env.server.revokeSignIns();
  await env.advance(20 * MIN);

  // Monitoring is genuinely running and frames are genuinely being captured;
  // they are queued rather than uploaded. From the outside such a session looks
  // completely normal, so the badge stops saying MON and asks for the one thing
  // only a person can do.
  ok(env.badge !== 'MON', 'a signed-out session still looked like a healthy one');
  ok(env.badge === 'LOG', `badge "${env.badge}" while signed out`);
  const state = await env.state();
  ok(state.queuedSnapshots > 20, `only ${state.queuedSnapshots} screenshots kept`);
  ok(state.failedSnapshots === 0, `${state.failedSnapshots} thrown away`);
  ok(state.status === 'monitoring', `monitoring stopped at sign-out: ${state.status}`);
  return env;
});

await scenario('the agent drops mid-session → capture resumes by itself, and says so meanwhile', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(5 * MIN);
  const before = env.agent.framesSent;

  env.agent.crash(); // the native port dies, as it does on Windows
  await env.advance(2 * MIN);
  const during = await env.state();
  ok(during.status === 'monitoring', `the session ended over a dropped agent: ${during.status}`);
  ok(during.capture.status !== 'active', `capture still claims to be working: ${during.capture.status}`);
  ok(
    !/install/i.test(during.capture.error ?? ''),
    `told to reinstall an agent that was working: ${during.capture.error}`,
  );

  await new Promise((r) => setTimeout(r, 1200)); // the extension relaunches it
  await env.advance(5 * MIN);

  const after = await env.state();
  ok(after.capture.status === 'active', `capture did not resume by itself: ${after.capture.status}`);
  ok(env.agent.framesSent > before, 'no frames after the agent came back');
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  ok(env.session(first.sessionId).status === 'ACTIVE', 'the session should still be live');
  return env;
});

// ─── An administrator stops a member's monitoring ─────────────────────────────

await scenario('admin stops a member while they work → extension stops within a minute and does not restart', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(10 * MIN);
  env.server.adminStop(first.sessionId);
  await env.advance(3 * MIN); // frames and the heartbeat both meet the closed session
  const state = await env.state();
  ok(state.status === 'idle', `status ${state.status}`);
  ok(/administrator/i.test(state.stopNotice ?? ''), `notice ${state.stopNotice}`);
  ok(env.server.sessions.size === 1, `${env.server.sessions.size} sessions — it restarted itself`);
  ok(env.session(first.sessionId).endReason === 'ADMIN');
  await env.advance(10 * MIN);
  ok(!env.server.live(), 'still nothing live ten minutes later');
  const again = await env.start();
  ok(again.status === 'monitoring' && again.sessionId !== first.sessionId, 'the member can start again');
  return env;
});

await scenario('admin clears a member whose laptop is off → ends at the last beat; the laptop does not resume it', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(10 * MIN);
  const lastBeat = env.session(first.sessionId).lastHeartbeatAt;
  env.agent.crash();
  env.shutdown();
  await settle(200);
  await env.jump(3 * MIN); // off, but not yet expired
  env.server.adminStop(first.sessionId);
  near((env.session(first.sessionId).endedAt - lastBeat) / SEC, 0, 1, 'ends at the last heartbeat (s)');
  const next = await machineGone(env, 20 * MIN); // back within the hour: would normally recover
  await next.advance(2 * MIN);
  const state = await next.state();
  ok(state.status === 'idle', `status ${state.status}`);
  ok(next.server.sessions.size === 1, `${next.server.sessions.size} sessions — it resumed itself`);
  return next;
});

// ─── The server expired it: which of the two actually went away ───────────────
//
// An expiry only says the server stopped hearing this machine. If the machine
// was asleep, off or unplugged, nobody was being monitored and monitoring ends
// where it stopped — the laptop, sleep and browser-closed scenarios above. If
// the machine kept running and only the path to the server broke, the work was
// real and everything from it is queued, so it is kept.

await scenario('the server is unreachable for an hour while the laptop works on → the hour is kept, nothing refused', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(60 * MIN);
  const reachable = env.server.fetch.bind(env.server);
  env.server.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  await env.advance(60 * MIN); // still working; the sweeper expires the session meanwhile
  ok(env.session(first.sessionId).status === 'EXPIRED', env.session(first.sessionId).status);
  env.server.fetch = reachable;
  await env.advance(60 * MIN); // reachable again, and still working

  const state = await env.state();
  ok(state.status === 'monitoring', `status ${state.status}`);
  ok(state.failedSnapshots === 0, `${state.failedSnapshots} screenshots refused`);
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  const monitored = [...env.server.sessions.values()]
    .reduce((sum, s) => sum + ((s.endedAt ?? NOW) - s.startedAt), 0);
  near(monitored / MIN, 180, 2, 'monitored minutes across the sessions');
  const idle = inactiveReport(env.server);
  ok(idle.minutes === 0, `worked throughout, yet ${idle.minutes} min inactive: ${idle.detail}`);
  return env;
});

await scenario('an expiry while this machine is demonstrably alive → it carries on in a successor session', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(5 * MIN);
  env.server.expire(first.sessionId);
  await env.advance(3 * MIN);
  const state = await env.state();
  ok(state.status === 'monitoring', `status ${state.status}`);
  ok(state.sessionId && state.sessionId !== first.sessionId, 'a successor session took over');
  const old = env.session(first.sessionId);
  ok(old.status === 'COMPLETED', `the expired session was re-settled, not left ${old.status}`);
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  return env;
});

await scenario('an expiry after this machine went quiet → monitoring ends, and is not resumed', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(5 * MIN);
  const next = await machineGone(env, 10 * MIN); // off: the sweeper expires it meanwhile
  ok(next.session(first.sessionId).status === 'EXPIRED', next.session(first.sessionId).status);
  await next.advance(2 * MIN);
  const state = await next.state();
  ok(state.status === 'idle', `${state.status}`);
  ok(next.server.sessions.size === 1, 'no new session was started by itself');
  return next;
});

// ─── The sign-in ──────────────────────────────────────────────────────────────
//
// Monitoring runs in a service worker nobody is watching, for hours. A sign-in
// that lapses there is invisible until a day's work is sitting in the outbox
// being refused, so these cover the whole life of a token: expiring on time,
// expiring while the sign-in server is unreachable, and being revoked outright.

await scenario('the access token expires twice during a shift → it refreshes itself, nothing is refused', async () => {
  const env = await environment();
  env.server.tokenLifetimeMs = 45 * MIN;
  const first = await env.start();
  const firstToken = env.tokens().accessToken;
  await env.advance(3 * HOUR);

  const state = await env.state();
  ok(state.status === 'monitoring', `status ${state.status}`);
  ok(state.sessionId === first.sessionId, 'the same session ran throughout');
  ok(env.server.refreshes >= 3, `only ${env.server.refreshes} refreshes in three hours`);
  ok(env.tokens().accessToken !== firstToken, 'the stored sign-in was renewed');
  ok(state.failedSnapshots === 0, `${state.failedSnapshots} screenshots refused`);
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  ok(env.session(first.sessionId).status === 'ACTIVE', env.session(first.sessionId).status);
  return env;
});

await scenario('the sign-in server is down for an hour while the token expires → nothing is lost, and the hour is kept', async () => {
  const env = await environment();
  env.server.tokenLifetimeMs = 20 * MIN;
  const first = await env.start();
  await env.advance(30 * MIN);
  env.server.ssoDown = true;
  await env.advance(60 * MIN); // token expires, every call 401s, the sweeper expires the session
  const during = await env.state();
  ok(during.status === 'monitoring', `monitoring stopped during the outage: ${during.status}`);
  ok(during.queuedSnapshots > 50, `only ${during.queuedSnapshots} screenshots were kept`);
  ok(during.failedSnapshots === 0, `${during.failedSnapshots} refused while signed out`);

  env.server.ssoDown = false;
  await env.advance(45 * MIN); // signs itself back in, then catches up

  const state = await env.state();
  ok(state.status === 'monitoring', `status ${state.status}`);
  ok(state.failedSnapshots === 0, `${state.failedSnapshots} screenshots refused`);
  ok(state.queuedSnapshots === 0, `${state.queuedSnapshots} screenshots still queued`);
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  const monitored = [...env.server.sessions.values()]
    .reduce((sum, s) => sum + ((s.endedAt ?? NOW) - s.startedAt), 0);
  near(monitored / MIN, 135, 3, 'monitored minutes across the sessions');
  return env;
});

await scenario('the sign-in is revoked → monitoring keeps capturing, and it all uploads after signing in again', async () => {
  const env = await environment();
  const first = await env.start();
  await env.advance(20 * MIN);
  env.server.revokeSignIns(); // password changed, or the sign-in server forgot us
  await env.advance(40 * MIN);

  const out = await env.state();
  ok(out.status === 'monitoring', `monitoring stopped when the sign-in went: ${out.status}`);
  ok(out.queuedSnapshots > 50, `only ${out.queuedSnapshots} screenshots were kept`);
  ok(out.failedSnapshots === 0, `${out.failedSnapshots} refused with no sign-in`);
  ok(env.tokens() == null, 'a revoked sign-in is cleared, so the popup asks for one');

  env.signIn(); // the person signs in again
  await env.advance(45 * MIN);
  const state = await env.state();
  ok(state.queuedSnapshots === 0, `${state.queuedSnapshots} screenshots still queued`);
  ok(state.failedSnapshots === 0, `${state.failedSnapshots} screenshots refused`);
  ok(env.server.totalSnapshots() === env.agent.framesSent,
    `${env.server.totalSnapshots()} stored of ${env.agent.framesSent} captured`);
  return env;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
