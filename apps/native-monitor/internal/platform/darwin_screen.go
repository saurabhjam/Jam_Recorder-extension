//go:build darwin

package platform

/*
#cgo CFLAGS: -x objective-c -Wno-deprecated-declarations
#cgo LDFLAGS: -framework CoreGraphics -framework ImageIO -framework CoreFoundation -framework Foundation -framework ScreenCaptureKit
#include <stdlib.h>
#include <string.h>
#include <dispatch/dispatch.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

// Whole-screen capture, so monitoring never opens Chrome's share picker.
//
// The picker offered Tab and Window next to Entire Screen, and no browser API
// can remove those choices — so a session could be pointed at a single tab,
// which makes every screenshot in the report a partial record of what the
// person was doing. Capturing here removes the choice rather than policing it.
//
// ScreenCaptureKit, not CGDisplayCreateImage: the latter is *obsoleted* in the
// macOS 15 SDK — not merely deprecated — as is CGWindowListCreateImage, so
// neither compiles any more. SCK is also what does the downscale, via the
// configuration's pixel dimensions, which avoids a second bitmap pass.
//
// There is deliberately no window or region entry point in this file.
typedef struct {
    unsigned char *data;
    int len;
    int width;
    int height;
} BQFrame;

// Screen Recording is a TCC grant. Without it SCK yields nothing — and on some
// versions yields a desktop-picture-only image, which would look like a working
// session full of blank screenshots. Preflighting lets the agent say
// PERMISSION_REQUIRED instead.
static int bestq_screen_capture_allowed(void) {
    return CGPreflightScreenCaptureAccess() ? 1 : 0;
}

// Ask macOS for the Screen Recording grant, once.
//
// Preflighting alone is not enough, and this was a real dead end:
// CGPreflightScreenCaptureAccess only *checks*, so an agent that never
// requested does not appear in System Settings > Privacy & Security > Screen
// Recording at all. The list showed Chrome, Slack, VS Code and the rest, with
// no bestq-monitoring-agent row — so there was nothing to switch on, and
// capture could never start however many times the user looked.
//
// CGRequestScreenCaptureAccess registers the executable with TCC and raises the
// system prompt, which is what creates that row. It reports the answer for the
// current process; the grant takes effect for a *new* process, which is why the
// agent still says "permission required" for this run and the extension asks
// the user to restart the browser afterwards.
static int bestq_screen_capture_request(void) {
    return CGRequestScreenCaptureAccess() ? 1 : 0;
}

static int bestq_display_count(void) {
    uint32_t count = 0;
    if (CGGetActiveDisplayList(0, NULL, &count) != kCGErrorSuccess) return 0;
    return (int)count;
}

static int bestq_encode_jpeg(CGImageRef image, double quality, BQFrame *out) {
    CFMutableDataRef buffer = CFDataCreateMutable(NULL, 0);
    if (buffer == NULL) return 0;

    CGImageDestinationRef dest =
        CGImageDestinationCreateWithData(buffer, CFSTR("public.jpeg"), 1, NULL);
    if (dest == NULL) { CFRelease(buffer); return 0; }

    CFStringRef keys[] = { kCGImageDestinationLossyCompressionQuality };
    CFNumberRef q = CFNumberCreate(NULL, kCFNumberDoubleType, &quality);
    CFTypeRef values[] = { q };
    CFDictionaryRef props = CFDictionaryCreate(NULL, (const void **)keys,
        (const void **)values, 1, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);

    CGImageDestinationAddImage(dest, image, props);
    int finalised = CGImageDestinationFinalize(dest) ? 1 : 0;

    CFRelease(props);
    CFRelease(q);
    CFRelease(dest);
    if (!finalised) { CFRelease(buffer); return 0; }

    CFIndex length = CFDataGetLength(buffer);
    // Copied into a plain malloc'd buffer so Go owns and frees it directly,
    // rather than its lifetime being tied to a CFRelease from Go code.
    out->data = (unsigned char *)malloc((size_t)length);
    if (out->data == NULL) { CFRelease(buffer); return 0; }
    memcpy(out->data, CFDataGetBytePtr(buffer), (size_t)length);
    out->len = (int)length;
    CFRelease(buffer);
    return 1;
}

// -1 permission denied, 0 other failure, 1 success.
static int bestq_capture_screen(int maxEdge, double quality, BQFrame *out) {
    out->data = NULL; out->len = 0; out->width = 0; out->height = 0;

    if (!CGPreflightScreenCaptureAccess()) return -1;

    if (@available(macOS 14.0, *)) {
        __block CGImageRef captured = NULL;
        dispatch_semaphore_t done = dispatch_semaphore_create(0);

        [SCShareableContent getShareableContentWithCompletionHandler:
            ^(SCShareableContent *content, NSError *error) {
                if (error != nil || content == nil || content.displays.count == 0) {
                    dispatch_semaphore_signal(done);
                    return;
                }
                // The first display. DisplayCount travels with the frame so a
                // multi-monitor machine is reported as a partial record rather
                // than implying the whole desktop was seen.
                SCDisplay *display = content.displays.firstObject;

                SCContentFilter *filter =
                    [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
                SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];

                double w = (double)display.width;
                double h = (double)display.height;
                double longest = w > h ? w : h;
                double scale = (maxEdge > 0 && longest > (double)maxEdge)
                    ? (double)maxEdge / longest : 1.0;
                config.width = (size_t)(w * scale) > 0 ? (size_t)(w * scale) : 1;
                config.height = (size_t)(h * scale) > 0 ? (size_t)(h * scale) : 1;
                // The pointer is part of what the screen looked like, and is
                // not sensitive on its own.
                config.showsCursor = YES;

                [SCScreenshotManager captureImageWithFilter:filter
                                             configuration:config
                                         completionHandler:^(CGImageRef image, NSError *err) {
                    if (err == nil && image != NULL) captured = CGImageRetain(image);
                    dispatch_semaphore_signal(done);
                }];

                [filter release];
                [config release];
            }];

        // Bounded wait: a wedged window server must not hang the agent, which
        // is also serving activity sampling and the extension's port.
        if (dispatch_semaphore_wait(done,
                dispatch_time(DISPATCH_TIME_NOW, 5LL * NSEC_PER_SEC)) != 0) {
            return 0;
        }
        if (captured == NULL) return 0;

        int ok = bestq_encode_jpeg(captured, quality, out);
        out->width = (int)CGImageGetWidth(captured);
        out->height = (int)CGImageGetHeight(captured);
        CGImageRelease(captured);
        return ok;
    }

    // Below macOS 14 there is no SCScreenshotManager, and the CoreGraphics
    // calls that would have served are gone from the SDK. Reported as
    // unavailable rather than approximated.
    return 0;
}
*/
import "C"

