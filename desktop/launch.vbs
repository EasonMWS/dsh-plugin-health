' Run launch.cmd with no console window.
'
' Two things this does that a plain .cmd shortcut cannot:
'
'   1. No visible console. The .cmd repairs the environment and then waits for Electron, so a console
'      window would sit behind the app for as long as it runs. Window style 0 hides it.
'   2. No quoting maze. The repair lives in launch.cmd, where a batch file can clear and use the
'      variable without the nested-quote problem a VBS command line has.
'
' Why the environment needs repairing at all: ELECTRON_RUN_AS_NODE turns electron.exe into plain Node
' with no GUI API. It is set by some hosts — DSH sets it for the processes it spawns — and children
' inherit it. Electron reads it before loading any script, so main.cjs cannot clear it for itself; by
' the time it runs, require("electron") has already returned a string.

Option Explicit

Dim shell, fso, here, launcher
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = here & "\launch.cmd"

If Not fso.FileExists(launcher) Then
  MsgBox "launch.cmd is missing next to this script.", 16, "Plugin health"
  WScript.Quit 1
End If

' 0 = hidden, False = do not wait.
On Error Resume Next
shell.Run """" & launcher & """", 0, False
If Err.Number <> 0 Then
  MsgBox "Could not start Plugin health:" & vbCrLf & Err.Description, 16, "Plugin health"
  WScript.Quit 1
End If
On Error GoTo 0
