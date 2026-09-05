//go:build windows

package platform

// Windows foreground detection via user32/kernel32.
//
// Uses `syscall` rather than cgo deliberately: it keeps the build free of a C
// toolchain, which is what lets a release be cross-compiled from CI on any
// host. Every call here is a documented Win32 API with no permission
// requirement — an interactive desktop session is the only prerequisite, which
// is why the agent runs as a per-user startup process and not as a system
// service (a service in session 0 cannot see the user's desktop at all).

import (
	"errors"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"github.com/bestq/native-monitor/internal/protocol"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetWindowTextW           = user32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW     = user32.NewProc("GetWindowTextLengthW")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procGetLastInputInfo         = user32.NewProc("GetLastInputInfo")

	procGetTickCount64            = kernel32.NewProc("GetTickCount64")
	procOpenProcess               = kernel32.NewProc("OpenProcess")
	procCloseHandle               = kernel32.NewProc("CloseHandle")
	procQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
)

const (
	processQueryLimitedInformation = 0x1000
	maxPathLength                  = 32768
)

// lastInputInfo mirrors LASTINPUTINFO.
type lastInputInfo struct {
	cbSize uint32
	dwTime uint32
}

type windowsMonitor struct{}

// New returns the Windows implementation.
func New() Monitor { return &windowsMonitor{} }

func (w *windowsMonitor) Name() string { return "windows" }

func (w *windowsMonitor) Foreground() (*Window, error) {
	handle, _, _ := procGetForegroundWindow.Call()
	if handle == 0 {
		// No foreground window: the lock screen, a UAC prompt on the secure
		// desktop, or a moment between windows. Unknown, not an error.
		return nil, nil
	}

	var pid uint32
	procGetWindowThreadProcessID.Call(handle, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return nil, errors.New("foreground window has no owning process")
	}

	// The FOCUSED window's title, not the process's MainWindowTitle: for a
	// multi-window application those differ, and the main window's title would
	// describe a window the user is not looking at.
	title := windowText(handle)

	executable := processImageName(pid)
	appID := strings.ToLower(filepath.Base(executable))
	name := friendlyName(appID)

	if name == "" {
		return nil, errors.New("foreground process has no usable name")
	}

	return &Window{
		ApplicationName: name,
		ApplicationID:   appID,
		ProcessID:       int(pid),
		Title:           title,
	}, nil
}

func windowText(handle uintptr) string {
	length, _, _ := procGetWindowTextLengthW.Call(handle)
	if length == 0 {
		return ""
	}
	buf := make([]uint16, length+1)
	written, _, _ := procGetWindowTextW.Call(handle, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if written == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:written])
}

// processImageName resolves the executable path for a pid.
//
// PROCESS_QUERY_LIMITED_INFORMATION is used rather than the broader
// PROCESS_QUERY_INFORMATION: it is the least access that answers the question
// and it works against elevated processes without the agent being elevated.
func processImageName(pid uint32) string {
	handle, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if handle == 0 {
		return ""
	}
	defer procCloseHandle.Call(handle)

	buf := make([]uint16, maxPathLength)
	size := uint32(len(buf))
	ret, _, _ := procQueryFullProcessImageName.Call(
		handle, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if ret == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:size])
}

// friendlyName maps an executable to something a person recognises.
//
// A small explicit table rather than reading the file's version resource: the
// resource read needs another API surface and returns inconsistent strings
// across vendors, while these few names cover the applications that actually
// matter in a working day. Anything unmapped falls back to the executable stem,
// which is honest — "unrecognised app" is better than a wrong label.
func friendlyName(executable string) string {
	known := map[string]string{
		"chrome.exe":     "Google Chrome",
		"msedge.exe":     "Microsoft Edge",
		"brave.exe":      "Brave Browser",
		"firefox.exe":    "Mozilla Firefox",
		"opera.exe":      "Opera",
		"vivaldi.exe":    "Vivaldi",
		"code.exe":       "Visual Studio Code",
		"devenv.exe":     "Visual Studio",
		"idea64.exe":     "IntelliJ IDEA",
		"pycharm64.exe":  "PyCharm",
		"webstorm64.exe": "WebStorm",
		"slack.exe":      "Slack",
		"teams.exe":      "Microsoft Teams",
		"ms-teams.exe":   "Microsoft Teams",
		"outlook.exe":    "Microsoft Outlook",
		"excel.exe":      "Microsoft Excel",
		"winword.exe":    "Microsoft Word",
		"powerpnt.exe":   "Microsoft PowerPoint",
		"explorer.exe":   "File Explorer",
		"windowsterminal.exe": "Windows Terminal",
		"wt.exe":              "Windows Terminal",
		"powershell.exe":      "PowerShell",
		"pwsh.exe":            "PowerShell",
		"cmd.exe":             "Command Prompt",
		"notepad.exe":         "Notepad",
		"discord.exe":         "Discord",
		"zoom.exe":            "Zoom",
		"postman.exe":         "Postman",
		"docker desktop.exe":  "Docker Desktop",
	}
	if friendly, ok := known[executable]; ok {
		return friendly
	}
	stem := strings.TrimSuffix(executable, filepath.Ext(executable))
	if stem == "" {
		return ""
	}
	// Title-case the stem so "slack" reads as "Slack" rather than shouting.
	return strings.ToUpper(stem[:1]) + stem[1:]
}

// IdleSeconds via GetLastInputInfo.
//
// Reports a real duration, machine-wide, with no permission needed — which is
// what the inactivity model requires. The extension's chrome.idle only signals
// a threshold crossing, so it could not distinguish a 6-minute absence from a
// 40-minute one.
func (w *windowsMonitor) IdleSeconds() (float64, error) {
	info := lastInputInfo{cbSize: uint32(unsafe.Sizeof(lastInputInfo{}))}
	ret, _, err := procGetLastInputInfo.Call(uintptr(unsafe.Pointer(&info)))
	if ret == 0 {
		return 0, err
	}
	ticks, _, _ := procGetTickCount64.Call()
	// dwTime is a 32-bit tick count that wraps every ~49.7 days; GetTickCount64
	// does not. Comparing them in the low 32 bits keeps the arithmetic correct
	// across a wrap instead of producing a huge bogus idle time.
	now := uint32(uint64(ticks) & 0xFFFFFFFF)
	elapsed := now - info.dwTime
	return float64(elapsed) / 1000.0, nil
}

func (w *windowsMonitor) Capabilities() protocol.Capabilities {
	// All of these are unconditionally available to a process in the user's
	// interactive session — Windows requires no grant for any of them.
	return protocol.Capabilities{
		ForegroundApplication: true,
		WindowTitle:           true,
		ProcessIdentifier:     true,
		BrowserProfile:        true,
		ExactBrowserURL:       false,
		IdleDetection:         true,
	}
}

func (w *windowsMonitor) Permissions() protocol.Permissions {
	// Nothing to grant. Both fields stay nil so the extension can distinguish
	// "not required on this platform" from "required and missing".
	return protocol.Permissions{}
}