import (
	"errors"
	"sync"
	"unsafe"
)

func screenCaptureAllowed() bool {
	return C.bestq_screen_capture_allowed() == 1
}

// requestScreenCapture guards the prompt so it appears once per agent process.
//
// Repeating it every capture interval would put a system dialog on screen every
// thirty seconds, which is not a machine anybody can use.
var requestScreenCapture sync.Once

func requestScreenCaptureAccess() {
	requestScreenCapture.Do(func() {
		C.bestq_screen_capture_request()
	})
}

func displayCount() int {
	return int(C.bestq_display_count())
}

// captureScreenJPEG grabs the whole main display once, at the given quality.
func captureScreenJPEG(maxEdge int, quality float64) ([]byte, int, int, error) {
	var frame C.BQFrame
	result := C.bestq_capture_screen(C.int(maxEdge), C.double(quality), &frame)
	if frame.data != nil {
		defer C.free(unsafe.Pointer(frame.data))
	}
	switch {
	case result == -1:
		// Registers the executable with TCC so it appears in System Settings
		// and the user has a row to switch on. Without this the agent is
		// invisible there and the permission can never be granted at all.
		requestScreenCaptureAccess()
		return nil, 0, 0, ErrScreenPermission
	case result != 1 || frame.data == nil || frame.len <= 0:
		return nil, 0, 0, errors.New("the display could not be read")
	}
	return C.GoBytes(unsafe.Pointer(frame.data), frame.len), int(frame.width), int(frame.height), nil
}
