// Package platform wraps the one thing a Chrome extension genuinely cannot do:
// ask the operating system which application is frontmost, and how long the
// machine has been without input.
//
// Each OS gets its own file behind this interface, selected by build tag. The
// interface returns nulls and false capabilities where an OS will not answer —
// it never substitutes a guess, because a fabricated application name in
// somebody's work record is worse than an acknowledged gap.
package platform

import "github.com/bestq/native-monitor/internal/protocol"

// Window describes the frontmost window as the OS reports it.
type Window struct {
	ApplicationName string
	// ApplicationID: bundle identifier on macOS, executable name elsewhere.
	// Never a full path — a path is a filesystem detail, not an app identity.
	ApplicationID string
	ProcessID     int
	// Title is empty when the OS will not disclose it (macOS without
	// Accessibility, Wayland). Empty means unknown, never "no title".
	Title string
}

// Monitor is the per-OS implementation.
type Monitor interface {
	// Foreground returns the frontmost window, or nil when the platform could
	// not answer this time. A nil result is "unknown", not "nothing is
	// focused" — the caller treats it as no-change so a single failed probe
	// cannot chop a continuous interval in two.
	Foreground() (*Window, error)

	// IdleSeconds is how long since the last keyboard or pointer input,
	// machine-wide. This is the value the extension's chrome.idle cannot
	// provide: chrome.idle reports a threshold crossing, not a duration, and
	// only for the browser's own notion of activity.
	IdleSeconds() (float64, error)

	// Capabilities is probed at runtime, not assumed from the OS name.
	Capabilities() protocol.Capabilities

	// Permissions is what the OS currently grants, so the extension can tell
	// "not required here" from "required and missing".
	Permissions() protocol.Permissions

	// Name identifies the platform for the READY handshake.
	Name() string
}

// browserProcesses are the applications whose window titles carry a page title
// and possibly a profile name.
var browserProcesses = []string{
	"google chrome", "google chrome canary", "google chrome beta",
	"chromium", "chrome",
	"brave browser", "brave-browser", "brave",
	"microsoft edge", "msedge", "edge",
	"opera", "vivaldi", "arc",
}
