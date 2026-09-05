package core

import (
	"runtime"
	"sync"
	"time"

	"github.com/bestq/native-monitor/internal/platform"
	"github.com/bestq/native-monitor/internal/protocol"
)

// The agent state machine and poll loop.
//
// ── Lifetime ────────────────────────────────────────────────────────────────
// Chrome launches this process when the extension connects and kills it when
// the port closes, so the process lifetime is one connection. Monitoring
// sessions come and go inside it via START_MONITORING / STOP_MONITORING.
//
// ── Why polling, and why two seconds ────────────────────────────────────────
// Windows has SetWinEventHook and macOS has NSWorkspace notifications, both
// event-driven — but consuming either needs a run loop owned by the platform
// layer, and neither covers idle time, which has to be polled regardless. One
// poll loop that answers both questions is simpler to reason about and to shut
// down cleanly than an event source plus a timer.
//
// Two seconds is the compromise: a two-minute detour into Slack must not be
// rounded away, while each sample costs an OS query (and on Linux a
// subprocess), so 200ms would mean five process launches a second for eight
// hours — a real cost on the user's machine for precision nobody reads.

const (
	// SampleInterval — see the note above.
	SampleInterval = 2 * time.Second
	// HeartbeatInterval — the extension treats silence past ~3x this as a dead
	// agent, so 20s gives it room to notice without chattering.
	HeartbeatInterval = 20 * time.Second
)

// State is the agent's own lifecycle, distinct from the session's.
type State string

const (
	StateConnected  State = "CONNECTED"
	StateStarting   State = "STARTING"
	StateMonitoring State = "MONITORING"
	StatePaused     State = "PAUSED"
	StateStopping   State = "STOPPING"
	StateError      State = "ERROR"
)

// Agent owns the poll loop, the activity engine and the idle tracker.
type Agent struct {
	mu sync.Mutex

	version  string
	monitor  platform.Monitor
	send     func(protocol.Outbound)
	activity *ActivityEngine
	idle     *IdleTracker

	state     State
	sessionID string

	stop chan struct{}
	done chan struct{}

	// sampling guards against overlapping probes: an OS query slower than the
	// interval (a machine under load, a permission prompt) must not stack up
	// queries behind it, which would make the problem worse exactly when the
	// machine is least able to absorb it.
	sampling bool
}

