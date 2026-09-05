package core

import (
	"regexp"
	"strings"
)

// Reading browser window titles.
//
// ── The multi-profile problem ───────────────────────────────────────────────
// The extension is installed in ONE Chrome profile. `chrome.tabs.query()` in
// that profile cannot see tabs belonging to any other profile — Chrome isolates
// them and no extension API crosses that boundary. So when the user works in
// Profile B, the extension knows a browser is frontmost but genuinely does not
// know which page.
//
// This file extracts only what a window title can actually support: that the
// front application is a browser, its page title, and — where Chrome appends it
// — which profile's window it is. It deliberately does NOT derive a URL. A page
// identity attributed to the wrong profile would be a false statement about
// somebody's day, and the full-screen screenshot already provides the visual
// record.

var browserApps = map[string]string{
	"google chrome":        "Google Chrome",
	"google chrome canary": "Google Chrome",
	"google chrome beta":   "Google Chrome",
	"chromium":             "Chromium",
	"chrome":               "Google Chrome",
	"chrome.exe":           "Google Chrome",
	"brave browser":        "Brave Browser",
	"brave-browser":        "Brave Browser",
	"brave":                "Brave Browser",
	"brave.exe":            "Brave Browser",
	"microsoft edge":       "Microsoft Edge",
	"msedge":               "Microsoft Edge",
	"msedge.exe":           "Microsoft Edge",
	"opera":                "Opera",
	"vivaldi":              "Vivaldi",
	"arc":                  "Arc",
	"mozilla firefox":      "Mozilla Firefox",
	"firefox":              "Mozilla Firefox",
	"firefox.exe":          "Mozilla Firefox",
}

// Chrome window titles end with the browser name, optionally followed by the
// profile name for non-default profiles. Both hyphen and en-dash are accepted:
// Chrome uses an en-dash before the profile on macOS, which a hyphen-only
// pattern silently fails to split — a real title observed in testing was
// "… - Google Chrome – Saurabh (best-quality.in)".
var titleSuffix = regexp.MustCompile(
	`\s[-–—]\s(Google Chrome|Chromium|Brave|Brave Browser|Microsoft Edge|Opera|Vivaldi|Arc|Mozilla Firefox)(?:\s[-–—]\s(.+))?$`,
)

// BrowserInfo is what a browser window title yields.
type BrowserInfo struct {
	// BrowserName is the canonical product name.
	BrowserName string
	// PageTitle is the document title, or empty when the shape was not
	// recognised. Empty means unknown, never "no page".
	PageTitle string
	// Profile is the Chrome profile name, present only when Chrome appended it
	// — which it does for every profile except a sole/default one.
	Profile string
}

// IdentifyBrowser reports whether an application is a browser we can reason
// about, and canonicalises its name.
func IdentifyBrowser(applicationName, applicationID string) (string, bool) {
	for _, candidate := range []string{applicationName, applicationID} {
		key := strings.ToLower(strings.TrimSpace(candidate))
		if key == "" {
			continue
		}
		if name, ok := browserApps[key]; ok {
			return name, true
		}
	}
	// Bundle ids: com.google.Chrome, com.brave.Browser, company.thebrowser.Browser.
	bundle := strings.ToLower(applicationID)
	switch {
	case strings.Contains(bundle, "com.google.chrome"):
		return "Google Chrome", true
	case strings.Contains(bundle, "com.brave.browser"):
		return "Brave Browser", true
	case strings.Contains(bundle, "com.microsoft.edgemac"):
		return "Microsoft Edge", true
	case strings.Contains(bundle, "org.chromium.chromium"):
		return "Chromium", true
	case strings.Contains(bundle, "org.mozilla.firefox"):
		return "Mozilla Firefox", true
	}
	return "", false
}

// ParseBrowserTitle splits a browser window title into its page and profile
// parts.
//
// A title that does not match the expected shape (a localised Chrome, an
// app-mode window, a PWA) yields the raw title as the page title and no
// profile. Returning the raw title as a *page title* is defensible — it is what
// the window is displaying — whereas guessing a profile from it would not be.
func ParseBrowserTitle(windowTitle string) BrowserInfo {
	title := strings.TrimSpace(windowTitle)
	if title == "" {
		return BrowserInfo{}
	}

	match := titleSuffix.FindStringSubmatchIndex(title)
	if match == nil {
		return BrowserInfo{PageTitle: title}
	}

	groups := titleSuffix.FindStringSubmatch(title)
	info := BrowserInfo{
		PageTitle: strings.TrimSpace(title[:match[0]]),
	}
	if len(groups) > 1 {
		if canonical, ok := browserApps[strings.ToLower(groups[1])]; ok {
			info.BrowserName = canonical
		} else {
			info.BrowserName = groups[1]
		}
	}
	if len(groups) > 2 && groups[2] != "" {
		info.Profile = strings.TrimSpace(groups[2])
	}
	return info
}
