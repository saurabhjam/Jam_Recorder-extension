package core

import (
	"strings"
	"testing"
	"time"

	"github.com/bestq/native-monitor/internal/platform"
	"github.com/bestq/native-monitor/internal/protocol"
)

func newTestEngine() (*ActivityEngine, *[]protocol.Activity) {
	var emitted []protocol.Activity
	engine := NewActivityEngine(func(a protocol.Activity) { emitted = append(emitted, a) })
	engine.Start("sess-1")
	return engine, &emitted
}

func at(h, m, s int) time.Time { return time.Date(2026, 9, 4, h, m, s, 0, time.UTC) }

func TestSameWindowSampledRepeatedlyIsOneInterval(t *testing.T) {
	// The whole point of identity: an hour in one application must be one row,
	// not 1800 two-second rows that sum correctly and describe nothing.
	engine, emitted := newTestEngine()
	win := &platform.Window{ApplicationName: "Slack", ApplicationID: "com.tinyspeck.slackmacgap", Title: "general"}

	for second := 0; second < 60; second += 2 {
		engine.Sample(win, at(10, 0, second))
	}
	if len(*emitted) != 0 {
		t.Fatalf("unchanged focus must emit nothing, got %d", len(*emitted))
	}

	engine.Flush(at(10, 25, 0))
	if len(*emitted) != 1 {
		t.Fatalf("expected one interval, got %d", len(*emitted))
	}
	if (*emitted)[0].DurationSecs != 1500 {
		t.Errorf("expected 1500s, got %d", (*emitted)[0].DurationSecs)
	}
}

func TestFocusChangeClosesThePreviousIntervalAtTheChange(t *testing.T) {
	engine, emitted := newTestEngine()
	engine.Sample(&platform.Window{ApplicationName: "Visual Studio Code", ApplicationID: "com.microsoft.VSCode", Title: "a.ts"}, at(10, 0, 0))
	engine.Sample(&platform.Window{ApplicationName: "Slack", ApplicationID: "com.tinyspeck.slackmacgap", Title: "general"}, at(10, 25, 0))

	if len(*emitted) != 1 {
		t.Fatalf("expected the first interval closed, got %d", len(*emitted))
	}
	got := (*emitted)[0]
	if got.ApplicationName != "Visual Studio Code" {
		t.Errorf("wrong application: %s", got.ApplicationName)
	}
	if got.DurationSecs != 1500 {
		t.Errorf("expected 1500s, got %d", got.DurationSecs)
	}
	if got.ClientActivityID == "" {
		t.Error("every interval needs an idempotency key")
	}
}

func TestNilSampleDoesNotSplitAnInterval(t *testing.T) {
	// A failed OS probe is "unknown", not "focus lost". Treating it as a change
	// would chop a continuous 25-minute stretch in two.
	engine, emitted := newTestEngine()
	win := &platform.Window{ApplicationName: "Terminal", ApplicationID: "com.apple.Terminal", Title: "zsh"}

	engine.Sample(win, at(10, 0, 0))
	engine.Sample(nil, at(10, 0, 2))
	engine.Sample(nil, at(10, 0, 4))
	engine.Sample(win, at(10, 0, 6))

	if len(*emitted) != 0 {
		t.Fatalf("a failed probe must not close the interval, got %+v", *emitted)
	}
}

func TestSubSecondFlickThroughIsDropped(t *testing.T) {
	engine, emitted := newTestEngine()
	engine.Sample(&platform.Window{ApplicationName: "Finder", ApplicationID: "com.apple.finder"}, time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC))
	engine.Sample(&platform.Window{ApplicationName: "Slack", ApplicationID: "com.tinyspeck.slackmacgap"}, time.Date(2026, 9, 4, 10, 0, 0, 300*int(time.Millisecond), time.UTC))

	if len(*emitted) != 0 {
		t.Fatalf("alt-tabbing through is not working in an app, got %+v", *emitted)
	}
}

func TestStopClosesTheOpenIntervalAtStopTime(t *testing.T) {
	// The final stretch of a session is often the longest; losing it was a real
	// defect in the previous implementation.
	engine, emitted := newTestEngine()
	engine.Sample(&platform.Window{ApplicationName: "Google Chrome", ApplicationID: "com.google.Chrome", Title: "GitHub - Google Chrome"}, at(10, 30, 0))
	engine.Stop(at(11, 0, 0))

	if len(*emitted) != 1 {
		t.Fatalf("stop must close the open interval, got %d", len(*emitted))
	}
	if (*emitted)[0].EndedAt == "" {
		t.Error("the closed interval needs an end time")
	}
	if (*emitted)[0].DurationSecs != 1800 {
		t.Errorf("expected 1800s, got %d", (*emitted)[0].DurationSecs)
	}
}

