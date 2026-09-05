package core

import (
	"sync"
	"time"
)

// System-wide inactivity.
//
// ── Five minutes is the threshold, not the duration ─────────────────────────
// This is the single most-often-got-wrong part of the model, so it is stated
// precisely:
//
//	10:24  last keyboard or mouse input
//	10:29  five minutes have elapsed — the stretch now QUALIFIES as inactivity
//	10:46  input resumes
//
// The recorded period is 10:24 → 10:46, duration 22 minutes.
//
// Not 10:29 → 10:46 (that discards the first five minutes of a real absence,
// under-reporting every period by the threshold), and not a flat "5 minutes"
// (that discards the length entirely).
//
// The threshold decides *whether* to record; the OS idle counter decides *what*
// to record. This is only possible because the platform layer reports a real
// idle duration — `chrome.idle` in the extension signals a threshold crossing
// and nothing more, which is why it cannot be the source for this.
type IdleTracker struct {
	mu sync.Mutex

	threshold time.Duration
	onChange  func(idle bool, startedAt, endedAt time.Time, duration time.Duration)

	// idle is true while a qualifying period is open.
	idle bool
	// startedAt is when input actually stopped — derived by subtracting the
	// OS-reported idle duration from now, NOT the moment we noticed.
	startedAt time.Time

	paused bool
	active bool

	// countFrom is the earliest instant this session may attribute inactivity
	// to: the moment monitoring started, or resumed after a pause. Input that
	// stopped before then happened outside monitored time.
	countFrom time.Time
}

func NewIdleTracker(threshold time.Duration, onChange func(bool, time.Time, time.Time, time.Duration)) *IdleTracker {
	if threshold <= 0 {
		threshold = 5 * time.Minute
	}
	return &IdleTracker{threshold: threshold, onChange: onChange}
}

// SetThreshold lets the extension keep the agent aligned with the backend's
// configured value rather than both hardcoding 300 and drifting apart.
func (t *IdleTracker) SetThreshold(threshold time.Duration) {
	if threshold <= 0 {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.threshold = threshold
}

func (t *IdleTracker) Start(at time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.active = true
	t.paused = false
	t.idle = false
	t.startedAt = time.Time{}
	t.countFrom = at
}

// Stop closes an open period, so a session cannot end with inactivity dangling.
func (t *IdleTracker) Stop(at time.Time) {
	t.mu.Lock()
	shouldEmit := t.active && t.idle
	startedAt := t.startedAt
	t.active = false
	t.idle = false
	t.startedAt = time.Time{}
	onChange := t.onChange
	t.mu.Unlock()

	if shouldEmit && onChange != nil {
		onChange(false, startedAt, at, at.Sub(startedAt))
	}
}

// Pause closes an open period at the pause.
//
// Paused time is the user's deliberate choice and is subtracted from monitored
// duration; inactivity sits *inside* monitored time. An inactive period must
// therefore never span a pause, or the two would overlap and double-count.
func (t *IdleTracker) Pause(at time.Time) {
	t.Stop(at)
	t.mu.Lock()
	t.paused = true
	t.mu.Unlock()
}

func (t *IdleTracker) Resume(at time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.paused = false
	t.active = true
	t.idle = false
	t.startedAt = time.Time{}
	t.countFrom = at
}

// Sample feeds the OS-reported idle duration.
//
// `idleSeconds` is how long since the last input, machine-wide. Passing the
// real duration — rather than a boolean — is what allows the period to be
// back-dated correctly to when input actually stopped.
func (t *IdleTracker) Sample(idleSeconds float64, now time.Time) {
	t.mu.Lock()
	if !t.active || t.paused {
		t.mu.Unlock()
		return
	}

	idleFor := time.Duration(idleSeconds * float64(time.Second))
	threshold := t.threshold
	wasIdle := t.idle
	startedAt := t.startedAt
	onChange := t.onChange

	switch {
	case !wasIdle && idleFor >= threshold:
		// The stretch has just qualified. Its start is now minus however long
		// the OS says input has been absent — which is BEFORE the threshold was
		// reached, and is the whole point.
		t.idle = true
		t.startedAt = now.Add(-idleFor)
		// Never before monitoring began. Someone who was already away for ten
		// minutes and then starts a session would otherwise open a period ten
		// minutes before the session existed, and the day would report more
		// inactive time than it ever monitored.
		if !t.countFrom.IsZero() && t.startedAt.Before(t.countFrom) {
			t.startedAt = t.countFrom
		}
		newStart := t.startedAt
		t.mu.Unlock()
		if onChange != nil {
			onChange(true, newStart, time.Time{}, 0)
		}
		return

	case wasIdle && idleFor < threshold:
		// Input resumed. The counter reset, so the period ends now.
		//
		// `now` rather than `now - idleFor`: the reset means input happened
		// within the last idleFor seconds, and attributing the end to the exact
		// keystroke would need an event hook this deliberately does not install.
		// The error is bounded by the sample interval, a few seconds.
		t.idle = false
		t.startedAt = time.Time{}
		t.mu.Unlock()
		if onChange != nil && !startedAt.IsZero() {
			onChange(false, startedAt, now, now.Sub(startedAt))
		}
		return

	default:
		t.mu.Unlock()
	}
}

// IsIdle reports the current state, for the STATUS reply.
func (t *IdleTracker) IsIdle() (bool, time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.idle, t.startedAt
}
