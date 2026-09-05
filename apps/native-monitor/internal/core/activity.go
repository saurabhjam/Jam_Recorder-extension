package core

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/bestq/native-monitor/internal/platform"
	"github.com/bestq/native-monitor/internal/protocol"
)

// The activity engine: turn a stream of "what is frontmost right now" samples
// into closed intervals.
//
// ── Intervals, not samples ──────────────────────────────────────────────────
// The backend stores activity as startedAt/endedAt pairs and a report says
// "VS Code, 25 min". Emitting one record per poll would push ~1800 rows an hour
// for the same fact; emitting one when focus *changes* pushes one. The backend
// derives durations from the boundaries.
//
// ── Identity is what makes that work ────────────────────────────────────────
// An interval closes only when the meaningful identity changes. Sampling the
// same window twice must continue the existing interval, not restart it —
// otherwise a user who sits in one application for an hour produces hundreds of
// two-second rows that sum correctly but describe nothing.

// MinIntervalDuration — anything shorter was alt-tabbing through, not working.
const MinIntervalDuration = time.Second

// ActivityEngine tracks the currently-open interval.
type ActivityEngine struct {
	mu sync.Mutex

	emit func(protocol.Activity)

	sessionID string
	paused    bool

	current   *protocol.Activity
	identity  string
	startedAt time.Time

	// Monotonic counter feeding the idempotency key, so a resend after a
	// reconnect cannot create a second row for the same interval.
	sequence int
}

func NewActivityEngine(emit func(protocol.Activity)) *ActivityEngine {
	return &ActivityEngine{emit: emit}
}

// Start binds the engine to a monitoring session.
func (e *ActivityEngine) Start(sessionID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.sessionID = sessionID
	e.paused = false
	e.current = nil
	e.identity = ""
	e.sequence = 0
}

// Stop closes the open interval and unbinds the session.
//
// Called before the extension settles the backend session, so the final stretch
// of the day is reported with its true end time rather than being lost with the
// process. Leaving an interval open indefinitely is exactly the bug this
// prevents.
func (e *ActivityEngine) Stop(at time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closeLocked(at)
	e.sessionID = ""
}

// Pause closes the open interval without emitting anything afterwards.
//
// Paused time is not monitored time, so the interval must END at the pause
// rather than spanning it.
func (e *ActivityEngine) Pause(at time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closeLocked(at)
	e.paused = true
}

func (e *ActivityEngine) Resume() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.paused = false
}

// Flush closes the open interval, keeping the session bound.
func (e *ActivityEngine) Flush(at time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.closeLocked(at)
}

// Sample feeds one observation.
//
// A nil window means the platform could not answer this time. That is treated
// as no-change rather than focus-lost: a single failed probe (a slow AX query,
// a permission prompt, a momentary lock) must not chop a continuous 25-minute
// interval into two.
func (e *ActivityEngine) Sample(win *platform.Window, at time.Time) {
	if win == nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.paused || e.sessionID == "" {
		return
	}

	next := buildActivity(win)
	identity := identityOf(next)
	if identity == e.identity {
		return
	}

	e.closeLocked(at)
	e.current = &next
	e.identity = identity
	e.startedAt = at
}

// Current is the open interval, for the STATUS reply.
func (e *ActivityEngine) Current() *protocol.Activity {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.current == nil {
		return nil
	}
	snapshot := *e.current
	snapshot.StartedAt = e.startedAt.UTC().Format(time.RFC3339Nano)
	return &snapshot
}

// closeLocked emits the open interval. Caller holds the mutex.
func (e *ActivityEngine) closeLocked(at time.Time) {
	if e.current == nil {
		return
	}
	activity := *e.current
	startedAt := e.startedAt

	e.current = nil
	e.identity = ""

	duration := at.Sub(startedAt)
	if duration < MinIntervalDuration {
		return
	}

	e.sequence++
	activity.SessionID = e.sessionID
	activity.StartedAt = startedAt.UTC().Format(time.RFC3339Nano)
	activity.EndedAt = at.UTC().Format(time.RFC3339Nano)
	activity.DurationSecs = int(duration.Round(time.Second) / time.Second)
	// Deterministic per session+sequence, which is what makes a resend safe.
	activity.ClientActivityID = fmt.Sprintf("native-%s-%d", e.sessionID, e.sequence)

	if e.emit != nil {
		e.emit(activity)
	}
}

// buildActivity maps an OS window onto the wire shape.
//
// This is where the browser/profile split happens, and where the decision NOT
// to produce a URL lives.
func buildActivity(win *platform.Window) protocol.Activity {
	activity := protocol.Activity{
		ApplicationName: win.ApplicationName,
		ApplicationID:   win.ApplicationID,
		ProcessID:       win.ProcessID,
	}

	suppressed := IsTitleSuppressedApp(win.ApplicationName, win.ApplicationID)
	if suppressed {
		// The title is the secret for these; the app name still carries the time.
		activity.TitleSuppressed = true
		return activity
	}

	title := RedactTitle(win.Title)

	if browserName, isBrowser := IdentifyBrowser(win.ApplicationName, win.ApplicationID); isBrowser {
		info := ParseBrowserTitle(title)
		activity.BrowserName = browserName
		if info.BrowserName != "" {
			activity.BrowserName = info.BrowserName
		}
		activity.BrowserProfile = info.Profile
		// The page title is real information even when the URL is unknowable —
		// including for a profile this extension is not installed in.
		activity.WindowTitle = title
		// PageURL is left empty, always. A window title is not a URL and there
		// is no way to obtain one for another profile; populating it with a
		// guess would be fabricating a page visit.
		return activity
	}

	activity.WindowTitle = title
	return activity
}

// identityOf builds the stable key for "the same thing is still in front".
//
// The window title is part of the key for browsers (the page changed) and for
// native apps too, because an editor moving between files is genuinely a
// different piece of work. Normalised so a title differing only by whitespace
// or an unsaved-changes marker does not split an interval.
func identityOf(a protocol.Activity) string {
	title := strings.TrimSpace(a.WindowTitle)
	title = strings.TrimLeft(title, "•*● ")
	title = strings.Join(strings.Fields(title), " ")
	return strings.Join([]string{
		a.ApplicationID,
		a.ApplicationName,
		a.BrowserProfile,
		title,
	}, "|")
}
