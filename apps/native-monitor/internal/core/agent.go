package core

import (
	"encoding/base64"
	"errors"
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
	// ScreenshotMaxEdge is the longest edge of a stored capture.
	//
	// 1600 rather than 1280: at 1280 a 4K desktop is reduced by a third in each
	// direction and small text stops being readable, which defeats the purpose
	// of the image. The larger frame costs bytes, which the budget below now
	// allows for.
	ScreenshotMaxEdge = 1600
	// ScreenshotTargetBytes is the per-frame byte budget the encoder aims at.
	//
	// Raised from 30 KB. That budget did hold, but it bought the size by
	// pushing quality to its floor and then shrinking the image, and the
	// screenshots came back too soft to read — which makes them worthless as a
	// record of what someone was doing. 120 KB keeps text legible at 1600px on
	// an ordinary desktop; at a 30-second interval that is roughly 14 MB per
	// hour per person, which is the real cost of a readable screenshot.
	ScreenshotTargetBytes = 120 * 1024

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
	// screenshotEvery is the capture cadence the extension asked for. Zero
	// means it does not want frames from the agent.
	screenshotEvery time.Duration

	stop chan struct{}
	done chan struct{}

	// capturing guards against overlapping screen captures, for the same
	// reason sampling does.
	capturing bool

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
func (a *Agent) StartMonitoring(sessionID string, idleThresholdSeconds, screenshotIntervalSeconds int) {
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
	if screenshotIntervalSeconds > 0 {
		a.screenshotEvery = time.Duration(screenshotIntervalSeconds) * time.Second
	} else {
		a.screenshotEvery = 0
	}
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

	// The capture cadence runs here, in the agent, because a native timer is
	// the only reliable one available. A service worker is torn down every
	// thirty seconds and an offscreen document is throttled while the browser
	// is in the background — which, for a tool whose job is to watch what
	// someone does in *other* applications, is most of the time.
	a.mu.Lock()
	every := a.screenshotEvery
	a.mu.Unlock()

	var captureTicker *time.Ticker
	var captureTick <-chan time.Time
	if every > 0 {
		captureTicker = time.NewTicker(every)
		defer captureTicker.Stop()
		captureTick = captureTicker.C
		// The first frame goes out immediately: a session that starts at
		// 10:00:00 should have a 10:00:00 screenshot, not its first at 10:00:30.
		go a.captureOnce()
	}

	a.sampleOnce()

	for {
		select {
		case <-stop:
			return
		case <-sampleTicker.C:
			a.sampleOnce()
		case <-captureTick:
			// On its own goroutine: encoding a frame takes longer than the
			// two-second sampling interval, and blocking here would stall
			// foreground detection for the duration of every capture.
			go a.captureOnce()
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

// CaptureScreenNow serves an explicit CAPTURE_SCREEN request.
//
// Same path as the ticker, so an on-demand frame and a scheduled one cannot
// differ in what they capture or how they fail.
func (a *Agent) CaptureScreenNow() { a.capture(false) }

// captureOnce grabs the whole screen and pushes it to the extension.
//
// Whole screen, always. There is no window or region path, which is the point:
// the browser picker offered those choices, no browser API could remove them,
// and a monitoring session aimed at one tab produces a report that looks
// complete and is not.
//
// A failure is reported, never substituted. If the screen cannot be read the
// extension is told so and stops the session — it must not fall back to
// capturing something narrower.
func (a *Agent) captureOnce() { a.capture(true) }

// capture takes one frame. `requireSession` is false for an explicit
// CAPTURE_SCREEN request.
//
// The distinction matters: the ticker must not fire outside a session, but an
// explicit request is how the extension proves capture works *before*
// committing to one — and how the user gets the macOS permission prompt at all.
// Requiring a session for both made that probe a silent no-op, which looked
// exactly like a working agent that captures nothing.
func (a *Agent) capture(requireSession bool) {
	a.mu.Lock()
	if requireSession && a.state != StateMonitoring {
		a.mu.Unlock()
		return
	}
	// Guarded like sampling: an encode slower than the interval must not stack
	// captures behind it, which would spend the machine's CPU exactly when it
	// is least able to spare it.
	if a.capturing {
		a.mu.Unlock()
		return
	}
	a.capturing = true
	session := a.sessionID
	a.mu.Unlock()

	defer func() {
		a.mu.Lock()
		a.capturing = false
		a.mu.Unlock()
	}()

	capturedAt := time.Now().UTC()
	frame, err := a.monitor.CaptureScreen(ScreenshotMaxEdge, ScreenshotTargetBytes)
	if err != nil {
		switch {
		case errors.Is(err, platform.ErrScreenPermission):
			a.send(protocol.Errorf(protocol.ErrScreenPermission,
				"Screen Recording permission is required. Grant it to the BestQ agent in "+
					"System Settings > Privacy & Security > Screen Recording, then restart your browser."))
			Logf("WARN", "screen_capture_denied")
		case errors.Is(err, platform.ErrScreenUnsupported):
			a.send(protocol.Errorf(protocol.ErrScreenUnsupported,
				"Whole-screen capture is not available on this operating system."))
			Logf("WARN", "screen_capture_unsupported")
		default:
			a.send(protocol.Errorf(protocol.ErrCaptureFailed, "The screen could not be captured."))
			Logf("WARN", "screen_capture_failed", "error", err.Error())
		}
		return
	}

	out := protocol.NewOutbound(protocol.TypeScreenFrame)
	out.SessionID = session
	out.Frame = &protocol.ScreenFrame{
		MimeType:     frame.MimeType,
		Data:         base64.StdEncoding.EncodeToString(frame.Data),
		Width:        frame.Width,
		Height:       frame.Height,
		Bytes:        len(frame.Data),
		CapturedAt:   capturedAt.Format(time.RFC3339Nano),
		DisplayCount: frame.DisplayCount,
		SessionID:    session,
	}
	a.send(out)
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
