package core

import (
	"testing"
	"time"
)

// The threshold-versus-duration distinction is the single most-often-got-wrong
// part of the inactivity model, so it is pinned down here with the exact
// scenario from the specification.

type idleEvent struct {
	idle      bool
	startedAt time.Time
	endedAt   time.Time
	duration  time.Duration
}

func newTestTracker(threshold time.Duration) (*IdleTracker, *[]idleEvent) {
	var events []idleEvent
	tracker := NewIdleTracker(threshold, func(idle bool, startedAt, endedAt time.Time, duration time.Duration) {
		events = append(events, idleEvent{idle, startedAt, endedAt, duration})
	})
	// Well before every scenario's clock, so nothing is clamped except where a
	// test sets out to exercise the clamp.
	tracker.Start(time.Date(2026, 9, 4, 0, 0, 0, 0, time.UTC))
	return tracker, &events
}

func TestInactivityRecordsTrueDurationNotThreshold(t *testing.T) {
	// Last input 10:24. Threshold reached 10:29. Input resumes 10:46.
	// The recorded period must be 10:24 → 10:46 = 22 minutes.
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	at := func(h, m int) time.Time { return time.Date(2026, 9, 4, h, m, 0, 0, time.UTC) }
	_ = base

	tracker, events := newTestTracker(5 * time.Minute)

	// 10:26 — two minutes idle, below the threshold. Nothing recorded yet.
	tracker.Sample(120, at(10, 26))
	if len(*events) != 0 {
		t.Fatalf("a sub-threshold stretch must record nothing, got %d event(s)", len(*events))
	}

	// 10:29 — five minutes idle. The stretch now qualifies.
	tracker.Sample(300, at(10, 29))
	if len(*events) != 1 || !(*events)[0].idle {
		t.Fatalf("expected one idle-start event, got %+v", *events)
	}
	// Back-dated to when input actually stopped, NOT to when we noticed.
	if got := (*events)[0].startedAt; !got.Equal(at(10, 24)) {
		t.Errorf("inactivity must start at 10:24 (last input), got %s", got.Format("15:04"))
	}

	// 10:46 — input resumes; the OS counter has reset.
	tracker.Sample(1, at(10, 46))
	if len(*events) != 2 || (*events)[1].idle {
		t.Fatalf("expected an idle-end event, got %+v", *events)
	}
	end := (*events)[1]
	if !end.startedAt.Equal(at(10, 24)) {
		t.Errorf("end event must carry the 10:24 start, got %s", end.startedAt.Format("15:04"))
	}
	if !end.endedAt.Equal(at(10, 46)) {
		t.Errorf("end must be 10:46, got %s", end.endedAt.Format("15:04"))
	}
	if end.duration != 22*time.Minute {
		t.Errorf("duration must be 22m (not the 5m threshold, not 17m), got %s", end.duration)
	}
}

func TestSubThresholdStretchIsNeverRecorded(t *testing.T) {
	// Four minutes away must produce no inactivity at all.
	at := func(m, s int) time.Time { return time.Date(2026, 9, 4, 10, m, s, 0, time.UTC) }
	tracker, events := newTestTracker(5 * time.Minute)

	for _, sample := range []struct {
		idleSeconds float64
		when        time.Time
	}{
		{60, at(1, 0)}, {120, at(2, 0)}, {180, at(3, 0)}, {239, at(3, 59)},
		{1, at(4, 5)}, // resumed
	} {
		tracker.Sample(sample.idleSeconds, sample.when)
	}

	if len(*events) != 0 {
		t.Fatalf("4 minutes idle must record nothing, got %+v", *events)
	}
}

func TestLongInactivityKeepsItsFullLength(t *testing.T) {
	at := func(h, m int) time.Time { return time.Date(2026, 9, 4, h, m, 0, 0, time.UTC) }
	tracker, events := newTestTracker(5 * time.Minute)

	// Away from 10:00 to 11:30 — 90 minutes.
	tracker.Sample(300, at(10, 5))    // qualifies; started 10:00
	tracker.Sample(3600, at(11, 0))   // still idle, no new event
	tracker.Sample(2, at(11, 30))     // resumed

	if len(*events) != 2 {
		t.Fatalf("expected start+end, got %+v", *events)
	}
	if (*events)[1].duration != 90*time.Minute {
		t.Errorf("duration must be 90m, got %s", (*events)[1].duration)
	}
	if len(*events) > 2 {
		t.Errorf("a continuing idle stretch must not emit repeatedly")
	}
}