func NewAgent(version string, monitor platform.Monitor, send func(protocol.Outbound)) *Agent {
	a := &Agent{
		version: version,
		monitor: monitor,
		send:    send,
		state:   StateConnected,
	}
	a.activity = NewActivityEngine(func(activity protocol.Activity) {
		out := protocol.NewOutbound(protocol.TypeActivityChanged)
		out.Activity = &activity
		a.send(out)
		Logf("INFO", "activity_changed",
			"application", activity.ApplicationName,
			"profile", orDash(activity.BrowserProfile),
			"title", SafeTitle(activity.WindowTitle),
			"seconds", activity.DurationSecs)
	})
	a.idle = NewIdleTracker(5*time.Minute, func(idle bool, startedAt, endedAt time.Time, duration time.Duration) {
		out := protocol.NewOutbound(protocol.TypeIdleChanged)
		flag := idle
		out.Idle = &flag
		out.IdleStartedAt = startedAt.UTC().Format(time.RFC3339Nano)
		if !idle {
			out.IdleEndedAt = endedAt.UTC().Format(time.RFC3339Nano)
			out.IdleSeconds = int(duration.Round(time.Second) / time.Second)
		}
		a.send(out)
		if idle {
			Logf("INFO", "inactivity_started", "startedAt", out.IdleStartedAt)
		} else {
			Logf("INFO", "inactivity_ended", "seconds", out.IdleSeconds)
		}
	})
	return a
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// Hello answers the handshake with what this machine can actually do.
//
// Sent before the extension relies on anything, so an unsupported platform or a
// missing permission is known immediately rather than inferred from an absence
// of activity that never arrives.
func (a *Agent) Hello() {
	caps := a.monitor.Capabilities()
	perms := a.monitor.Permissions()

	out := protocol.NewOutbound(protocol.TypeReady)
	out.AgentVersion = a.version
	out.Platform = a.monitor.Name()
	out.Architecture = runtime.GOARCH
	out.Capabilities = &caps
	out.Permissions = &perms
	out.State = string(a.currentState())
	a.send(out)

	Logf("INFO", "hello",
		"version", a.version,
		"platform", a.monitor.Name(),
		"arch", runtime.GOARCH,
		"foreground", caps.ForegroundApplication,
		"windowTitle", caps.WindowTitle,
		"idle", caps.IdleDetection)

	// A missing grant is reported as an error the UI can act on, not as silence
	// that presents as "Applications: 0".
	if !caps.ForegroundApplication {
		if perms.Accessibility != nil && !*perms.Accessibility {
			a.send(protocol.Errorf(protocol.ErrPermissionRequired,
				"Accessibility permission is required to detect the active application."))
		} else {
			a.send(protocol.Errorf(protocol.ErrUnsupportedPlatform,
				"This desktop session cannot report the active application."))
		}
	} else if !caps.WindowTitle && perms.Accessibility != nil && !*perms.Accessibility {
		a.send(protocol.Errorf(protocol.ErrPermissionRequired,
			"Accessibility permission is required to read window titles."))
	}
}

// StartMonitoring binds a session and begins sampling.
func (a *Agent) StartMonitoring(sessionID string, idleThresholdSeconds int) {
	a.mu.Lock()
	if a.state == StateMonitoring && a.sessionID == sessionID {
		a.mu.Unlock()
		a.send(protocol.NewOutbound(protocol.TypeStarted))
		return
	}
	a.mu.Unlock()

	// A different session arriving replaces the old one cleanly rather than
	// running two overlapping timelines.
	a.StopMonitoring(time.Now(), false)

	a.mu.Lock()
	a.state = StateStarting
	a.sessionID = sessionID
	a.stop = make(chan struct{})
	a.done = make(chan struct{})
	stop, done := a.stop, a.done
	a.mu.Unlock()

	if idleThresholdSeconds > 0 {
		a.idle.SetThreshold(time.Duration(idleThresholdSeconds) * time.Second)
	}
	a.activity.Start(sessionID)
	a.idle.Start(time.Now().UTC())

	go a.loop(stop, done)

	a.mu.Lock()
	a.state = StateMonitoring
	a.mu.Unlock()

	out := protocol.NewOutbound(protocol.TypeStarted)
	out.SessionID = sessionID
	a.send(out)
	Logf("INFO", "monitoring_started", "session", sessionID)
}

// StopMonitoring closes everything open and stops sampling.
func (a *Agent) StopMonitoring(at time.Time, notify bool) {
	a.mu.Lock()
	if a.state != StateMonitoring && a.state != StatePaused && a.state != StateStarting {
		a.mu.Unlock()
		if notify {
			a.send(protocol.NewOutbound(protocol.TypeStopped))
		}
		return
	}
	a.state = StateStopping
	session := a.sessionID
	stop, done := a.stop, a.done
	a.stop, a.done = nil, nil
	a.mu.Unlock()

	if stop != nil {
		close(stop)
		if done != nil {
			// Bounded: a wedged platform query must not hold Stop open forever.
			select {
			case <-done:
			case <-time.After(5 * time.Second):
			}
		}
	}

	// Close the open interval and any inactive period AT the stop time, so the
	// final stretch is reported rather than lost.
	a.idle.Stop(at)
	a.activity.Stop(at)

	a.mu.Lock()
	a.state = StateConnected
	a.sessionID = ""
	a.mu.Unlock()

	if notify {
		a.send(protocol.NewOutbound(protocol.TypeStopped))
	}
	Logf("INFO", "monitoring_stopped", "session", session)
}

func (a *Agent) Pause(at time.Time) {
	a.mu.Lock()
	if a.state != StateMonitoring {
		a.mu.Unlock()
		a.send(protocol.NewOutbound(protocol.TypePaused))
		return
	}
	a.state = StatePaused
	a.mu.Unlock()

	a.idle.Pause(at)
	a.activity.Pause(at)
	a.send(protocol.NewOutbound(protocol.TypePaused))
	Logf("INFO", "monitoring_paused")
}

func (a *Agent) Resume() {
	a.mu.Lock()
	if a.state != StatePaused {
		a.mu.Unlock()
		a.send(protocol.NewOutbound(protocol.TypeResumed))
		return
	}
	a.state = StateMonitoring
	a.mu.Unlock()

	a.idle.Resume(time.Now().UTC())
	a.activity.Resume()
	a.send(protocol.NewOutbound(protocol.TypeResumed))
	Logf("INFO", "monitoring_resumed")
}

// Flush closes the open interval without ending the session, so the extension
// can settle a backend session with the final stretch already reported.
func (a *Agent) Flush(at time.Time) {
	a.activity.Flush(at)
	a.send(protocol.NewOutbound(protocol.TypeFlushed))
}

// Status answers GET_STATUS with live capability and session state.
func (a *Agent) Status() {
	caps := a.monitor.Capabilities()
	perms := a.monitor.Permissions()
	idle, idleSince := a.idle.IsIdle()

	out := protocol.NewOutbound(protocol.TypeStatus)
	out.AgentVersion = a.version
	out.Platform = a.monitor.Name()
	out.Architecture = runtime.GOARCH
	out.Capabilities = &caps
	out.Permissions = &perms
	out.State = string(a.currentState())
	out.SessionID = a.currentSession()
	out.Activity = a.activity.Current()
	flag := idle
	out.Idle = &flag
	if idle && !idleSince.IsZero() {
		out.IdleStartedAt = idleSince.UTC().Format(time.RFC3339Nano)
	}
	a.send(out)
}

func (a *Agent) currentState() State {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state
}

func (a *Agent) currentSession() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.sessionID
}

