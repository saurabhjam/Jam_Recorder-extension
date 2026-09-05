package core

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Logging.
//
// ── stdout is off limits ────────────────────────────────────────────────────
// stdout carries framed Native Messaging messages and nothing else. A single
// stray byte there desynchronises the length prefix and Chrome closes the port,
// which presents as "the agent does not work" with no clue why. So every
// diagnostic goes to stderr and to a rotating file.
//
// ── What is never logged ────────────────────────────────────────────────────
// No JWTs, no cookies, no keystrokes, no page content, no full URLs with query
// strings. Window titles are logged only after RedactTitle, and even then
// truncated further: a log file lives on disk long after the session and is the
// easiest place for something sensitive to be forgotten.

const (
	maxLogFileBytes = 2 << 20 // 2 MiB, then rotate once
	maxLoggedTitle  = 60
)

type Logger struct {
	mu   sync.Mutex
	file *os.File
	path string
	size int64
}

var defaultLogger = &Logger{}

// InitLogging opens the rotating log file. Failure is not fatal: stderr still
// works, and an agent that refuses to run because it cannot write a log would
// be worse than one that runs without one.
func InitLogging() {
	dir, err := logDir()
	if err != nil {
		return
	}
	if mkErr := os.MkdirAll(dir, 0o700); mkErr != nil {
		return
	}
	path := filepath.Join(dir, "agent.log")
	file, openErr := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if openErr != nil {
		return
	}
	info, _ := file.Stat()

	defaultLogger.mu.Lock()
	defaultLogger.file = file
	defaultLogger.path = path
	if info != nil {
		defaultLogger.size = info.Size()
	}
	defaultLogger.mu.Unlock()
}

// logDir is per-user and mode 0700: the log names applications the user had
// open, which is their business and nobody else's on a shared machine.
func logDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Logs", "BestQ"), nil
	case "windows":
		if appData := os.Getenv("LOCALAPPDATA"); appData != "" {
			return filepath.Join(appData, "BestQ", "logs"), nil
		}
		return filepath.Join(home, "AppData", "Local", "BestQ", "logs"), nil
	default:
		if state := os.Getenv("XDG_STATE_HOME"); state != "" {
			return filepath.Join(state, "bestq"), nil
		}
		return filepath.Join(home, ".local", "state", "bestq"), nil
	}
}

// Logf writes a structured line to stderr and the log file.
func Logf(level, event string, pairs ...any) {
	var builder strings.Builder
	builder.WriteString(time.Now().UTC().Format(time.RFC3339))
	builder.WriteString(" ")
	builder.WriteString(level)
	builder.WriteString(" ")
	builder.WriteString(event)
	for i := 0; i+1 < len(pairs); i += 2 {
		builder.WriteString(fmt.Sprintf(" %v=%v", pairs[i], pairs[i+1]))
	}
	line := builder.String() + "\n"

	// stderr, never stdout.
	_, _ = io.WriteString(os.Stderr, "[bestq-agent] "+line)

	defaultLogger.mu.Lock()
	defer defaultLogger.mu.Unlock()
	if defaultLogger.file == nil {
		return
	}
	if defaultLogger.size+int64(len(line)) > maxLogFileBytes {
		defaultLogger.rotateLocked()
	}
	written, err := defaultLogger.file.WriteString(line)
	if err == nil {
		defaultLogger.size += int64(written)
	}
}

// rotateLocked keeps exactly one previous file. More history is not worth the
// disk for a log whose only job is explaining a failure that just happened.
func (l *Logger) rotateLocked() {
	if l.file == nil {
		return
	}
	_ = l.file.Close()
	_ = os.Rename(l.path, l.path+".1")
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		l.file = nil
		return
	}
	l.file = file
	l.size = 0
}

// CloseLogging flushes and closes the file.
func CloseLogging() {
	defaultLogger.mu.Lock()
	defer defaultLogger.mu.Unlock()
	if defaultLogger.file != nil {
		_ = defaultLogger.file.Close()
		defaultLogger.file = nil
	}
}

// SafeTitle prepares a window title for a log line.
//
// Already-redacted titles are truncated further here: a log persists on disk
// long after the session, so it gets less than the wire does.
func SafeTitle(title string) string {
	if title == "" {
		return "-"
	}
	safe := RedactTitle(title)
	runes := []rune(safe)
	if len(runes) > maxLoggedTitle {
		return string(runes[:maxLoggedTitle]) + "…"
	}
	return safe
}
