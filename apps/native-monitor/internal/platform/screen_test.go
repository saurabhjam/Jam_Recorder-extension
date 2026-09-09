package platform

import (
	"errors"
	"testing"
)

// A synthetic encoder: size falls with quality and with the edge, which is the
// only property the budget search relies on. Real pixels cannot be produced in
// a test, and the failure modes here are in the search, not in the encoder.
func fakeEncoder(bytesAtFullQuality int) (encodeOnce, *int) {
	calls := 0
	return func(edge int, quality float64) ([]byte, int, int, error) {
		calls++
		area := float64(edge) / 1600.0
		size := int(float64(bytesAtFullQuality) * quality * area * area)
		if size < 1 {
			size = 1
		}
		return make([]byte, size), edge, edge, nil
	}, &calls
}

func TestQualityAloneMeetsTheBudget(t *testing.T) {
	encode, calls := fakeEncoder(200 * 1024)
	frame, err := captureWithinBudget(encode, 1600, 120*1024)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(frame.Data) > 120*1024 {
		t.Errorf("frame is over budget: %d bytes", len(frame.Data))
	}
	if frame.Width != 1600 {
		t.Errorf("should not have downscaled, got width %d", frame.Width)
	}
	if *calls > screenPasses+1 {
		t.Errorf("an ordinary screen must not pay for extra scale steps, got %d encodes", *calls)
	}
}

func TestDenseScreenFallsBackToFewerPixels(t *testing.T) {
	// 600 KB at full quality: no quality setting reaches the budget at full
	// so the search has to drop resolution. Without that step the frame would
	// come back over budget on every busy screen.
	encode, _ := fakeEncoder(600 * 1024)
	frame, err := captureWithinBudget(encode, 1600, 120*1024)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(frame.Data) > 120*1024 {
		t.Errorf("frame is over budget: %d bytes", len(frame.Data))
	}
	if frame.Width >= 1600 {
		t.Errorf("expected a downscale, still %dpx wide", frame.Width)
	}
}

func TestAnUnfittableScreenStillYieldsAFrame(t *testing.T) {
	// Nothing fits at any quality or size. A slightly oversized screenshot is
	// worth far more than a missing one.
	encode := encodeOnce(func(edge int, quality float64) ([]byte, int, int, error) {
		return make([]byte, 5*1024*1024), edge, edge, nil
	})
	frame, err := captureWithinBudget(encode, 1600, 120*1024)
	if err != nil {
		t.Fatalf("expected a frame, got error: %v", err)
	}
	if frame == nil || len(frame.Data) == 0 {
		t.Fatal("no frame returned")
	}
}

func TestPermissionErrorsStopImmediately(t *testing.T) {
	// A permission failure will not improve at a lower quality, so it must
	// abort rather than burn twelve encodes discovering that.
	calls := 0
	encode := encodeOnce(func(edge int, quality float64) ([]byte, int, int, error) {
		calls++
		return nil, 0, 0, ErrScreenPermission
	})
	_, err := captureWithinBudget(encode, 1600, 120*1024)
	if !errors.Is(err, ErrScreenPermission) {
		t.Fatalf("expected the permission error to surface, got %v", err)
	}
	if calls != 1 {
		t.Errorf("expected one attempt, made %d", calls)
	}
}

func TestABadBudgetIsRejected(t *testing.T) {
	encode, _ := fakeEncoder(50 * 1024)
	if _, err := captureWithinBudget(encode, 1600, 0); err == nil {
		t.Error("a zero budget must be rejected rather than looping")
	}
}