// loop samples foreground and idle, and heartbeats.
func (a *Agent) loop(stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)

	sampleTicker := time.NewTicker(SampleInterval)
	defer sampleTicker.Stop()
	heartbeatTicker := time.NewTicker(HeartbeatInterval)
	defer heartbeatTicker.Stop()

	a.sampleOnce()

	for {
		select {
		case <-stop:
			return
		case <-sampleTicker.C:
			a.sampleOnce()
		case <-heartbeatTicker.C:
			// Capabilities ride along with every heartbeat, not just the
			// initial READY. A user who grants Accessibility while monitoring
			// is running would otherwise keep seeing "window titles are
			// unavailable" until the agent happened to reconnect — the grant
			// takes effect immediately in the OS, so the report of it must too.
			beat := protocol.NewOutbound(protocol.TypeHeartbeat)
			capabilities := a.monitor.Capabilities()
			permissions := a.monitor.Permissions()
			beat.Capabilities = &capabilities
			beat.Permissions = &permissions
			a.send(beat)
		}
	}
}

func (a *Agent) sampleOnce() {
	a.mu.Lock()
	if a.sampling {
		a.mu.Unlock()
		return
	}
	a.sampling = true
	a.mu.Unlock()

	defer func() {
		a.mu.Lock()
		a.sampling = false
		a.mu.Unlock()
	}()

	now := time.Now()

	// A failed probe is "unknown", not "nothing focused" — the engine treats
	// nil as no-change so one bad query cannot split a continuous interval.
	if win, err := a.monitor.Foreground(); err == nil {
		a.activity.Sample(win, now)
	}

	if seconds, err := a.monitor.IdleSeconds(); err == nil {
		a.idle.Sample(seconds, now)
	}
}
