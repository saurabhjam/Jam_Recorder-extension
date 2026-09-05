package core

import (
	"regexp"
	"strings"
)

// Redaction applied to every window title before it leaves this process.
//
// A window title is chosen by the application, not by us, and applications put
// things there with no business in a monitoring record: a password manager
// shows the entry name, a mail client shows the subject of the open message, a
// browser mid-OAuth can show a URL carrying a one-time code.
//
// The product needs to know which application was in use and roughly what was
// being worked on. It does not need the contents. So titles are redacted and
// truncated here, in the agent, before transmission — the unredacted string
// never crosses the Native Messaging port.

// MaxTitleLength bounds what is forwarded. Long titles are almost always a
// document's full text or a URL with a query string; the leading portion is
// what identifies the work.
const MaxTitleLength = 160

// Patterns replaced wholesale.
//
// Deliberately blunt. A false positive costs a slightly less specific title; a
// false negative writes a credential into somebody's permanent activity record.
// The trade is not close.
var redactions = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	// Query strings and fragments — where tokens and one-time codes live.
	{regexp.MustCompile(`[?#][^\s]{8,}`), "[…]"},
	// Anything explicitly labelled as a secret.
	{regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|otp|passcode)\b\s*[:=]?\s*\S*`), "[redacted]"},
	// Bearer/basic credentials, which show up in dev tooling titles.
	{regexp.MustCompile(`(?i)\b(bearer|basic)\s+\S+`), "[redacted]"},
	// Long opaque strings: JWTs, API keys, session ids, hex digests.
	{regexp.MustCompile(`\b[A-Za-z0-9_\-]{24,}\b`), "[redacted]"},
	// Card-like digit runs.
	{regexp.MustCompile(`\b(?:\d[ -]?){13,19}\b`), "[redacted]"},
}

// titleSuppressedApps have their titles dropped entirely rather than redacted.
//
// For a password manager or an authenticator the title *is* the sensitive
// content — there is no useful non-sensitive remainder. The application name
// still goes through, so the time is still attributed; only the title is lost.
var titleSuppressedApps = []string{
	"1password", "bitwarden", "lastpass", "dashlane", "keeper", "enpass",
	"keychain access", "authy", "google authenticator", "gnome-keyring",
	"seahorse", "keepass", "nordpass", "proton pass",
}

// RedactTitle sanitises a window title.
func RedactTitle(title string) string {
	if title == "" {
		return ""
	}
	out := title
	for _, rule := range redactions {
		out = rule.pattern.ReplaceAllString(out, rule.replacement)
	}
	out = strings.TrimSpace(out)
	if len(out) > MaxTitleLength {
		// Trim on a rune boundary so a multi-byte character is not cut in half.
		runes := []rune(out)
		if len(runes) > MaxTitleLength {
			runes = runes[:MaxTitleLength]
		}
		out = string(runes) + "…"
	}
	return out
}

// IsTitleSuppressedApp reports whether this application's titles must be
// dropped rather than redacted.
func IsTitleSuppressedApp(applicationName, applicationID string) bool {
	haystack := strings.ToLower(applicationName + " " + applicationID)
	for _, app := range titleSuppressedApps {
		if strings.Contains(haystack, app) {
			return true
		}
	}
	return false
}
