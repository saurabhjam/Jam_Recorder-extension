# BestQ native monitoring agent.
#
# CGO_ENABLED=0 for Windows and Linux: both platform implementations use only
# syscall/subprocess, so a release for them cross-compiles from any host.
# macOS needs cgo (NSWorkspace and the Accessibility API are Objective-C), so a
# darwin build must run on a Mac.

VERSION ?= 1.0.0
LDFLAGS := -s -w -X main.Version=$(VERSION)
GO      ?= go
BUILD   := build

.PHONY: all test vet clean build-darwin build-windows build-linux package-macos package-linux probe

all: test build-windows build-linux build-darwin

test: vet
	$(GO) test ./...
	node test/e2e-protocol.mjs $(BUILD)/bestq-monitoring-agent

vet:
	$(GO) vet ./...

# Local development binary for the host platform.
$(BUILD)/bestq-monitoring-agent:
	@mkdir -p $(BUILD)
	$(GO) build -ldflags "$(LDFLAGS)" -o $@ ./cmd/bestq-monitoring-agent

build-windows:
	@mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
		-o $(BUILD)/bestq-monitoring-agent-windows-amd64.exe ./cmd/bestq-monitoring-agent
	CGO_ENABLED=0 GOOS=windows GOARCH=arm64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
		-o $(BUILD)/bestq-monitoring-agent-windows-arm64.exe ./cmd/bestq-monitoring-agent

build-linux:
	@mkdir -p $(BUILD)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
		-o $(BUILD)/bestq-monitoring-agent-linux-amd64 ./cmd/bestq-monitoring-agent
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
		-o $(BUILD)/bestq-monitoring-agent-linux-arm64 ./cmd/bestq-monitoring-agent

# Universal binary so one .pkg serves Apple Silicon and Intel.
build-darwin:
	@mkdir -p $(BUILD)
	CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
		-o $(BUILD)/.agent-darwin-arm64 ./cmd/bestq-monitoring-agent
	CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 $(GO) build -trimpath -ldflags "$(LDFLAGS)" \
		-o $(BUILD)/.agent-darwin-amd64 ./cmd/bestq-monitoring-agent
	lipo -create -output $(BUILD)/bestq-monitoring-agent-darwin-universal \
		$(BUILD)/.agent-darwin-arm64 $(BUILD)/.agent-darwin-amd64
	@rm -f $(BUILD)/.agent-darwin-arm64 $(BUILD)/.agent-darwin-amd64
	@lipo -info $(BUILD)/bestq-monitoring-agent-darwin-universal

package-macos: build-darwin
	BESTQ_AGENT_VERSION=$(VERSION) ./installer/macos/build-pkg.sh

package-linux: build-linux
	BESTQ_AGENT_VERSION=$(VERSION) ./installer/linux/build-deb.sh amd64
	BESTQ_AGENT_VERSION=$(VERSION) ./installer/linux/build-deb.sh arm64

# The Windows installer needs Inno Setup, which only runs on Windows.
# See installer/windows/BestQMonitoringAgent.iss and the README.
package-windows:
	@echo "Run on Windows with Inno Setup 6:"
	@echo "  iscc /DAgentVersion=$(VERSION) installer\\windows\\BestQMonitoringAgent.iss"

probe: $(BUILD)/bestq-monitoring-agent
	$(BUILD)/bestq-monitoring-agent --probe

clean:
	rm -rf $(BUILD)
