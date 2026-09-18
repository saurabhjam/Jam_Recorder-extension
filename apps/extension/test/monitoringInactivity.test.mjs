/**
 * Tests for inactivity and auto-stop decisions.
 *
 * The property that must hold above all: a person who is using the machine is
 * never reported inactive for more than one reconcile interval (a minute),
 * whatever happened to the idle events — lost, duplicated, out of order, from a
 * restarted agent, or from two sources at once.
 *
 * Run with `npm run test`.
 */

import {
  INACTIVITY_POLICY,
  probeLadder,
  idleBoundsFromProbes,
  agentIdleStarted,
  idleEnded,
  browserIdleChanged,
  reconcileInactivity,
  autoStopAt,
  parseLiveSessionId,
  agentHeartbeatStale,
  awayStopAt,
  offlineStopAt,
} from './.build/monitoringInactivity.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
  throw new Error(`${m ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
const ok = (cond, m) => { if (!cond) throw new Error(m ?? 'expected true'); };

const T0 = Date.parse('2026-09-18T04:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const iso = (ms) => new Date(ms).toISOString();
const THRESHOLD = 120;
const fresh = (overrides = {}) => ({ openSince: null, pendingSince: null, notBefore: iso(T0), ...overrides });

/** What `chrome.idle.queryState` would answer for someone idle `idleSeconds`. */
const osBounds = (idleSeconds) =>
  idleBoundsFromProbes(
    probeLadder(THRESHOLD, 3600).map((intervalSeconds) => ({
      intervalSeconds,
      state: idleSeconds < intervalSeconds ? 'active' : 'idle',
    })),
  );

// ── Reading the OS ──
t('probe ladder includes the threshold and the auto-stop limit, sorted, floor 15', () => {
  const ladder = probeLadder(100, 5400);
  ok(ladder.includes(100) && ladder.includes(5400));
  eq(ladder[0], 15);
  eq([...ladder].sort((a, b) => a - b), ladder);
});

t('bounds: input moments ago', () => eq(osBounds(3), { minSeconds: 0, maxSeconds: 15 }));
t('bounds: idle 20s', () => eq(osBounds(20), { minSeconds: 15, maxSeconds: 30 }));
t('bounds: idle over the top rung', () => eq(osBounds(7200), { minSeconds: 3600, maxSeconds: null }));
t('bounds: locked counts as idle', () =>
  eq(idleBoundsFromProbes([{ intervalSeconds: 15, state: 'locked' }, { intervalSeconds: 30, state: 'active' }]),
     { minSeconds: 15, maxSeconds: 30 }));
t('bounds: probes racing an input resolve as activity', () =>
  eq(idleBoundsFromProbes([{ intervalSeconds: 15, state: 'active' }, { intervalSeconds: 60, state: 'idle' }]),
     { minSeconds: 0, maxSeconds: 15 }));

// ── Agent reports ──
t('agent idle, confirmed by the OS, opens at the agent start (back-dated)', () => {
  const d = agentIdleStarted(fresh(), iso(T0 + 10 * MIN), osBounds(125), THRESHOLD);
  eq(d.commands, [{ kind: 'open', at: iso(T0 + 10 * MIN) }]);
});

t('agent idle contradicted by recent OS input is held, not opened', () => {
  const d = agentIdleStarted(fresh(), iso(T0 + 10 * MIN), osBounds(5), THRESHOLD);
  eq(d.commands, []);
  eq(d.tracker.pendingSince, iso(T0 + 10 * MIN));
});

t('agent idle a few seconds short of the threshold still opens (sampling slack)', () => {
  const d = agentIdleStarted(fresh(), iso(T0 + 10 * MIN), osBounds(110), THRESHOLD);
  eq(d.commands.length, 1);
});

t('agent idle with no OS reading opens (the agent is the better source)', () => {
  const d = agentIdleStarted(fresh(), iso(T0 + 10 * MIN), null, THRESHOLD);
  eq(d.commands.length, 1);
});

t('a second idle report while open does nothing', () => {
  const d = agentIdleStarted(fresh({ openSince: iso(T0) }), iso(T0 + MIN), osBounds(200), THRESHOLD);
  eq(d.commands, []);
});

t('idle before the session began is clamped to the session start', () => {
  const d = agentIdleStarted(fresh(), iso(T0 - 10 * MIN), osBounds(700), THRESHOLD);
  eq(d.commands, [{ kind: 'open', at: iso(T0) }]);
});

t('an end from ANY source closes the period', () => {
  const d = idleEnded(fresh({ openSince: iso(T0 + MIN) }), iso(T0 + 9 * MIN));
  eq(d.commands, [{ kind: 'close', at: iso(T0 + 9 * MIN) }]);
  eq(d.tracker.openSince, null);
});

t('an end timestamped before the start is clamped to the start', () => {
  const d = idleEnded(fresh({ openSince: iso(T0 + 5 * MIN) }), iso(T0 + MIN));
  eq(d.commands, [{ kind: 'close', at: iso(T0 + 5 * MIN) }]);
});

t('an end with nothing open is a no-op, and cancels a pending report', () => {
  eq(idleEnded(fresh(), iso(T0)).commands, []);
  eq(idleEnded(fresh({ pendingSince: iso(T0) }), iso(T0)).tracker.pendingSince, null);
});

// ── Browser reports ──
t('browser "active" closes a period even while the agent owns detection', () => {
  const d = browserIdleChanged(fresh({ openSince: iso(T0) }), 'active', T0 + 30 * MIN, true);
  eq(d.commands, [{ kind: 'close', at: iso(T0 + 30 * MIN) }]);
});

t('browser "idle" opens only when the agent does not own detection', () => {
  eq(browserIdleChanged(fresh(), 'idle', T0 + MIN, true).commands, []);
  eq(browserIdleChanged(fresh(), 'locked', T0 + MIN, false).commands, [{ kind: 'open', at: iso(T0 + MIN) }]);
});

// ── The safety net ──
t('an open period with fresh OS input is closed at the earliest possible input', () => {
  const now = T0 + 40 * MIN;
  const d = reconcileInactivity(fresh({ openSince: iso(T0 + 10 * MIN) }), osBounds(3), now, THRESHOLD);
  eq(d.commands, [{ kind: 'close', at: iso(now - 15 * SEC) }]);
});

t('a genuinely open period is left alone', () => {
  const now = T0 + 40 * MIN;
  const d = reconcileInactivity(fresh({ openSince: iso(T0 + 10 * MIN) }), osBounds(30 * 60), now, THRESHOLD);
  eq(d.commands, []);
});

t('a period that just opened is not closed by the input that preceded it', () => {
  // Agent opened at the back-dated start T0+10; OS says ~125s idle — input was BEFORE the start.
  const now = T0 + 10 * MIN + 125 * SEC;
  const d = reconcileInactivity(fresh({ openSince: iso(T0 + 10 * MIN) }), osBounds(125), now, THRESHOLD);
  eq(d.commands, []);
});

t('a pending report confirmed by the OS opens at its own start', () => {
  const tracker = fresh({ pendingSince: iso(T0 + 10 * MIN) });
  const d = reconcileInactivity(tracker, osBounds(200), T0 + 10 * MIN + 200 * SEC, THRESHOLD);
  eq(d.commands, [{ kind: 'open', at: iso(T0 + 10 * MIN) }]);
});

t('a pending report contradicted by later input is dropped', () => {
  const tracker = fresh({ pendingSince: iso(T0 + 10 * MIN) });
  const d = reconcileInactivity(tracker, osBounds(3), T0 + 20 * MIN, THRESHOLD);
  eq(d.commands, []);
  eq(d.tracker.pendingSince, null);
});

t('a lost idle event is recovered: idle past the threshold with nothing open', () => {
  const now = T0 + 30 * MIN;
  const d = reconcileInactivity(fresh(), osBounds(400), now, THRESHOLD);
  // The latest moment input can have stopped: 300s rung → now-300s.
  eq(d.commands, [{ kind: 'open', at: iso(now - 300 * SEC) }]);
});

t('no OS reading changes nothing', () => {
  eq(reconcileInactivity(fresh({ openSince: iso(T0) }), null, T0 + HOUR(), THRESHOLD).commands, []);
});
function HOUR() { return 60 * MIN; }

// ── The reported bug, replayed ──
t('stale period from a restarted agent: a working person loses at most one minute', () => {
  // The agent opened a period at 10:00, then restarted; the new process never
  // sends its end. The person works (input every few seconds) for four hours.
  let tracker = fresh({ openSince: iso(T0) });
  let closedAt = null;
  for (let minute = 1; minute <= 240; minute++) {
    const now = T0 + minute * MIN;
    const d = reconcileInactivity(tracker, osBounds(4), now, THRESHOLD);
    tracker = d.tracker;
    for (const c of d.commands) if (c.kind === 'close') closedAt = Date.parse(c.at);
  }
  ok(closedAt != null, 'the period was never closed');
  ok(closedAt - T0 <= MIN, `inactive for ${(closedAt - T0) / SEC}s`);
  eq(tracker.openSince, null);
});

t('browser opened a period while the agent was away; agent back; person active → closed', () => {
  let tracker = browserIdleChanged(fresh(), 'idle', T0 + 5 * MIN, false).tracker; // agent disconnected
  // Agent reconnects and owns detection: browser idle events are now ignored…
  tracker = browserIdleChanged(tracker, 'idle', T0 + 6 * MIN, true).tracker;
  // …and the agent never saw this period, so never ends it. Reconcile does.
  const d = reconcileInactivity(tracker, osBounds(2), T0 + 7 * MIN, THRESHOLD);
  eq(d.commands, [{ kind: 'close', at: iso(T0 + 7 * MIN - 15 * SEC) }]);
});

// ── Randomised: whatever the event soup, the invariants hold ──
t('fuzz: opens and closes alternate, and active minutes never stay inactive', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 300; run++) {
    let tracker = fresh();
    let open = false;
    let now = T0;
    let idleFor = 0; // the truth, in seconds
    for (let step = 0; step < 200; step++) {
      now += Math.floor(rand() * 90) * SEC + SEC;
      // Truth evolves: input happens, or it does not.
      idleFor = rand() < 0.5 ? 0 : idleFor + 90;
      const roll = rand();
      let d;
      if (roll < 0.2) d = agentIdleStarted(tracker, iso(now - idleFor * SEC), osBounds(idleFor), THRESHOLD);
      else if (roll < 0.35) d = idleEnded(tracker, iso(now - Math.floor(rand() * 600) * SEC)); // possibly stale/out of order
      else if (roll < 0.5) d = browserIdleChanged(tracker, rand() < 0.5 ? 'active' : 'idle', now, rand() < 0.5);
      else d = reconcileInactivity(tracker, osBounds(idleFor), now, THRESHOLD);
      for (const c of d.commands) {
        if (c.kind === 'open') { ok(!open, 'opened twice without a close'); open = true; }
        else { ok(open, 'closed with nothing open'); open = false; }
      }
      tracker = d.tracker;
      ok(Boolean(tracker.openSince) === open, 'tracker disagrees with the commands it issued');
      // The safety net: after a reconcile during real activity nothing stays open.
      if (roll >= 0.5 && idleFor < 15) ok(!tracker.openSince, 'open after a reconcile during activity');
    }
  }
});

// ── Auto-stop ──
t('no auto-stop before the limit', () => {
  eq(autoStopAt(fresh({ openSince: iso(T0) }), osBounds(59 * 60), T0 + 59 * MIN, THRESHOLD), null);
});

t('auto-stop at the moment the limit was reached, from an open period', () => {
  const now = T0 + 61 * MIN;
  eq(autoStopAt(fresh({ openSince: iso(T0) }), osBounds(61 * 60), now, THRESHOLD), T0 + 60 * MIN);
});

t('auto-stop from the OS alone when no period was ever opened', () => {
  const now = T0 + 2 * HOUR();
  eq(autoStopAt(fresh(), osBounds(3700), now, THRESHOLD), now - 3600 * SEC + 60 * MIN);
});

t('after a long sleep the stop lands at open + limit, not at wake-up', () => {
  const now = T0 + 5 * HOUR();
  eq(autoStopAt(fresh({ openSince: iso(T0 + 30 * MIN) }), osBounds(4 * 3600), now, THRESHOLD), T0 + 90 * MIN);
});

t('an open period contradicted by input never auto-stops', () => {
  eq(autoStopAt(fresh({ openSince: iso(T0) }), osBounds(5), T0 + 2 * HOUR(), THRESHOLD), null);
});

t('auto-stop is never in the future and never before the session', () => {
  const at = autoStopAt(fresh({ openSince: iso(T0 - 3 * HOUR()), notBefore: iso(T0) }), osBounds(9000), T0 + MIN, THRESHOLD);
  eq(at, T0);
  ok(INACTIVITY_POLICY.AUTO_STOP_AFTER_MS === 60 * MIN);
});

// ── A machine that was not running the session ──
t('a gap under the limit is recovered from, not stopped', () => {
  eq(awayStopAt(T0, T0 + 59 * MIN), null);
  eq(awayStopAt(null, T0), null);
});
t('a gap of the limit or more ends the session at the last moment it was alive', () => {
  eq(awayStopAt(T0, T0 + 60 * MIN), T0);
  eq(awayStopAt(T0, T0 + 14 * HOUR()), T0);
});

// ── Network loss ──
t('online, or not yet offline for the grace period → keep monitoring', () => {
  eq(offlineStopAt(T0, T0 + 5 * MIN, true), null);
  eq(offlineStopAt(T0, T0 + 30 * SEC, false), null);
  eq(offlineStopAt(null, T0, false), null);
});
t('offline past the grace period → stop at the moment the network was lost', () => {
  eq(offlineStopAt(T0, T0 + 61 * SEC, false), T0);
  eq(offlineStopAt(T0, T0 + HOUR(), false), T0);
});

// ── Session hand-off ──
t('the live session id is read out of an ALREADY_ACTIVE refusal', () => {
  eq(parseLiveSessionId('Resource already exists: MONITORING_ALREADY_ACTIVE: session 3F2504E0-4F89-11D3-9A0C-0305E82C3301 is already running on this project; stop it first'),
     '3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  eq(parseLiveSessionId('MONITORING_ALREADY_ACTIVE'), null);
  eq(parseLiveSessionId(undefined), null);
});

// ── Agent liveness ──
t('silence while the machine slept is not a dead agent', () => {
  eq(agentHeartbeatStale({ nowMs: T0 + HOUR(), lastHeartbeatMs: T0, lastCheckMs: T0 + MIN, staleAfterMs: 90 * SEC }),
     'woke-from-sleep');
});
t('silence while this worker was checking is a dead agent', () => {
  eq(agentHeartbeatStale({ nowMs: T0 + 3 * MIN, lastHeartbeatMs: T0, lastCheckMs: T0 + 2 * MIN, staleAfterMs: 90 * SEC }),
     'stale');
  eq(agentHeartbeatStale({ nowMs: T0 + MIN, lastHeartbeatMs: T0 + 30 * SEC, lastCheckMs: T0, staleAfterMs: 90 * SEC }),
     'fresh');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
