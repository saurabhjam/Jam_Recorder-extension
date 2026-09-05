package core

import "testing"

func TestIdentifiesBrowsersByNameAndBundle(t *testing.T) {
	cases := []struct{ name, id, want string }{
		{"Google Chrome", "com.google.Chrome", "Google Chrome"},
		{"", "com.brave.Browser", "Brave Browser"},
		{"chrome.exe", "", "Google Chrome"},
		{"Visual Studio Code", "com.microsoft.VSCode", ""},
	}
	for _, c := range cases {
		got, ok := IdentifyBrowser(c.name, c.id)
		if c.want == "" {
			if ok {
				t.Errorf("%q/%q must not be a browser, got %q", c.name, c.id, got)
			}
			continue
		}
		if !ok || got != c.want {
			t.Errorf("%q/%q → %q (ok=%v), want %q", c.name, c.id, got, ok, c.want)
		}
	}
}

func TestParsesRealChromeTitleWithEnDashProfile(t *testing.T) {
	// Captured from a live machine. Chrome uses an EN-DASH before the profile
	// name and the profile can contain parentheses — a hyphen-only pattern
	// silently fails to split this.
	title := "Meet – BestQ Daily Meet - Google Chrome – Saurabh (best-quality.in)"
	info := ParseBrowserTitle(title)
	if info.Profile != "Saurabh (best-quality.in)" {
		t.Errorf("profile: %q", info.Profile)
	}
	if info.BrowserName != "Google Chrome" {
		t.Errorf("browser: %q", info.BrowserName)
	}
	if contains(info.PageTitle, "Google Chrome") {
		t.Errorf("page title must not include the browser suffix: %q", info.PageTitle)
	}
}

func TestDefaultProfileTitleHasNoProfileName(t *testing.T) {
	info := ParseBrowserTitle("Board - Jira - Google Chrome")
	if info.Profile != "" {
		t.Errorf("a sole/default profile appends nothing, got %q", info.Profile)
	}
	if info.PageTitle != "Board - Jira" {
		t.Errorf("page title: %q", info.PageTitle)
	}
}

func TestUnrecognisedShapeClaimsNoProfile(t *testing.T) {
	// A PWA or app-mode window. Keeping the raw title as a page title is
	// defensible; inventing a profile from it is not.
	info := ParseBrowserTitle("some app-mode window")
	if info.Profile != "" {
		t.Errorf("must claim no profile, got %q", info.Profile)
	}
	if info.PageTitle != "some app-mode window" {
		t.Errorf("page title: %q", info.PageTitle)
	}
}
