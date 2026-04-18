//go:build windows

package handlers

import (
	"errors"
	"io"
)

// localShellSupported reports whether this platform can host a local PTY shell.
// Windows is currently unsupported — ConPTY support can be added later via
// github.com/UserExistsError/conpty if there is demand.
func localShellSupported() bool { return false }

func resolveDefaultShell() string { return "" }

func spawnLocalShell(id, shellPath, cwd string, cols, rows int) (*localSession, error) {
	return nil, errors.New("local terminal is not supported on Windows yet")
}

// stdout returns nil on Windows — callers must never reach here because
// spawnLocalShell fails first and HandleWS rejects the session.
func (s *localSession) stdout() io.Reader { return nil }
