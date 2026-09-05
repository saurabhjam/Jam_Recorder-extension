//go:build linux

package platform

// Linux foreground detection.
//
// ── X11 vs Wayland is not a detail ──────────────────────────────────────────
// Under X11 any client can ask which window has focus, so this works. Under
// Wayland it deliberately cannot: the protocol does not expose the focused
// window to unprivileged clients, and there is no portal for it. Running X11
// tooling under Wayland returns either nothing or the XWayland subset, which
// would silently under-report the day.
//
// So the session type is probed at startup and the capability is reported
// honestly. Under Wayland the agent reports foregroundApplication=false, the
// extension shows application tracking as unavailable, and monitoring falls
// back to screenshots plus browser-profile activity. It does not invent rows.
//
// ── Why subprocesses rather than linking Xlib ───────────────────────────────
// Linking Xlib needs cgo, which means a C cross-toolchain per target
// architecture in CI and a hard dependency on X11 dev headers at build time —
// for a handful of property reads. `xprop`/`xdotool` are packaged everywhere
// X11 is, and the .deb declares them, so the cost is a dependency line rather
// than a build matrix. Idle time comes from `xprintidle` where present and
// falls back to a direct XScreenSaver read via `xprop` otherwise.

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bestq/native-monitor/internal/protocol"
)

const commandTimeout = 3 * time.Second

type sessionKind int

const (
	sessionUnknown sessionKind = iota
	sessionX11
	sessionWayland
)

type linuxMonitor struct {
	probeOnce sync.Once
	session   sessionKind
	hasXdotool  bool
	hasXprop    bool
	hasXprintidle bool
}

// New returns the Linux implementation.
func New() Monitor { return &linuxMonitor{} }

func (l *linuxMonitor) Name() string { return "linux" }

// probe runs once: the session type and the available helpers cannot change
// without the user logging out, and re-checking on every poll would spawn
// pointless processes for eight hours.
func (l *linuxMonitor) probe() {
	l.probeOnce.Do(func() {
		switch strings.ToLower(os.Getenv("XDG_SESSION_TYPE")) {
		case "wayland":
			l.session = sessionWayland
		case "x11":
			l.session = sessionX11
		default:
			// No XDG_SESSION_TYPE (a bare session, a remote shell). DISPLAY
			// being set is the next best evidence of a usable X server.
			if os.Getenv("WAYLAND_DISPLAY") != "" {
				l.session = sessionWayland
			} else if os.Getenv("DISPLAY") != "" {
				l.session = sessionX11
			} else {
				l.session = sessionUnknown
			}
		}
		l.hasXdotool = lookPath("xdotool")
		l.hasXprop = lookPath("xprop")
		l.hasXprintidle = lookPath("xprintidle")
	})
}

func lookPath(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// run executes a helper with a timeout so a hung X server cannot stall the
// poll loop indefinitely.
func run(name string, args ...string) (string, error) {
	ctxCmd := exec.Command(name, args...)
	var out strings.Builder
	ctxCmd.Stdout = &out
	if err := ctxCmd.Start(); err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- ctxCmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(out.String()), nil
	case <-time.After(commandTimeout):
		_ = ctxCmd.Process.Kill()
		return "", errors.New(name + " timed out")
	}
}

