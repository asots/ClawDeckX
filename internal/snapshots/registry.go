package snapshots

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"ClawDeckX/internal/openclaw"
)

func defaultRegistry() []ResourceDefinition {
	stateDir := resolveStateDir()
	resources := []ResourceDefinition{
		{
			ID:          "openclaw.config",
			Type:        "config_json",
			DisplayName: "OpenClaw Config",
			LogicalPath: "files/config/openclaw.json",
			RestoreMode: RestoreModeJSON,
			Required:    true,
			ResolvePath: func() string { return filepath.Join(stateDir, "openclaw.json") },
		},
	}

	resources = append(resources, discoverAgentMarkdownResources(stateDir)...)
	resources = append(resources, discoverPersonaResources(stateDir)...)
	resources = append(resources, discoverCredentialResources(stateDir)...)
	resources = append(resources, discoverEnvFileResources(stateDir)...)
	resources = append(resources, discoverIncludeSubFiles(stateDir)...)

	sort.Slice(resources, func(i, j int) bool { return resources[i].ID < resources[j].ID })
	return resources
}

func resolveStateDir() string {
	return strings.TrimSpace(openclaw.ResolveStateDir())
}

func discoverAgentMarkdownResources(stateDir string) []ResourceDefinition {
	agentsDir := filepath.Join(stateDir, "agents")
	entries, err := os.ReadDir(agentsDir)
	if err != nil {
		return nil
	}

	items := make([]ResourceDefinition, 0)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		agentName := strings.TrimSpace(e.Name())
		if agentName == "" {
			continue
		}
		agentID := sanitizeResourceSegment(agentName)
		if agentID == "" {
			continue
		}

		type fileSpec struct {
			fileName    string
			idSuffix    string
			displayName string
		}
		for _, spec := range []fileSpec{
			{fileName: "SOUL.md", idSuffix: "soul_md", displayName: "SOUL.md"},
			{fileName: "USER.md", idSuffix: "user_md", displayName: "USER.md"},
			{fileName: "MEMORY.md", idSuffix: "memory_md", displayName: "MEMORY.md"},
			{fileName: "HEARTBEAT.md", idSuffix: "heartbeat_md", displayName: "HEARTBEAT.md"},
			{fileName: "TOOLS.md", idSuffix: "tools_md", displayName: "TOOLS.md"},
		} {
			fullPath := filepath.Join(agentsDir, agentName, spec.fileName)
			if !isRegularFile(fullPath) {
				continue
			}
			logicalPath := filepath.ToSlash(filepath.Join("files", "agents", agentName, spec.fileName))
			items = append(items, ResourceDefinition{
				ID:          fmt.Sprintf("agent.%s.%s", agentID, spec.idSuffix),
				Type:        "markdown",
				DisplayName: fmt.Sprintf("Agent %s %s", agentName, spec.displayName),
				LogicalPath: logicalPath,
				RestoreMode: RestoreModeFile,
				Required:    false,
				ResolvePath: func() string { return fullPath },
			})
		}
	}
	return items
}

func discoverPersonaResources(stateDir string) []ResourceDefinition {
	personasDir := filepath.Join(stateDir, "personas")
	entries, err := os.ReadDir(personasDir)
	if err != nil {
		return nil
	}

	items := make([]ResourceDefinition, 0)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := strings.TrimSpace(e.Name())
		if !strings.HasSuffix(strings.ToLower(name), ".json") {
			continue
		}
		base := strings.TrimSuffix(name, filepath.Ext(name))
		personaID := sanitizeResourceSegment(base)
		if personaID == "" {
			continue
		}
		fullPath := filepath.Join(personasDir, name)
		if !isRegularFile(fullPath) {
			continue
		}
		items = append(items, ResourceDefinition{
			ID:          fmt.Sprintf("persona.%s", personaID),
			Type:        "json",
			DisplayName: fmt.Sprintf("Persona %s", base),
			LogicalPath: filepath.ToSlash(filepath.Join("files", "personas", name)),
			RestoreMode: RestoreModeFile,
			Required:    false,
			ResolvePath: func() string { return fullPath },
		})
	}
	return items
}

