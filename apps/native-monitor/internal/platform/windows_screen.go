//go:build windows

package platform

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"syscall"
	"unsafe"
)

// Whole-screen capture on Windows, via GDI.
//
// No permission is required and no prompt appears: the virtual screen is
// readable by any process in the interactive session. That is the whole reason
// capture moved out of the browser — Chrome's picker offered Tab and Window
// beside Entire Screen, and no browser API can remove those choices.
//
// There is deliberately no window or region variant here.
//
// syscall rather than cgo, matching the rest of the Windows implementation, so
// releases keep cross-compiling from CI without a C toolchain.

// GDI and the metrics calls, declared here so the capture surface stays beside
// the code that uses it rather than swelling the foreground-detection file.
var (
	gdi32 = syscall.NewLazyDLL("gdi32.dll")

	// user32 is already declared in windows.go — same package, so it is reused.
	procGetDC               = user32.NewProc("GetDC")
	procReleaseDC           = user32.NewProc("ReleaseDC")
	procGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	procEnumDisplayMonitors = user32.NewProc("EnumDisplayMonitors")

	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procBitBlt             = gdi32.NewProc("BitBlt")
)

func getSystemMetrics(index int) int {
	value, _, _ := procGetSystemMetrics.Call(uintptr(index))
	return int(int32(value))
}

// displayCountWindows counts attached monitors, for the partial-record note.
func displayCountWindows() int {
	count := 0
	callback := syscall.NewCallback(func(_, _, _, _ uintptr) uintptr {
		count++
		return 1 // keep enumerating
	})
	procEnumDisplayMonitors.Call(0, 0, callback, 0)
	if count == 0 {
		return 1
	}
	return count
}

const (
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79

	srcCopy     = 0x00CC0020
	captureBlt  = 0x40000000
	biRGB       = 0
	dibRGBColors = 0
)

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

type bitmapInfo struct {
	Header bitmapInfoHeader
	Colors [3]uint32
}

// captureVirtualScreen reads every display as one image, then scales it.
//
// The virtual screen, not the primary display: a person with two monitors is
// working on both, and capturing only one would be a partial record that looks
// complete.
func captureVirtualScreen(maxEdge int) (*image.RGBA, int, error) {
	left := getSystemMetrics(smXVirtualScreen)
	top := getSystemMetrics(smYVirtualScreen)
	width := getSystemMetrics(smCXVirtualScreen)
	height := getSystemMetrics(smCYVirtualScreen)
	if width <= 0 || height <= 0 {
		return nil, 0, errors.New("the virtual screen has no size")
	}

	screenDC, _, _ := procGetDC.Call(0)
	if screenDC == 0 {
		return nil, 0, errors.New("could not open the screen device context")
	}
	defer procReleaseDC.Call(0, screenDC)

	memDC, _, _ := procCreateCompatibleDC.Call(screenDC)
	if memDC == 0 {
		return nil, 0, errors.New("could not create a memory device context")
	}
	defer procDeleteDC.Call(memDC)

	info := bitmapInfo{Header: bitmapInfoHeader{
		Size:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:       int32(width),
		// Negative height requests a top-down bitmap, so rows arrive in the
		// order image.RGBA expects instead of bottom-up.
		Height:      int32(-height),
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
	}}

	var bits unsafe.Pointer
	bitmap, _, _ := procCreateDIBSection.Call(memDC, uintptr(unsafe.Pointer(&info)),
		dibRGBColors, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bitmap == 0 || bits == nil {
		return nil, 0, errors.New("could not allocate a bitmap for the screen")
	}
	defer procDeleteObject.Call(bitmap)

	previous, _, _ := procSelectObject.Call(memDC, bitmap)
	defer procSelectObject.Call(memDC, previous)

	// CAPTUREBLT includes layered windows, which is what makes overlays and
	// some hardware-accelerated surfaces appear rather than as black holes.
	ok, _, _ := procBitBlt.Call(memDC, 0, 0, uintptr(width), uintptr(height),
		screenDC, uintptr(left), uintptr(top), srcCopy|captureBlt)
	if ok == 0 {
		return nil, 0, errors.New("the screen could not be copied")
	}

	// GDI gives BGRA; image.RGBA wants RGBA, so the channels are swapped as
	// the rows are copied.
	pixels := unsafe.Slice((*byte)(bits), width*height*4)
	full := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < width*height; i++ {
		full.Pix[i*4+0] = pixels[i*4+2]
		full.Pix[i*4+1] = pixels[i*4+1]
		full.Pix[i*4+2] = pixels[i*4+0]
		full.Pix[i*4+3] = 0xFF
	}

	return scaleRGBA(full, maxEdge), displayCountWindows(), nil
}

// scaleRGBA does a nearest-neighbour reduction.
//
// Nearest-neighbour rather than a filtered resample: it is a few lines instead
// of a dependency, and for a screenshot being shrunk to fit a byte budget the
// difference is not what limits legibility — the JPEG quality is.
func scaleRGBA(src *image.RGBA, maxEdge int) *image.RGBA {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	longest := w
	if h > longest {
		longest = h
	}
	if maxEdge <= 0 || longest <= maxEdge {
		return src
	}
	scale := float64(maxEdge) / float64(longest)
	tw, th := int(float64(w)*scale), int(float64(h)*scale)
	if tw < 1 {
		tw = 1
	}
	if th < 1 {
		th = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	for y := 0; y < th; y++ {
		sy := int(float64(y) / scale)
		if sy >= h {
			sy = h - 1
		}
		for x := 0; x < tw; x++ {
			sx := int(float64(x) / scale)
			if sx >= w {
				sx = w - 1
			}
			copy(dst.Pix[(y*tw+x)*4:(y*tw+x)*4+4], src.Pix[(sy*w+sx)*4:(sy*w+sx)*4+4])
		}
	}
	return dst
}

// CaptureScreen grabs the whole virtual screen. See platform.Monitor.
func (w *windowsMonitor) CaptureScreen(maxEdge, targetBytes int) (*Frame, error) {
	// Captured once and re-encoded per quality pass: reading the screen is the
	// expensive half, and the budget search only varies the encoder.
	var cached *image.RGBA
	var displays int

	encode := func(edge int, quality float64) ([]byte, int, int, error) {
		if cached == nil || cached.Rect.Dx() > edge {
			img, count, err := captureVirtualScreen(edge)
			if err != nil {
				return nil, 0, 0, err
			}
			cached, displays = img, count
		}
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, cached, &jpeg.Options{Quality: int(quality * 100)}); err != nil {
			return nil, 0, 0, err
		}
		return buf.Bytes(), cached.Rect.Dx(), cached.Rect.Dy(), nil
	}

	frame, err := captureWithinBudget(encode, maxEdge, targetBytes)
	if err != nil {
		return nil, err
	}
	frame.DisplayCount = displays
	return frame, nil
}
