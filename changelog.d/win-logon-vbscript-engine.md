- **The Windows logon task no longer depends on the `.vbs` file association.**
  The scheduled action called `wscript.exe //B //NoLogo "<launcher>"`, so
  Windows resolved the launcher through the machine's `.vbs` association. Where
  that association belongs to an editor rather than Windows Script Host, logon
  stops starting the router with no error anywhere: the task reports success and
  nothing runs. The action now passes `//E:VBScript`, so the host loads the
  launcher with the engine it needs whatever the association says. The render
  tests carry the flag for both hosts, `wscript.exe` and `cscript.exe`.
