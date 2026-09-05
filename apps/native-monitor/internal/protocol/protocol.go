// Package protocol defines the versioned message contract between the BestQ
// Chrome extension and this agent, plus the Chrome Native Messaging framing.
//
// Every message carries protocolVersion. A version the other side does not
// understand is rejected rather than best-effort parsed: an agent that silently
// half-understands a newer extension would report partial activity, and partial
// activity in somebody's work record is worse than an explicit refusal the UI
// can surface as "Update Required".
package protocol

// Version is the wire contract this build speaks. Bump only for a breaking
// change; additive optional fields do not need it.
const Version = 1

// Message types. Extension → agent.
const (
	TypeHello           = "HELLO"
	TypeStartMonitoring = "START_MONITORING"
	TypeStopMonitoring  = "STOP_MONITORING"
	TypePause           = "PAUSE_MONITORING"
	TypeResume          = "RESUME_MONITORING"
	TypeFlush           = "FLUSH"
	TypeGetStatus       = "GET_STATUS"
)

// Message types. Agent → extension.
const (
	TypeReady           = "READY"
	TypeStarted         = "STARTED"
	TypeStopped         = "STOPPED"
	TypePaused          = "PAUSED"
	TypeResumed         = "RESUMED"
	TypeFlushed         = "FLUSHED"
	TypeActivityChanged = "ACTIVITY_CHANGED"
	TypeIdleChanged     = "IDLE_CHANGED"
	TypeHeartbeat       = "HEARTBEAT"
	TypeStatus          = "STATUS"
	TypeError           = "ERROR"
)

// Error codes. Stable strings the extension branches on, so the UI can offer
// the right recovery rather than printing a sentence at the user.
const (
	ErrPermissionRequired  = "PERMISSION_REQUIRED"
	ErrUnsupportedPlatform = "UNSUPPORTED_PLATFORM"
	ErrProtocolMismatch    = "PROTOCOL_VERSION_MISMATCH"
	ErrInvalidMessage      = "INVALID_MESSAGE"
	ErrNoSession           = "NO_ACTIVE_SESSION"
	ErrInternal            = "INTERNAL"
)

// Envelope is the common head of every message. Parsed first so a message can
// be routed and version-checked before its body is trusted.
type Envelope struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Type            string `json:"type"`
}

// Inbound is any message the extension can send. Fields are a union across
// types; each handler validates the ones it needs.
type Inbound struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Type            string `json:"type"`
	SessionID       string `json:"sessionId,omitempty"`
	ProjectID       string `json:"projectId,omitempty"`
	// IdleThresholdSeconds lets the extension keep the agent aligned with the
	// backend's configured threshold instead of both hardcoding 300.
	IdleThresholdSeconds int `json:"idleThresholdSeconds,omitempty"`
}

// Capabilities states what this machine can actually report.
//
// Every field is answered from a real runtime probe, never from a compile-time
// assumption about the OS: macOS reports windowTitle=false until Accessibility
// is granted, and Wayland reports foregroundApplication=false rather than
// pretending X11 tooling works there.
type Capabilities struct {
	ForegroundApplication bool `json:"foregroundApplication"`
	WindowTitle           bool `json:"windowTitle"`
	ProcessIdentifier     bool `json:"processIdentifier"`
	BrowserProfile        bool `json:"browserProfile"`
	// ExactBrowserURL is false on every platform. A window title is not a URL,
	// and deriving one would be fabrication — see the README's security model.
	ExactBrowserURL bool `json:"exactBrowserUrl"`
	IdleDetection   bool `json:"idleDetection"`
}

// Permissions is the OS-level grants the agent needs, as observed now.
type Permissions struct {
	// Accessibility is macOS only; nil elsewhere so the extension can tell
	// "not required here" from "required and missing".
	Accessibility *bool `json:"accessibility,omitempty"`
	// X11Tools reports whether the Linux helper binaries are present.
	X11Tools *bool `json:"x11Tools,omitempty"`
}

// Activity is one closed interval of an application being frontmost.
//
// Deliberately separate optional fields for BrowserName, BrowserProfile,
// WindowTitle and PageURL. PageURL is always empty from this agent: it can see
// a window title, not a URL, and for another Chrome profile there is genuinely
// no way to know it. Collapsing them into one "page" field would invite exactly
// the fabrication that must not happen.
type Activity struct {
	ApplicationName string `json:"applicationName"`
	// ApplicationID is a bundle id on macOS, an executable name on Windows and
	// Linux — stable enough to group by, and never a file path.
	ApplicationID string `json:"applicationId,omitempty"`
	ProcessID     int    `json:"processId,omitempty"`
	WindowTitle   string `json:"windowTitle,omitempty"`
	BrowserName   string `json:"browserName,omitempty"`
	BrowserProfile string `json:"browserProfile,omitempty"`
	PageURL       string `json:"pageUrl,omitempty"`
	StartedAt     string `json:"startedAt"`
	EndedAt       string `json:"endedAt,omitempty"`
	DurationSecs  int    `json:"durationSeconds,omitempty"`
	// TitleSuppressed marks an application whose titles are dropped wholesale
	// (password managers), so the extension can say why rather than showing a
	// blank the user reads as a bug.
	TitleSuppressed bool `json:"titleSuppressed,omitempty"`
	// ClientActivityID is the idempotency key the backend dedupes on, minted
	// here so a resend after a reconnect cannot create a second row.
	ClientActivityID string `json:"clientActivityId"`
	SessionID        string `json:"sessionId,omitempty"`
}

// Outbound is any message the agent sends.
type Outbound struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Type            string `json:"type"`

	AgentVersion string `json:"agentVersion,omitempty"`
	Platform     string `json:"platform,omitempty"`
	Architecture string `json:"architecture,omitempty"`

	Capabilities *Capabilities `json:"capabilities,omitempty"`
	Permissions  *Permissions  `json:"permissions,omitempty"`

	Activity *Activity `json:"activity,omitempty"`

	// Idle transitions. StartedAt is when input actually stopped, which is
	// earlier than when the threshold was reached — see core/idle.go.
	Idle          *bool  `json:"idle,omitempty"`
	IdleStartedAt string `json:"idleStartedAt,omitempty"`
	IdleEndedAt   string `json:"idleEndedAt,omitempty"`
	IdleSeconds   int    `json:"idleSeconds,omitempty"`

	State     string `json:"state,omitempty"`
	SessionID string `json:"sessionId,omitempty"`

	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// NewOutbound stamps the version so no send site can forget it.
func NewOutbound(kind string) Outbound {
	return Outbound{ProtocolVersion: Version, Type: kind}
}

// Errorf builds an ERROR message.
func Errorf(code, message string) Outbound {
	out := NewOutbound(TypeError)
	out.Code = code
	out.Message = message
	return out
}
