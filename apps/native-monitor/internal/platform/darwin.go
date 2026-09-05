//go:build darwin

package platform

/*
#cgo CFLAGS: -x objective-c -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Cocoa -framework ApplicationServices -framework CoreGraphics
#include <stdlib.h>
#include <string.h>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>

// Frontmost application, via NSWorkspace.
//
// NSWorkspace needs no special permission, which is why the application name,
// bundle id and pid are always available even when the window title is not.
// Every returned string is strdup'd for Go to free — the autoreleased NSString
// backing would otherwise be reclaimed before Go copies it.
typedef struct {
    char *name;
    char *bundleId;
    int   pid;
} FrontApp;

// Frontmost pid, straight from the window server.
//
// This exists because -[NSWorkspace frontmostApplication] IS NOT USABLE HERE.
// That property is maintained from workspace notifications, which are delivered
// on a run loop — and this agent is a stdio tool that never runs one. The value
// is therefore latched at the first read and never changes again. Chrome
// launches the agent, so Chrome is frontmost at that instant, and every sample
// for the rest of the session reported "Google Chrome" no matter what the user
// actually did. A session spent in an editor was recorded as a session spent in
// the browser, and no application switch was ever observed.
//
// CGWindowListCopyWindowInfo asks the window server for current state on every
// call, so it cannot go stale. The list is ordered front-to-back; the first
// window at layer 0 is the frontmost ordinary window. Higher layers are menu
// bars, docks, popovers and overlays, which are not what the user is "in".
//
// Only the owner's pid is taken from here. kCGWindowName — the title — is
// deliberately not read: it needs Screen Recording, while owner pid and name
// need no permission at all, which is what keeps application tracking working
// with no grant whatsoever.
static int bestq_frontmost_pid(void) {
    int pid = 0;
    CFArrayRef windows = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (windows == NULL) return 0;

    CFIndex count = CFArrayGetCount(windows);
    for (CFIndex i = 0; i < count; i++) {
        CFDictionaryRef window = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);
        if (window == NULL) continue;

        CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(window, kCGWindowLayer);
        int layer = -1;
        if (layerRef == NULL || !CFNumberGetValue(layerRef, kCFNumberIntType, &layer)) continue;
        if (layer != 0) continue;

        CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(window, kCGWindowOwnerPID);
        if (pidRef != NULL && CFNumberGetValue(pidRef, kCFNumberIntType, &pid) && pid > 0) {
            break;
        }
        pid = 0;
    }
    CFRelease(windows);
    return pid;
}

static FrontApp bestq_front_app(void) {
    FrontApp out = {NULL, NULL, 0};
    @autoreleasepool {
        NSRunningApplication *app = nil;

        int pid = bestq_frontmost_pid();
        if (pid > 0) {
            // A direct lookup by pid, unlike frontmostApplication, is answered
            // from live process state rather than from notification history.
            app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
        }
        if (app == nil) {
            // No ordinary window on screen: the login window, a screen lock, a
            // fast user switch, or an agent with only a menu bar item. Stale as
            // this is, it is better than reporting nothing at all.
            app = [[NSWorkspace sharedWorkspace] frontmostApplication];
        }
        if (app == nil) return out;

        NSString *name = [app localizedName];
        NSString *bundle = [app bundleIdentifier];
        if (name != nil)   out.name     = strdup([name UTF8String]);
        if (bundle != nil) out.bundleId = strdup([bundle UTF8String]);
        out.pid = (int)[app processIdentifier];
    }
    return out;
}

// Is this process trusted for Accessibility?
//
// AXIsProcessTrusted is the only honest way to answer "can I read window
// titles". Without the grant the AX calls below return errors rather than
// prompting, so the agent must report PERMISSION_REQUIRED instead of quietly
// reporting every application with an empty title.
static int bestq_ax_trusted(void) {
    return AXIsProcessTrusted() ? 1 : 0;
}

// Focused window title of a given pid, via the Accessibility API.
//
// Requires the Accessibility grant. Returns NULL when unavailable for any
// reason — no grant, an app that exposes no AX tree (some Electron and Java
// apps), or no focused window. NULL means "unknown", and the caller must not
// turn that into an empty-string title.
// Read one window's title from an app element, or NULL.
static char *bestq_copy_title(AXUIElementRef app);

static char *bestq_window_title(int pid) {
    char *result = NULL;
    @autoreleasepool {
        if (!AXIsProcessTrusted()) return NULL;

        AXUIElementRef app = AXUIElementCreateApplication((pid_t)pid);
        if (app == NULL) return NULL;

        // Google Chrome on macOS is measured here and reports an *empty*
        // AXTitle: the focused window resolves, the attribute exists, its value
        // is "". Setting AXManualAccessibility / AXEnhancedUserInterface does
        // not change that, so there is no window title for a Chrome window and
        // therefore no profile name to parse out of one. Chrome time is still
        // attributed correctly as Google Chrome, with its real duration — the
        // application is known, the page inside it is not. Nothing is invented
        // to fill the gap.
        result = bestq_copy_title(app);
        CFRelease(app);
    }
    return result;
}

static char *bestq_copy_title(AXUIElementRef app) {
    char *result = NULL;
    @autoreleasepool {
        CFTypeRef window = NULL;
        AXError err = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window);
        if (err != kAXErrorSuccess || window == NULL) {
            // Fall back to the main window: a frontmost app with no *focused*
            // window (a palette in front, a sheet closing) still has a main one.
            err = AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute, &window);
        }
        if (err == kAXErrorSuccess && window != NULL) {
            CFTypeRef title = NULL;
            if (AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXTitleAttribute, &title) == kAXErrorSuccess
                && title != NULL) {
                if (CFGetTypeID(title) == CFStringGetTypeID()) {
                    CFStringRef str = (CFStringRef)title;
                    CFIndex max = CFStringGetMaximumSizeForEncoding(CFStringGetLength(str), kCFStringEncodingUTF8) + 1;
                    char *buf = (char *)malloc((size_t)max);
                    if (buf != NULL) {
                        if (CFStringGetCString(str, buf, max, kCFStringEncodingUTF8)) {
                            result = buf;
                        } else {
                            free(buf);
                        }
                    }
                }
                CFRelease(title);
            }
            CFRelease(window);
        }
    }
    return result;
}

// Seconds since the last keyboard or pointer event, machine-wide.
//
// CGEventSource needs no permission and reports a real duration, which is what
// the inactivity model requires: the extension's chrome.idle only signals a
// threshold crossing, so a 22-minute absence would be recorded as the 5-minute
// threshold. This returns the true 22 minutes.
static double bestq_idle_seconds(void) {
    // kCGAnyInputEventType covers keyboard, mouse, scroll and tablet input, so
    // one query answers "how long since the user touched this machine".
    //
    // An earlier version also passed kCGEventSourceStateHIDSystemState as the
    // second argument, which is a *state id*, not an event type — the compiler
    // flagged the implicit enum conversion. It happens to equal 1, i.e.
    // kCGEventLeftMouseDown, so that call was silently measuring time since the
    // last left click and taking the minimum with the real answer. Harmless by
    // luck, wrong by construction; removed.
    return CGEventSourceSecondsSinceLastEventType(
        kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType);
}
*/
import "C"

