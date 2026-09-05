package core

import "testing"

// Redaction is the last line before a window title becomes durable data, so it
// is tested for the things that would actually be damaging to store.

func TestRedactsQueryStringsThatMayCarryTokens(t *testing.T) {
	out := RedactTitle("Login - https://app.example.com/cb?code=abc123def456ghi789")
	if contains(out, "abc123def456ghi789") {
		t.Errorf("token survived redaction: %q", out)
	}
}

func TestRedactsLabelledSecrets(t *testing.T) {
	for _, input := range []string{"password: hunter2", "API_KEY=xyz", "Bearer eyJhbGciOi"} {
		if !contains(RedactTitle(input), "[redacted]") {
			t.Errorf("%q was not redacted: %q", input, RedactTitle(input))
		}
	}
}

func TestRedactsLongOpaqueStringsAndCardNumbers(t *testing.T) {
	if !contains(RedactTitle("note eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh"), "[redacted]") {
		t.Error("a JWT-shaped string should be redacted")
	}
	if !contains(RedactTitle("4111 1111 1111 1111"), "[redacted]") {
		t.Error("a card-shaped digit run should be redacted")
	}
}

func TestLeavesAnOrdinaryTitleIntact(t *testing.T) {
	if got := RedactTitle("Board - Jira"); got != "Board - Jira" {
		t.Errorf("an ordinary title must survive unchanged, got %q", got)
	}
}

func TestTruncatesAnOverLongTitle(t *testing.T) {
	long := ""
	for i := 0; i < 40; i++ {
		long += "meeting notes "
	}
	out := RedactTitle(long + "end")
	if len([]rune(out)) > MaxTitleLength+1 {
		t.Errorf("title not truncated: %d runes", len([]rune(out)))
	}
}

func TestFlagsPasswordManagersForFullSuppression(t *testing.T) {
	if !IsTitleSuppressedApp("1Password 8", "com.1password.1password") {
		t.Error("1Password must be suppressed")
	}
	if !IsTitleSuppressedApp("", "com.bitwarden.desktop") {
		t.Error("bundle-id-only match must work")
	}
	if IsTitleSuppressedApp("Google Chrome", "com.google.Chrome") {
		t.Error("Chrome must not be suppressed")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