func TestBrowserIntervalCarriesProfileAndNeverAURL(t *testing.T) {
	// A window title is not a URL, and for another Chrome profile there is no
	// way to obtain one. pageUrl must stay empty.
	engine, emitted := newTestEngine()
	engine.Sample(&platform.Window{
		ApplicationName: "Google Chrome",
		ApplicationID:   "com.google.Chrome",
		Title:           "ChatGPT - Google Chrome – Profile 2",
	}, at(10, 0, 0))
	engine.Stop(at(10, 10, 0))

	if len(*emitted) != 1 {
		t.Fatalf("expected one interval, got %d", len(*emitted))
	}
	got := (*emitted)[0]
	if got.BrowserName != "Google Chrome" {
		t.Errorf("browserName: %q", got.BrowserName)
	}
	if got.BrowserProfile != "Profile 2" {
		t.Errorf("browserProfile must be extracted, got %q", got.BrowserProfile)
	}
	if got.PageURL != "" {
		t.Errorf("pageUrl must never be fabricated, got %q", got.PageURL)
	}
}

func TestPageChangeInsideTheBrowserIsANewInterval(t *testing.T) {
	engine, emitted := newTestEngine()
	engine.Sample(&platform.Window{ApplicationName: "Google Chrome", ApplicationID: "com.google.Chrome", Title: "Board - Jira - Google Chrome"}, at(10, 0, 0))
	engine.Sample(&platform.Window{ApplicationName: "Google Chrome", ApplicationID: "com.google.Chrome", Title: "Issue 12 - Jira - Google Chrome"}, at(10, 10, 0))

	if len(*emitted) != 1 {
		t.Fatalf("a page change is a new interval, got %d", len(*emitted))
	}
	if !strings.Contains((*emitted)[0].WindowTitle, "Board") {
		t.Errorf("first interval should be the board, got %q", (*emitted)[0].WindowTitle)
	}
}

func TestPasswordManagerTitleIsSuppressedButTimeIsKept(t *testing.T) {
	engine, emitted := newTestEngine()
	engine.Sample(&platform.Window{
		ApplicationName: "1Password",
		ApplicationID:   "com.1password.1password",
		Title:           "AWS root account — 1Password",
	}, at(10, 0, 0))
	engine.Stop(at(10, 5, 0))

	if len(*emitted) != 1 {
		t.Fatalf("expected one interval, got %d", len(*emitted))
	}
	got := (*emitted)[0]
	if got.WindowTitle != "" {
		t.Errorf("a password manager's title must be dropped, got %q", got.WindowTitle)
	}
	if !got.TitleSuppressed {
		t.Error("suppression must be flagged so the UI can explain the blank")
	}
	if got.ApplicationName != "1Password" || got.DurationSecs != 300 {
		t.Error("the time must still be attributed to the application")
	}
}

func TestIdempotencyKeysAreUniqueAndDeterministic(t *testing.T) {
	// The backend dedupes on this, so a resend after a reconnect must not
	// create a second row — and two different intervals must not collide.
	engine, emitted := newTestEngine()
	engine.Sample(&platform.Window{ApplicationName: "A", ApplicationID: "a"}, at(10, 0, 0))
	engine.Sample(&platform.Window{ApplicationName: "B", ApplicationID: "b"}, at(10, 1, 0))
	engine.Sample(&platform.Window{ApplicationName: "C", ApplicationID: "c"}, at(10, 2, 0))

	if len(*emitted) != 2 {
		t.Fatalf("expected two closed intervals, got %d", len(*emitted))
	}
	if (*emitted)[0].ClientActivityID == (*emitted)[1].ClientActivityID {
		t.Error("idempotency keys collided")
	}
	for _, activity := range *emitted {
		if !strings.HasPrefix(activity.ClientActivityID, "native-sess-1-") {
			t.Errorf("key should be session-scoped, got %q", activity.ClientActivityID)
		}
		if activity.SessionID != "sess-1" {
			t.Errorf("interval must carry its session, got %q", activity.SessionID)
		}
	}
}

func TestNoIntervalIsRecordedWithoutASession(t *testing.T) {
	// Activity outside a monitoring session belongs to nothing.
	var emitted []protocol.Activity
	engine := NewActivityEngine(func(a protocol.Activity) { emitted = append(emitted, a) })
	engine.Sample(&platform.Window{ApplicationName: "Slack", ApplicationID: "s"}, at(10, 0, 0))
	engine.Flush(at(10, 10, 0))
	if len(emitted) != 0 {
		t.Fatalf("no session means no activity, got %+v", emitted)
	}
}

func TestPauseClosesTheIntervalAtThePause(t *testing.T) {
	engine, emitted := newTestEngine()
	engine.Sample(&platform.Window{ApplicationName: "Slack", ApplicationID: "s", Title: "general"}, at(10, 0, 0))
	engine.Pause(at(10, 10, 0))
	engine.Sample(&platform.Window{ApplicationName: "Slack", ApplicationID: "s", Title: "general"}, at(10, 30, 0))

	if len(*emitted) != 1 {
		t.Fatalf("expected exactly the pre-pause interval, got %d", len(*emitted))
	}
	if (*emitted)[0].DurationSecs != 600 {
		t.Errorf("interval must end at the pause (600s), got %d", (*emitted)[0].DurationSecs)
	}
}
