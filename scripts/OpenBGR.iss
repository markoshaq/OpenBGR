; OpenBGR Windows stub installer (Inno Setup 6)
; Installs the lightweight application payload (<1 MB); OpenBGR.exe provisions
; the standalone Python + PyTorch runtime on first launch with a native progress
; window (and auto-selects CUDA wheels when an NVIDIA GPU is detected).

#ifndef MyAppVersion
  #define MyAppVersion "0.11.0"
#endif
#ifndef SourceDir
  #define SourceDir AddBackslash(SourcePath) + "..\dist\OpenBGR-Windows"
#endif
#ifndef OutputDir
  #define OutputDir AddBackslash(SourcePath) + "..\dist"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "OpenBGR-Setup"
#endif

#define MyAppName "OpenBGR"
#define MyAppPublisher "OpenBGR"
#define MyAppURL "https://github.com/markoshaq/OpenBGR"
#define MyAppExeName "OpenBGR.exe"

[Setup]
AppId={{4F7E4B4B-FFEF-5CA9-AD3F-A879BAB9C8A7}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\OpenBGR
DefaultGroupName=OpenBGR
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#SourceDir}\OpenBGR.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
LicenseFile={#SourceDir}\LICENSE
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked
Name: "contextmenu"; Description: "Add &Explorer right-click commands"; GroupDescription: "Windows integration:"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.venv"
Type: filesandordirs; Name: "{app}\__pycache__"
Type: filesandordirs; Name: "{app}\openbgr\__pycache__"
Type: dirifempty; Name: "{app}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\OpenBGR"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\OpenBGR.ico"
Name: "{autodesktop}\OpenBGR"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\OpenBGR.ico"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\image\shell\OpenBGR.RemoveBG"; ValueType: string; ValueName: "MUIVerb"; ValueData: "Remove Background with OpenBGR"; Tasks: contextmenu; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\image\shell\OpenBGR.RemoveBG"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\OpenBGR.ico"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\image\shell\OpenBGR.RemoveBG\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" --quick-action ""%1"""; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\image\shell\OpenBGR.Open"; ValueType: string; ValueName: "MUIVerb"; ValueData: "Open in OpenBGR"; Tasks: contextmenu; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\image\shell\OpenBGR.Open"; ValueType: string; ValueName: "Icon"; ValueData: "{app}\OpenBGR.ico"; Tasks: contextmenu
Root: HKCU; Subkey: "Software\Classes\SystemFileAssociations\image\shell\OpenBGR.Open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Tasks: contextmenu

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch OpenBGR"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\cmd.exe"; Parameters: "/c ""{app}\scripts\uninstall_windows_context_menu.bat"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveOpenBGRContextMenu"
