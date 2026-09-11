# GUI-subsystem host for Windows Control Center commands.
# Electron must not spawn powershell.exe: it is a console binary and Windows
# Terminal opens a visible window even with windowsHide/CREATE_NO_WINDOW.
# pythonw.exe has no console; it starts the Job Object runner hidden.
import os
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000


def main():
    command = sys.argv[1:]
    if not command:
        raise SystemExit(2)
    # pythonw.exe has no console; sys.stdout is often None. Copy the child's
    # pipes onto fd 1/2 so a GUI parent still receives JSON or diagnostics.
    proc = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=CREATE_NO_WINDOW,
    )
    stdout, stderr = proc.communicate()
    if stdout:
        try:
            os.write(1, stdout)
        except OSError:
            pass
    if stderr:
        try:
            os.write(2, stderr)
        except OSError:
            pass
    raise SystemExit(proc.returncode)


if __name__ == "__main__":
    main()
