package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"
)

func frame(t *testing.T, v any) []byte {
	t.Helper()
	body, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 4)
	binary.LittleEndian.PutUint32(head, uint32(len(body)))
	return append(head, body...)
}

func TestRoundTripsAFramedMessage(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	out := NewOutbound(TypeHeartbeat)
	if err := w.Write(out); err != nil {
		t.Fatal(err)
	}
	body, err := NewReader(&buf).Read()
	if err != nil {
		t.Fatal(err)
	}
	var got Outbound
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != TypeHeartbeat || got.ProtocolVersion != Version {
		t.Errorf("round trip lost data: %+v", got)
	}
}

func TestReadReportsClosedPortRatherThanAnError(t *testing.T) {
	_, err := NewReader(bytes.NewReader(nil)).Read()
	if err != ErrClosed {
		t.Errorf("an empty stream is a closed port, got %v", err)
	}
}

func TestRejectsAnOversizedFrame(t *testing.T) {
	// A bad length desynchronises every subsequent boundary, so it must be
	// fatal rather than skipped.
	head := make([]byte, 4)
	binary.LittleEndian.PutUint32(head, MaxMessageBytes+1)
	_, err := NewReader(bytes.NewReader(head)).Read()
	if err == nil || !strings.Contains(err.Error(), "exceeds maximum") {
		t.Errorf("expected an oversize rejection, got %v", err)
	}
}

func TestDecodeRejectsMalformedJSON(t *testing.T) {
	if _, err := Decode([]byte("{not json")); err == nil {
		t.Error("malformed JSON must be rejected")
	}
}

func TestDecodeRejectsAWrongProtocolVersion(t *testing.T) {
	body, _ := json.Marshal(map[string]any{"protocolVersion": 99, "type": TypeHello})
	_, err := Decode(body)
	if err == nil || !strings.Contains(err.Error(), "protocol version") {
		t.Errorf("a version mismatch must be named as such, got %v", err)
	}
}

func TestDecodeRejectsAnUnknownType(t *testing.T) {
	body, _ := json.Marshal(map[string]any{"protocolVersion": Version, "type": "RUN_SHELL"})
	if _, err := Decode(body); err == nil {
		t.Error("an unknown message type must be refused, not ignored")
	}
}

func TestDecodeRequiresAValidSessionIDForSessionMessages(t *testing.T) {
	missing, _ := json.Marshal(map[string]any{"protocolVersion": Version, "type": TypeStartMonitoring})
	if _, err := Decode(missing); err == nil {
		t.Error("START_MONITORING without a session must be refused")
	}

	// A session id is echoed into stored activity, so an unbounded or
	// path-like value must not get through.
	nasty, _ := json.Marshal(map[string]any{
		"protocolVersion": Version, "type": TypeStartMonitoring,
		"sessionId": "../../etc/passwd",
	})
	if _, err := Decode(nasty); err == nil {
		t.Error("a path-shaped session id must be refused")
	}

	long, _ := json.Marshal(map[string]any{
		"protocolVersion": Version, "type": TypeStartMonitoring,
		"sessionId": strings.Repeat("a", 200),
	})
	if _, err := Decode(long); err == nil {
		t.Error("an over-long session id must be refused")
	}
}

func TestDecodeAcceptsARealSessionID(t *testing.T) {
	body, _ := json.Marshal(map[string]any{
		"protocolVersion": Version, "type": TypeStartMonitoring,
		"sessionId": "a1b2c3d4-0000-4000-8000-000000000001",
	})
	msg, err := Decode(body)
	if err != nil {
		t.Fatalf("a UUID session id must be accepted: %v", err)
	}
	if msg.SessionID == "" {
		t.Error("session id was not parsed")
	}
}

func TestDecodeBoundsTheIdleThreshold(t *testing.T) {
	body, _ := json.Marshal(map[string]any{
		"protocolVersion": Version, "type": TypeHello,
		"idleThresholdSeconds": 999999,
	})
	if _, err := Decode(body); err == nil {
		t.Error("an absurd threshold must be refused")
	}
}

func TestDecodeRejectsAnEmptyMessage(t *testing.T) {
	if _, err := Decode(nil); err == nil {
		t.Error("an empty message must be refused")
	}
}

func TestFrameHelperIsUsedByTheReader(t *testing.T) {
	// Guards the test helper itself against drifting from the real framing.
	raw := frame(t, map[string]any{"protocolVersion": Version, "type": TypeHello})
	body, err := NewReader(bytes.NewReader(raw)).Read()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Decode(body); err != nil {
		t.Fatal(err)
	}
}
