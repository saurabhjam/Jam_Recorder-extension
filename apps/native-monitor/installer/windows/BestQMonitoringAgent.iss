; Inno Setup script for the BestQ Monitoring Agent.
;
; ── Why a per-user install ──────────────────────────────────────────────────
; PrivilegesRequired=lowest, and the native messaging host is registered under
; HKCU. Two reasons, both load-bearing:
;
;  1. The host manifest Chrome reads is per-user for a per-user Chrome install,
;     which is how Chrome is normally installed on Windows.
;  2. The agent must run in the user's INTERACTIVE desktop session.
;     GetForegroundWindow returns nothing useful from session 0, so a
;     machine-wide Windows service could not do the one job this agent has.
;
; A machine-wide variant would need HKLM registration plus a per-user launcher;
; that is a deployment decision, not a default.
;
; ── Building this ───────────────────────────────────────────────────────────
; Requires Inno Setup 6 on Windows:
;   iscc /DAgentVersion=1.0.0 /DExtensionId=<id> BestQMonitoringAgent.iss
; It cannot be compiled on macOS or Linux — see the README's release section.

#ifndef AgentVersion
  #define AgentVersion "1.0.0"
#endif
#ifndef ExtensionId
  #define ExtensionId "heogonedpcjllemcclnbedlgnnijhloi"
#endif

[Setup]
AppId={{9A1F2C64-4E7B-4C1E-9D3A-BE5TQ0MON01}
AppName=BestQ Monitoring Agent
AppVersion={#AgentVersion}
AppPublisher=BestQ
DefaultDirName={localappdata}\BestQ\MonitoringAgent
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=BestQMonitoringAgentSetup
Compression=lzma2
SolidCompression=yes
; ARM64 machines run the x64 build under emulation, so a single x64 installer
; covers both rather than shipping two the user has to choose between.
ArchitecturesAllowed=x64compatible arm64
ArchitecturesInstallIn64BitMode=x64compatible
; Signing is applied in CI where the certificate lives; an unsigned installer
; triggers SmartScreen and must not be a release artefact.
; SignTool=bestq

[Files]
Source: "..\..\build\bestq-monitoring-agent-windows-amd64.exe"; \
  DestDir: "{app}"; DestName: "bestq-monitoring-agent.exe"; Flags: ignoreversion

[Registry]
; Chrome will only launch a host it has a registry entry for. Writing this is
; the whole reason the user never touches regedit. One key per browser family
; because each reads its own hive path.
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.bestq.monitoring"; \
  ValueType: string; ValueName: ""; ValueData: "{app}\com.bestq.monitoring.json"; \
  Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Chromium\NativeMessagingHosts\com.bestq.monitoring"; \
  ValueType: string; ValueName: ""; ValueData: "{app}\com.bestq.monitoring.json"; \
  Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.bestq.monitoring"; \
  ValueType: string; ValueName: ""; ValueData: "{app}\com.bestq.monitoring.json"; \
  Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.bestq.monitoring"; \
  ValueType: string; ValueName: ""; ValueData: "{app}\com.bestq.monitoring.json"; \
  Flags: uninsdeletekey

[Code]
{ The host manifest is generated at install time so `path` is the real install
  directory. A manifest shipped with a baked-in path breaks the moment the user
  installs anywhere other than the default. }
procedure WriteHostManifest();
var
  Manifest: string;
  EscapedPath: string;
begin
  EscapedPath := ExpandConstant('{app}\bestq-monitoring-agent.exe');
  StringChangeEx(EscapedPath, '\', '\\', True);
  Manifest :=
    '{' + #13#10 +
    '  "name": "com.bestq.monitoring",' + #13#10 +
    '  "description": "BestQ Desktop Monitoring Agent",' + #13#10 +
    '  "path": "' + EscapedPath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": [' + #13#10 +
    '    "chrome-extension://{#ExtensionId}/"' + #13#10 +
    '  ]' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(ExpandConstant('{app}\com.bestq.monitoring.json'), Manifest, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteHostManifest();
end;

[UninstallDelete]
Type: files; Name: "{app}\com.bestq.monitoring.json"
Type: dirifempty; Name: "{app}"

[Messages]
FinishedLabel=BestQ Monitoring Agent is installed. Restart your browser and application tracking will connect automatically.