import (
	"errors"
	"strings"
	"unsafe"

	"github.com/bestq/native-monitor/internal/protocol"
)

type darwinMonitor struct{}

// New returns the macOS implementation.
func New() Monitor { return &darwinMonitor{} }

func (d *darwinMonitor) Name() string { return "macos" }

func (d *darwinMonitor) Foreground() (*Window, error) {
	front := C.bestq_front_app()
	// Free whatever C allocated, on every path.
	defer func() {
		if front.name != nil {
			C.free(unsafe.Pointer(front.name))
		}
		if front.bundleId != nil {
			C.free(unsafe.Pointer(front.bundleId))
		}
	}()

	if front.name == nil && front.bundleId == nil {
		// No frontmost application: the login window, a fast user switch, or a
		// screen lock. Genuinely unknown rather than an error.
		return nil, nil
	}

	win := &Window{
		ApplicationName: C.GoString(front.name),
		ApplicationID:   C.GoString(front.bundleId),
		ProcessID:       int(front.pid),
	}
	if win.ApplicationName == "" {
		// Fall back to the last bundle-id segment: "com.tinyspeck.slackmacgap"
		// reads as "slackmacgap", which is poor but true.
		if parts := strings.Split(win.ApplicationID, "."); len(parts) > 0 {
			win.ApplicationName = parts[len(parts)-1]
		}
	}
	if win.ApplicationName == "" {
		return nil, errors.New("frontmost application has no usable name")
	}

	// Title needs Accessibility. Its absence is not an error — the interval is
	// still attributed to the right application, just without a title.
	if title := C.bestq_window_title(C.int(front.pid)); title != nil {
		win.Title = C.GoString(title)
		C.free(unsafe.Pointer(title))
	}

	return win, nil
}

func (d *darwinMonitor) IdleSeconds() (float64, error) {
	seconds := float64(C.bestq_idle_seconds())
	if seconds < 0 {
		return 0, errors.New("idle query returned a negative duration")
	}
	return seconds, nil
}

func (d *darwinMonitor) Capabilities() protocol.Capabilities {
	trusted := C.bestq_ax_trusted() == 1
	return protocol.Capabilities{
		// NSWorkspace works without any grant.
		ForegroundApplication: true,
		ProcessIdentifier:     true,
		// Both of these come from the window title, which needs Accessibility.
		WindowTitle:    trusted,
		BrowserProfile: trusted,
		// A window title is not a URL. Never true, on any platform.
		ExactBrowserURL: false,
		IdleDetection:   true,
	}
}

func (d *darwinMonitor) Permissions() protocol.Permissions {
	trusted := C.bestq_ax_trusted() == 1
	return protocol.Permissions{Accessibility: &trusted}
}
