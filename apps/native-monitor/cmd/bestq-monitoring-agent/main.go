// Command bestq-monitoring-agent is the BestQ desktop monitoring agent.
//
// Chrome launches it as a Native Messaging host (`com.bestq.monitoring`) when
// the BestQ extension connects, and kills it when the port closes. It answers
// the one question a Chrome extension cannot answer for itself — which
// application has OS focus, and how long the machine has been without input —
// and it reports nothing else.
//
// It takes no network connections, opens no ports, reads no files belonging to
// the user, and executes nothing it is told to. Activity metadata goes to the
// extension, which sends it to the backend over its own authenticated session;
// the agent never holds a credential.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/bestq/native-monitor/internal/core"
	"github.com/bestq/native-monitor/internal/platform"
	"github.com/bestq/native-monitor/internal/protocol"
)

// Version is stamped at build time with -ldflags "-X main.Version=x.y.z".
var Version = "1.0.0"

func main() {
	// `--version` and `--probe` exist for the installer and for support, not
	// for normal operation. Both write to stdout and exit before the Native
	// Messaging loop starts, so they can never corrupt a live port.
	showVersion := flag.Bool("version", false, "print the agent version and exit")
	probe := flag.Bool("probe", false, "print detected platform capabilities and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("bestq-monitoring-agent %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return
	}

	monitor := platform.New()

	if *probe {
		runProbe(monitor)
		return
	}

	core.InitLogging()
	defer core.CloseLogging()
	core.Logf("INFO", "agent_started", "version", Version, "platform", monitor.Name(), "arch", runtime.GOARCH)

	writer := protocol.NewWriter(os.Stdout)
	reader := protocol.NewReader(os.Stdin)

	send := func(msg protocol.Outbound) {
		if err := writer.Write(msg); err != nil {
			// A failed write means the port is gone. Logging to stderr is safe;
			// retrying is not, because a partial frame has already gone out.
			core.Logf("WARN", "write_failed", "type", msg.Type, "error", err.Error())
		}
	}

	agent := core.NewAgent(Version, monitor, send)

	// A signal must close the open interval rather than losing it: the process
	// dying is not the same as the user's work stopping at that instant, but the
	// last known boundary is the best available truth.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		core.Logf("INFO", "signal_received")
		agent.StopMonitoring(time.Now(), false)
		core.CloseLogging()
		os.Exit(0)
	}()

	for {
		body, err := reader.Read()
		if err != nil {
			if errors.Is(err, protocol.ErrClosed) {
				// Chrome closed the port: the extension is done with us. The
				// normal shutdown path, not a failure.
				core.Logf("INFO", "port_closed")
			} else {
				core.Logf("ERROR", "read_failed", "error", err.Error())
			}
			agent.StopMonitoring(time.Now(), false)
			return
		}

		msg, decodeErr := protocol.Decode(body)
		if decodeErr != nil {
			// Never trust the input: an unparseable or wrong-version message is
			// refused with a stable code and the loop continues, rather than
			// acting on a half-understood instruction.
			code := protocol.ErrInvalidMessage
			if isVersionError(decodeErr) {
				code = protocol.ErrProtocolMismatch
			}
			core.Logf("WARN", "message_rejected", "error", decodeErr.Error())
			send(protocol.Errorf(code, decodeErr.Error()))
			continue
		}

		handle(agent, msg, send)
	}
}

func handle(agent *core.Agent, msg protocol.Inbound, send func(protocol.Outbound)) {
	now := time.Now()
	switch msg.Type {
	case protocol.TypeHello:
		agent.Hello()

	case protocol.TypeStartMonitoring:
		agent.StartMonitoring(msg.SessionID, msg.IdleThresholdSeconds)

	case protocol.TypeStopMonitoring:
		agent.StopMonitoring(now, true)

	case protocol.TypePause:
		agent.Pause(now)

	case protocol.TypeResume:
		agent.Resume()

	case protocol.TypeFlush:
		agent.Flush(now)

	case protocol.TypeGetStatus:
		agent.Status()

	default:
		// Decode already rejects unknown types; this is belt and braces so a
		// future type added to the allowlist but not handled here is visible.
		send(protocol.Errorf(protocol.ErrInvalidMessage, "unhandled message type "+msg.Type))
	}
}

func isVersionError(err error) bool {
	return err != nil && containsFold(err.Error(), "protocol version")
}

func containsFold(haystack, needle string) bool {
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		matches := true
		for j := 0; j < len(needle); j++ {
			a, b := haystack[i+j], needle[j]
			if a >= 'A' && a <= 'Z' {
				a += 'a' - 'A'
			}
			if b >= 'A' && b <= 'Z' {
				b += 'a' - 'A'
			}
			if a != b {
				matches = false
				break
			}
		}
		if matches {
			return true
		}
	}
	return false
}

// runProbe prints what this machine can do, for the installer and for support
// diagnosis. Human-readable on stdout because no port is open at this point.
func runProbe(monitor platform.Monitor) {
	caps := monitor.Capabilities()
	perms := monitor.Permissions()

	fmt.Printf("agent      %s\n", Version)
	fmt.Printf("platform   %s/%s\n", monitor.Name(), runtime.GOARCH)
	fmt.Printf("capabilities:\n")
	fmt.Printf("  foregroundApplication  %v\n", caps.ForegroundApplication)
	fmt.Printf("  windowTitle            %v\n", caps.WindowTitle)
	fmt.Printf("  processIdentifier      %v\n", caps.ProcessIdentifier)
	fmt.Printf("  browserProfile         %v\n", caps.BrowserProfile)
	fmt.Printf("  exactBrowserUrl        %v  (never available — a title is not a URL)\n", caps.ExactBrowserURL)
	fmt.Printf("  idleDetection          %v\n", caps.IdleDetection)
	if perms.Accessibility != nil {
		fmt.Printf("permissions:\n  accessibility          %v\n", *perms.Accessibility)
	}
	if perms.X11Tools != nil {
		fmt.Printf("permissions:\n  x11Tools               %v\n", *perms.X11Tools)
	}

	if win, err := monitor.Foreground(); err != nil {
		fmt.Printf("foreground: error: %v\n", err)
	} else if win == nil {
		fmt.Printf("foreground: unavailable (platform returned nothing)\n")
	} else {
		fmt.Printf("foreground: %s [%s] pid=%d title=%q\n",
			win.ApplicationName, win.ApplicationID, win.ProcessID, core.SafeTitle(win.Title))
	}

	if seconds, err := monitor.IdleSeconds(); err != nil {
		fmt.Printf("idle: error: %v\n", err)
	} else {
		fmt.Printf("idle: %.1fs since last input\n", seconds)
	}
}
