package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// MaxMessageBytes is Chrome's own ceiling for a native message. A larger one is
// dropped by the browser, so it is refused here rather than written and lost.
const MaxMessageBytes = 1024 * 1024

// ErrClosed is returned when the peer closed the port. Chrome closing stdin is
// the normal shutdown path for a native host, not a failure.
var ErrClosed = errors.New("native messaging port closed")

// Reader decodes Chrome's framing: a little-endian uint32 length followed by
// that many bytes of UTF-8 JSON.
type Reader struct {
	r io.Reader
}

func NewReader(r io.Reader) *Reader { return &Reader{r: r} }

// Read returns the next raw message body.
//
// A length beyond MaxMessageBytes is fatal rather than skippable: the frame
// boundaries after a bad length are all wrong, so the stream cannot be
// resynchronised and continuing would interpret arbitrary bytes as messages.
func (r *Reader) Read() ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r.r, header[:]); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, ErrClosed
		}
		return nil, err
	}
	length := binary.LittleEndian.Uint32(header[:])
	if length == 0 {
		return []byte{}, nil
	}
	if length > MaxMessageBytes {
		return nil, fmt.Errorf("frame length %d exceeds maximum %d", length, MaxMessageBytes)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r.r, body); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, ErrClosed
		}
		return nil, err
	}
	return body, nil
}

// Writer encodes framed messages.
//
// Serialised with a mutex because activity, idle and heartbeat are produced by
// separate goroutines: two interleaved writes would corrupt the length prefix
// and Chrome would close the port.
type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

// Write frames and sends one message.
func (w *Writer) Write(msg Outbound) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", msg.Type, err)
	}
	if len(body) > MaxMessageBytes {
		return fmt.Errorf("message %s is %d bytes, over the %d limit", msg.Type, len(body), MaxMessageBytes)
	}

	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(body)))

	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.w.Write(header[:]); err != nil {
		return err
	}
	if _, err := w.w.Write(body); err != nil {
		return err
	}
	return nil
}

// Decode parses and validates an inbound message.
//
// Validation is deliberately strict and happens before any handler runs:
// a native host is a process the browser launches, and treating whatever
// arrives on stdin as trustworthy is how a message-handling bug becomes a
// security problem.
func Decode(body []byte) (Inbound, error) {
	if len(body) == 0 {
		return Inbound{}, errors.New("empty message")
	}
	if len(body) > MaxMessageBytes {
		return Inbound{}, fmt.Errorf("message of %d bytes is over the limit", len(body))
	}

	var envelope Envelope
	if err := json.Unmarshal(body, &envelope); err != nil {
		return Inbound{}, fmt.Errorf("malformed JSON: %w", err)
	}
	if envelope.ProtocolVersion != Version {
		return Inbound{}, fmt.Errorf("unsupported protocol version %d (this agent speaks %d)",
			envelope.ProtocolVersion, Version)
	}
	if !knownInboundType(envelope.Type) {
		return Inbound{}, fmt.Errorf("unknown message type %q", envelope.Type)
	}

	var msg Inbound
	if err := json.Unmarshal(body, &msg); err != nil {
		return Inbound{}, fmt.Errorf("malformed body for %s: %w", envelope.Type, err)
	}

	// Session-scoped messages must name a session, and a session id must look
	// like one — it is echoed back on every activity record, so an unbounded
	// string here would end up in stored data.
	switch msg.Type {
	case TypeStartMonitoring, TypeStopMonitoring:
		if err := validateSessionID(msg.SessionID); err != nil {
			return Inbound{}, err
		}
	}
	if msg.IdleThresholdSeconds != 0 && (msg.IdleThresholdSeconds < 30 || msg.IdleThresholdSeconds > 3600) {
		return Inbound{}, fmt.Errorf("idleThresholdSeconds %d is outside 30..3600", msg.IdleThresholdSeconds)
	}

	return msg, nil
}

func knownInboundType(t string) bool {
	switch t {
	case TypeHello, TypeStartMonitoring, TypeStopMonitoring,
		TypePause, TypeResume, TypeFlush, TypeGetStatus:
		return true
	}
	return false
}

// validateSessionID accepts the shapes the backend actually issues (UUIDs and
// the extension's own generated ids) and nothing else.
func validateSessionID(id string) error {
	if id == "" {
		return errors.New("sessionId is required")
	}
	if len(id) > 64 {
		return errors.New("sessionId is too long")
	}
	for _, r := range id {
		isAllowed := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_'
		if !isAllowed {
			return errors.New("sessionId contains unexpected characters")
		}
	}
	return nil
}
