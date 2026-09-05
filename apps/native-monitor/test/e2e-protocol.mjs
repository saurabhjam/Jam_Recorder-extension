#!/usr/bin/env node
/**
 * End-to-end test of the real agent binary over the real Chrome Native
 * Messaging framing.
 *
 * Written in Node rather than Go on purpose: it speaks the wire protocol from
 * the outside, exactly as Chrome does, so it catches the failures a Go unit
 * test cannot — a stray byte on stdout, a wrong-endian length prefix, a
 * handler that never replies. If this passes, the port works.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const AGENT = process.argv[2] ?? './build/bestq-monitoring-agent';
if (!existsSync(AGENT)) {
  console.error(`agent binary not found at ${AGENT}`);
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`); }
};

const frame = (msg) => {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
};

function runAgent(messages, waitMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(AGENT, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const received = [];
    let buf = Buffer.alloc(0);
    let stderr = '';
    let framingError = null;

    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readUInt32LE(0);
        if (len > 1024 * 1024) { framingError = `absurd frame length ${len} — stdout is corrupted`; return; }
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        try { received.push(JSON.parse(body.toString('utf8'))); }
        catch (e) { framingError = `unparseable frame: ${e.message}`; return; }
      }
    });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);

    (async () => {
      for (const { msg, delay } of messages) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        child.stdin.write(frame(msg));
      }
      await new Promise((r) => setTimeout(r, waitMs));
      child.stdin.end();
      setTimeout(() => { child.kill(); resolve({ received, stderr, framingError, leftover: buf.length }); }, 250);
    })();
  });
}

const V = 1;

async function main() {
  // ── 1. Handshake ──
  {
    const { received, framingError, leftover, stderr } = await runAgent(
      [{ msg: { protocolVersion: V, type: 'HELLO' } }], 600);
    check('stdout carries only valid framed messages', !framingError && leftover === 0,
      framingError ?? `leftover ${leftover} bytes`);
    const ready = received.find((m) => m.type === 'READY');
    check('HELLO is answered with READY', !!ready, JSON.stringify(received));
    if (ready) {
      check('READY reports protocol version', ready.protocolVersion === V);
      check('READY reports agent version', typeof ready.agentVersion === 'string' && ready.agentVersion.length > 0);
      check('READY reports platform and architecture', !!ready.platform && !!ready.architecture);
      check('READY reports capabilities', !!ready.capabilities && typeof ready.capabilities.foregroundApplication === 'boolean');
      check('exactBrowserUrl is always false (a title is not a URL)', ready.capabilities?.exactBrowserUrl === false);
      console.log(`     capabilities: ${JSON.stringify(ready.capabilities)}`);
      console.log(`     permissions:  ${JSON.stringify(ready.permissions)}`);
    }
    check('diagnostics go to stderr, not stdout', stderr.includes('agent_started'));
  }

  // ── 2. Full session lifecycle with real activity ──
  {
    const session = 'e2e-test-session-001';
    const { received } = await runAgent([
      { msg: { protocolVersion: V, type: 'HELLO' } },
      { msg: { protocolVersion: V, type: 'START_MONITORING', sessionId: session }, delay: 200 },
      { msg: { protocolVersion: V, type: 'GET_STATUS' }, delay: 2600 },
      { msg: { protocolVersion: V, type: 'STOP_MONITORING', sessionId: session }, delay: 400 },
    ], 900);

    const types = received.map((m) => m.type);
    check('START_MONITORING is acknowledged', types.includes('STARTED'), types.join(','));
    check('GET_STATUS is answered', types.includes('STATUS'), types.join(','));
    check('STOP_MONITORING is acknowledged', types.includes('STOPPED'), types.join(','));

    const status = received.find((m) => m.type === 'STATUS');
    if (status) {
      check('STATUS reports the bound session', status.sessionId === session, `got ${status.sessionId}`);
      check('STATUS reports the MONITORING state', status.state === 'MONITORING', `got ${status.state}`);
      check('STATUS carries the live foreground activity', !!status.activity?.applicationName,
        JSON.stringify(status.activity));
      if (status.activity) console.log(`     live activity: ${status.activity.applicationName} / ${JSON.stringify(status.activity.windowTitle)}`);
    }

    // The interval that was open when STOP arrived must be emitted, closed.
    const activities = received.filter((m) => m.type === 'ACTIVITY_CHANGED');
    check('the open interval is closed and emitted on stop', activities.length >= 1,
      `got ${activities.length} ACTIVITY_CHANGED`);
    if (activities.length) {
      const a = activities[activities.length - 1].activity;
      check('the closed interval has both boundaries', !!a.startedAt && !!a.endedAt);
      check('the closed interval has an idempotency key', typeof a.clientActivityId === 'string' && a.clientActivityId.startsWith('native-'));
      check('the closed interval carries its session', a.sessionId === session);
      check('pageUrl is never fabricated', !a.pageUrl);
      console.log(`     closed interval: ${a.applicationName} ${a.durationSeconds}s key=${a.clientActivityId}`);
    }
  }

  // ── 3. Security: every malformed input must fail safely ──
  {
    const { received, framingError } = await runAgent([
      { msg: { protocolVersion: 99, type: 'HELLO' } },
      { msg: { protocolVersion: V, type: 'RUN_SHELL', command: 'rm -rf /' }, delay: 120 },
      { msg: { protocolVersion: V, type: 'START_MONITORING' }, delay: 120 },
      { msg: { protocolVersion: V, type: 'START_MONITORING', sessionId: '../../etc/passwd' }, delay: 120 },
      { msg: { protocolVersion: V, type: 'HELLO' }, delay: 120 },
    ], 700);

    check('a bad message never corrupts the stream', !framingError, framingError ?? '');
    const errors = received.filter((m) => m.type === 'ERROR');
    check('a wrong protocol version is refused', errors.some((e) => e.code === 'PROTOCOL_VERSION_MISMATCH'),
      JSON.stringify(errors.map((e) => e.code)));
    check('an unknown message type is refused', errors.some((e) => e.code === 'INVALID_MESSAGE'));
    check('at least four bad messages were each rejected', errors.length >= 4, `got ${errors.length}`);
    check('the agent survives and still serves HELLO', received.some((m) => m.type === 'READY'));
  }

  // ── 4. Malformed JSON must not kill the port ──
  {
    const child = spawn(AGENT, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const received = [];
    let buf = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        received.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
        buf = buf.subarray(4 + len);
      }
    });
    const bad = Buffer.from('{not json at all', 'utf8');
    const head = Buffer.alloc(4); head.writeUInt32LE(bad.length, 0);
    child.stdin.write(Buffer.concat([head, bad]));
    await new Promise((r) => setTimeout(r, 250));
    child.stdin.write(frame({ protocolVersion: V, type: 'HELLO' }));
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.end(); child.kill();
    check('malformed JSON is rejected and the port survives',
      received.some((m) => m.type === 'ERROR') && received.some((m) => m.type === 'READY'),
      received.map((m) => m.type).join(','));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

void main();