func TestStopClosesAnOpenInactivePeriod(t *testing.T) {
	at := func(h, m int) time.Time { return time.Date(2026, 9, 4, h, m, 0, 0, time.UTC) }
	tracker, events := newTestTracker(5 * time.Minute)

	tracker.Sample(300, at(10, 30)) // idle from 10:25
	tracker.Stop(at(10, 40))

	if len(*events) != 2 {
		t.Fatalf("stop must close the open period, got %+v", *events)
	}
	end := (*events)[1]
	if end.duration != 15*time.Minute {
		t.Errorf("period must run 10:25→10:40 = 15m, got %s", end.duration)
	}
}

func TestPauseClosesInactivityAtThePause(t *testing.T) {
	// Paused time is subtracted from monitored duration; inactivity sits inside
	// monitored time. They must never overlap, or the two double-count.
	at := func(h, m int) time.Time { return time.Date(2026, 9, 4, h, m, 0, 0, time.UTC) }
	tracker, events := newTestTracker(5 * time.Minute)

	tracker.Sample(300, at(10, 30)) // idle from 10:25
	tracker.Pause(at(10, 35))

	if len(*events) != 2 || (*events)[1].endedAt != at(10, 35) {
		t.Fatalf("pause must end the period at the pause, got %+v", *events)
	}

	// While paused, samples are ignored entirely.
	tracker.Sample(3000, at(11, 0))
	if len(*events) != 2 {
		t.Errorf("a paused tracker must not record, got %+v", *events)
	}
}

func TestThresholdIsConfigurable(t *testing.T) {
	// The backend owns the threshold; the agent must follow it rather than
	// hardcoding 300 and drifting out of step.
	at := func(m int) time.Time { return time.Date(2026, 9, 4, 10, m, 0, 0, time.UTC) }
	tracker, events := newTestTracker(5 * time.Minute)
	tracker.SetThreshold(10 * time.Minute)

	tracker.Sample(360, at(6)) // 6 min — under the new threshold
	if len(*events) != 0 {
		t.Fatalf("6m must not qualify under a 10m threshold, got %+v", *events)
	}
	tracker.Sample(600, at(10)) // 10 min — qualifies
	if len(*events) != 1 {
		t.Fatalf("10m must qualify, got %+v", *events)
	}
}

func TestInactivityNeverStartsBeforeMonitoringDid(t *testing.T) {
	// Someone away for 20 minutes who then starts a session has been inactive,
	// but not inside this session. Back-dating past the start would report more
	// inactive time than the day ever monitored.
	at := func(h, m int) time.Time { return time.Date(2026, 9, 4, h, m, 0, 0, time.UTC) }
	var events []idleEvent
	tracker := NewIdleTracker(5*time.Minute, func(idle bool, startedAt, endedAt time.Time, duration time.Duration) {
		events = append(events, idleEvent{idle, startedAt, endedAt, duration})
	})
	tracker.Start(at(10, 0))

	// First sample: the OS says input stopped 20 minutes ago, at 09:40.
	tracker.Sample(1200, at(10, 0))
	if len(events) != 1 {
		t.Fatalf("expected the period to open, got %+v", events)
	}
	if got := events[0].startedAt; !got.Equal(at(10, 0)) {
		t.Errorf("must be clamped to the 10:00 start, got %s", got.Format("15:04"))
	}

	tracker.Sample(1, at(10, 10))
	if len(events) != 2 {
		t.Fatalf("expected the period to close, got %+v", events)
	}
	if events[1].duration != 10*time.Minute {
		t.Errorf("duration must be the 10m inside the session, got %s", events[1].duration)
	}
}

func TestResumeAlsoBoundsInactivity(t *testing.T) {
	// The same rule after a pause: paused time is not monitored time.
	at := func(h, m int) time.Time { return time.Date(2026, 9, 4, h, m, 0, 0, time.UTC) }
	tracker, events := newTestTracker(5 * time.Minute)

	tracker.Pause(at(10, 0))
	tracker.Resume(at(11, 0))
	tracker.Sample(3600, at(11, 0)) // OS: no input for an hour, i.e. since 10:00

	if len(*events) != 1 {
		t.Fatalf("expected one event, got %+v", *events)
	}
	if got := (*events)[0].startedAt; !got.Equal(at(11, 0)) {
		t.Errorf("must be clamped to the 11:00 resume, got %s", got.Format("15:04"))
	}
}
