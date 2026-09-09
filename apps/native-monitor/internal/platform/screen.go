package platform

import "errors"

// ErrScreenPermission means the OS grant for whole-screen capture is missing.
//
// Distinct from a failure, because the remedy is different and the extension
// says so: a permission is something the user can grant, whereas a failure is
// something they can only report.
var ErrScreenPermission = errors.New("screen recording permission is required")

// ErrScreenUnsupported means this platform cannot capture the whole screen.
//
// Reported rather than approximated. Monitoring that silently fell back to a
// browser tab would produce a report that looks complete and is not.
var ErrScreenUnsupported = errors.New("whole-screen capture is unavailable on this platform")

// Frame is one encoded capture of the entire physical screen.
type Frame struct {
	MimeType string
	Data     []byte
	Width    int
	Height   int
	// DisplayCount is how many screens the machine has. A single-display
	// capture on a three-display machine is a partial record, and the report
	// should be able to say so rather than imply it saw everything.
	DisplayCount int
}

// Quality bounds and pass count for the byte-budget search.
//
// The floor is 0.45, not 0.30. Below roughly 0.4 a JPEG of a screenshot puts
// visible ringing around every text stroke, and a screenshot nobody can read is
// not a record of anything. With the larger byte budget the floor is rarely
// reached at all. Four passes narrow the range to a few percent, which
// is finer than the size difference it produces — and each pass re-encodes, so
// this is the CPU budget too.
const (
	screenMinQuality = 0.45
	screenMaxQuality = 0.85
	screenPasses     = 4
)

// screenScaleSteps are tried in order when quality alone cannot meet the
// budget. An ordinary desktop stops at the first.
//
// The last step is deliberately aggressive. A dense screen — a full IDE, a
// dashboard — does not reach a 30 KB budget at 1280px at any quality the floor
// allows, and the budget was an explicit requirement. 0.5 costs legibility of
// small text on such screens, which is the honest price of the number: the
// alternative is silently exceeding it. Only screens that fit nothing larger
// ever get here, because the steps are tried biggest-first.
var screenScaleSteps = []float64{1, 0.8, 0.64, 0.5}

// encodeOnce captures and encodes a single frame at one quality setting.
type encodeOnce func(maxEdge int, quality float64) (data []byte, width, height int, err error)

// captureWithinBudget finds the best-looking frame that fits targetBytes.
//
// Quality first, resolution only if quality was not enough: on a dense screen
// no quality setting reaches the budget at full size, and fewer pixels is then
// the only remaining lever. Pushing quality below the floor instead would turn
// text to mush at any size, and a screenshot nobody can read is not a record.
//
// When nothing fits, the smallest frame produced is returned rather than an
// error. An oversized screenshot is worth far more than a missing one.
func captureWithinBudget(capture encodeOnce, maxEdge, targetBytes int) (*Frame, error) {
	if targetBytes <= 0 {
		return nil, errors.New("targetBytes must be positive")
	}

	var smallest *Frame

	record := func(data []byte, width, height int) *Frame {
		frame := &Frame{MimeType: "image/jpeg", Data: data, Width: width, Height: height}
		if smallest == nil || len(frame.Data) < len(smallest.Data) {
			smallest = frame
		}
		return frame
	}

	for _, step := range screenScaleSteps {
		edge := int(float64(maxEdge) * step)
		if edge < 1 {
			edge = 1
		}

		// The floor is probed FIRST, to answer "can this size fit at all".
		//
		// Bisecting alone does not answer it: the search converges *towards*
		// the floor without ever evaluating it, so a frame that fits only at
		// the floor was reported as unfittable and the image was needlessly
		// shrunk. One probe also makes the hopeless case cheap — a dense
		// screen moves to fewer pixels after a single encode instead of four.
		data, width, height, err := capture(edge, screenMinQuality)
		if err != nil {
			// A permission or platform failure will not improve at another
			// quality or size, so it ends the whole attempt rather than
			// burning a dozen encodes discovering that.
			return nil, err
		}
		floor := record(data, width, height)
		if len(floor.Data) > targetBytes {
			continue // no quality fits at this size
		}

		// The floor fits, so the best-looking frame that fits is somewhere
		// above it. Bisect upward, keeping the largest that still fits.
		fitting := floor
		low, high := screenMinQuality, screenMaxQuality
		for pass := 0; pass < screenPasses; pass++ {
			quality := (low + high) / 2
			data, width, height, err := capture(edge, quality)
			if err != nil {
				return nil, err
			}
			candidate := record(data, width, height)
			if len(candidate.Data) <= targetBytes {
				if len(candidate.Data) > len(fitting.Data) {
					fitting = candidate
				}
				low = quality
			} else {
				high = quality
			}
		}
		return fitting, nil
	}

	if smallest != nil {
		return smallest, nil
	}
	return nil, errors.New("no frame could be encoded")
}
