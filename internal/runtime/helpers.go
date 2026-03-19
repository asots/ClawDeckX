package runtime

import (
	"os"
	"os/exec"
	"strings"

	"ClawDeckX/internal/version"
)

// IsDocker returns true if running inside a Docker container.
func IsDocker() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	data, err := os.ReadFile("/proc/1/cgroup")
	if err == nil {
		s := string(data)
		if strings.Contains(s, "docker") || strings.Contains(s, "containerd") {
			return true
		}
	}
	return false
}

// imageClawDeckXVersion returns the ClawDeckX version baked into the Docker image.
// We read this from a stamp file written by the entrypoint at first boot.
// Falls back to the compiled-in version constant.
func imageClawDeckXVersion() string {
	data, err := os.ReadFile("/app/.image-version")
	if err == nil {
		v := strings.TrimSpace(string(data))
		if v != "" {
			return v
		}
	}
	return version.Version
}

// imageOpenClawVersion returns the OpenClaw version baked into the Docker image.
func imageOpenClawVersion() string {
	data, err := os.ReadFile("/opt/openclaw/.image-version")
	if err == nil {
		v := strings.TrimSpace(string(data))
		if v != "" {
			return v
		}
	}
	// Fallback: try running the image binary directly
	return currentOpenClawVersion()
}

// currentOpenClawVersion returns the currently active OpenClaw version.
func currentOpenClawVersion() string {
	out, err := exec.Command("openclaw", "--version").CombinedOutput()
	if err != nil {
		return ""
	}
	// Output is typically "openclaw vYYYY.M.D" or just a version string
	s := strings.TrimSpace(string(out))
	s = strings.TrimPrefix(s, "openclaw ")
	s = strings.TrimPrefix(s, "v")
	// Take the first line only
	if idx := strings.IndexByte(s, '\n'); idx > 0 {
		s = s[:idx]
	}
	return strings.TrimSpace(s)
}