func (l *linuxMonitor) Foreground() (*Window, error) {
	l.probe()

	if l.session == sessionWayland {
		// Not a failure to retry — a documented platform limitation. Reported
		// once through Capabilities; returning nil here keeps the interval
		// engine from attributing time to a guess.
		return nil, nil
	}
	if !l.hasXdotool {
		return nil, errors.New("xdotool is not installed; application tracking is unavailable")
	}

	windowID, err := run("xdotool", "getactivewindow")
	if err != nil || windowID == "" {
		// No active window: a desktop with nothing focused, or a screen lock.
		return nil, nil
	}

	title, _ := run("xdotool", "getwindowname", windowID)

	pidText, err := run("xdotool", "getwindowpid", windowID)
	if err != nil || pidText == "" {
		// Some windows carry no _NET_WM_PID. The title is still real, so the
		// interval is reported with what is known rather than dropped.
		if title == "" {
			return nil, nil
		}
		return &Window{ApplicationName: title, Title: title}, nil
	}

	pid, convErr := strconv.Atoi(pidText)
	if convErr != nil {
		return nil, nil
	}

	executable := processName(pid)
	if executable == "" {
		if title == "" {
			return nil, nil
		}
		return &Window{ApplicationName: title, Title: title, ProcessID: pid}, nil
	}

	return &Window{
		ApplicationName: friendlyName(executable),
		ApplicationID:   executable,
		ProcessID:       pid,
		Title:           title,
	}, nil
}

// processName reads the executable name from /proc.
//
// `/proc/<pid>/comm` is truncated to 15 characters, so the exe symlink is read
// first — "code" from a truncated comm would be indistinguishable from other
// binaries.
func processName(pid int) string {
	if target, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe")); err == nil {
		if base := filepath.Base(target); base != "" && base != "." {
			return base
		}
	}
	if data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "comm")); err == nil {
		return strings.TrimSpace(string(data))
	}
	return ""
}

func friendlyName(executable string) string {
	known := map[string]string{
		"chrome":         "Google Chrome",
		"google-chrome":  "Google Chrome",
		"chromium":       "Chromium",
		"brave":          "Brave Browser",
		"brave-browser":  "Brave Browser",
		"microsoft-edge": "Microsoft Edge",
		"firefox":        "Mozilla Firefox",
		"code":           "Visual Studio Code",
		"codium":         "VSCodium",
		"slack":          "Slack",
		"discord":        "Discord",
		"gnome-terminal-server": "Terminal",
		"konsole":               "Konsole",
		"alacritty":             "Alacritty",
		"kitty":                 "Kitty",
		"nautilus":              "Files",
		"dolphin":               "Dolphin",
		"thunar":                "Thunar",
		"idea":                  "IntelliJ IDEA",
		"postman":               "Postman",
	}
	if friendly, ok := known[executable]; ok {
		return friendly
	}
	if executable == "" {
		return ""
	}
	return strings.ToUpper(executable[:1]) + executable[1:]
}

// IdleSeconds via XScreenSaver.
//
// `xprintidle` reports milliseconds since the last input for the whole X
// session. Under Wayland there is no equivalent an unprivileged client can
// read, so idle detection is reported as unavailable rather than approximated
// from browser events — which would miss exactly the case that matters, a user
// away from the machine entirely.
func (l *linuxMonitor) IdleSeconds() (float64, error) {
	l.probe()
	if l.session == sessionWayland {
		return 0, errors.New("idle detection is not available under Wayland")
	}
	if !l.hasXprintidle {
		return 0, errors.New("xprintidle is not installed; idle detection is unavailable")
	}
	out, err := run("xprintidle")
	if err != nil {
		return 0, err
	}
	ms, convErr := strconv.ParseInt(out, 10, 64)
	if convErr != nil {
		return 0, convErr
	}
	return float64(ms) / 1000.0, nil
}

func (l *linuxMonitor) Capabilities() protocol.Capabilities {
	l.probe()
	x11 := l.session == sessionX11
	return protocol.Capabilities{
		ForegroundApplication: x11 && l.hasXdotool,
		WindowTitle:           x11 && l.hasXdotool,
		ProcessIdentifier:     x11 && l.hasXdotool,
		BrowserProfile:        x11 && l.hasXdotool,
		ExactBrowserURL:       false,
		IdleDetection:         x11 && l.hasXprintidle,
	}
}

func (l *linuxMonitor) Permissions() protocol.Permissions {
	l.probe()
	// Not an OS permission but the same shape of problem from the user's point
	// of view: something is missing and the UI must say what.
	tools := l.hasXdotool && l.hasXprintidle
	return protocol.Permissions{X11Tools: &tools}
}