func discoverIncludeSubFiles(stateDir string) []ResourceDefinition {
	configPath := filepath.Join(stateDir, "openclaw.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil
	}
	paths := collectIncludePaths(data)
	if len(paths) == 0 {
		return nil
	}
	items := make([]ResourceDefinition, 0, len(paths))
	seen := map[string]bool{}
	for _, relPath := range paths {
		absPath := filepath.Join(stateDir, filepath.FromSlash(relPath))
		absPath = filepath.Clean(absPath)
		if !isRegularFile(absPath) {
			continue
		}
		if seen[absPath] {
			continue
		}
		seen[absPath] = true
		seg := sanitizeResourceSegment(strings.TrimSuffix(filepath.Base(relPath), filepath.Ext(relPath)))
		if seg == "" {
			seg = "include"
		}
		logicalDir := filepath.ToSlash(filepath.Dir(relPath))
		logicalName := filepath.Base(relPath)
		p := absPath
		items = append(items, ResourceDefinition{
			ID:          fmt.Sprintf("include.%s", seg),
			Type:        "include_config",
			DisplayName: fmt.Sprintf("Include %s", relPath),
			LogicalPath: filepath.ToSlash(filepath.Join("files", "config", logicalDir, logicalName)),
			RestoreMode: RestoreModeFile,
			Required:    false,
			ResolvePath: func() string { return p },
		})
	}
	return items
}

func collectIncludePaths(data []byte) []string {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	var paths []string
	collectIncludePathsFromMap(raw, &paths)
	return paths
}

func collectIncludePathsFromMap(m map[string]json.RawMessage, paths *[]string) {
	for k, v := range m {
		if k == "$include" {
			var single string
			if err := json.Unmarshal(v, &single); err == nil {
				if single != "" {
					*paths = append(*paths, single)
				}
				continue
			}
			var arr []string
			if err := json.Unmarshal(v, &arr); err == nil {
				for _, s := range arr {
					if s != "" {
						*paths = append(*paths, s)
					}
				}
			}
			continue
		}
		var sub map[string]json.RawMessage
		if err := json.Unmarshal(v, &sub); err == nil {
			collectIncludePathsFromMap(sub, paths)
		}
	}
}

func discoverCredentialResources(stateDir string) []ResourceDefinition {
	credDir := filepath.Join(stateDir, "credentials")
	entries, err := os.ReadDir(credDir)
	if err != nil {
		return nil
	}
	items := make([]ResourceDefinition, 0)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := strings.TrimSpace(e.Name())
		if name == "" {
			continue
		}
		fullPath := filepath.Join(credDir, name)
		if !isRegularFile(fullPath) {
			continue
		}
		base := strings.TrimSuffix(name, filepath.Ext(name))
		segID := sanitizeResourceSegment(base)
		if segID == "" {
			continue
		}
		items = append(items, ResourceDefinition{
			ID:          fmt.Sprintf("credential.%s", segID),
			Type:        "credential",
			DisplayName: fmt.Sprintf("Credential %s", base),
			LogicalPath: filepath.ToSlash(filepath.Join("files", "credentials", name)),
			RestoreMode: RestoreModeFile,
			Required:    false,
			ResolvePath: func() string { return fullPath },
		})
	}
	return items
}

func discoverEnvFileResources(stateDir string) []ResourceDefinition {
	items := make([]ResourceDefinition, 0)
	envPath := filepath.Join(stateDir, ".env")
	if isRegularFile(envPath) {
		items = append(items, ResourceDefinition{
			ID:          "env_file",
			Type:        "env",
			DisplayName: ".env",
			LogicalPath: "files/config/.env",
			RestoreMode: RestoreModeFile,
			Required:    false,
			ResolvePath: func() string { return envPath },
		})
	}
	return items
}

func sanitizeResourceSegment(name string) string {
	name = strings.TrimSpace(strings.ToLower(name))
	if name == "" {
		return ""
	}
	var b strings.Builder
	lastUnderscore := false
	for _, r := range name {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
			lastUnderscore = false
		case r == '-' || r == '_':
			b.WriteRune(r)
			lastUnderscore = false
		default:
			if !lastUnderscore {
				b.WriteRune('_')
				lastUnderscore = true
			}
		}
	}
	return strings.Trim(b.String(), "_-")
}

func isRegularFile(path string) bool {
	st, err := os.Stat(path)
	if err != nil {
		return false
	}
	return st.Mode().IsRegular()
}
