package openclaw

// OpenClaw 一键迁移 (`openclaw migrate ...`) 的 CLI 封装。
// 对应 OpenClaw 2026.4.26+ 的 Claude / Hermes importer。
// 所有调用经 RunCLI / 单独 exec 走 openclaw CLI，输出统一是 plugin-sdk/migration 的 JSON。

import (
	"ClawDeckX/internal/executil"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// MigrationProvider — 来自 `openclaw migrate list --json`。
type MigrationProvider struct {
	ID          string `json:"id"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source,omitempty"`
	PluginID    string `json:"pluginId,omitempty"`
}

type MigrationListResult struct {
	Providers []MigrationProvider `json:"providers"`
}

// MigrationItem — 单条迁移记录（来自 plugin-sdk/migration）。
type MigrationItem struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Action    string `json:"action"`
	Status    string `json:"status"`
	Target    string `json:"target,omitempty"`
	Sensitive bool   `json:"sensitive,omitempty"`
	Message   string `json:"message,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

type MigrationSummary struct {
	Total      int `json:"total"`
	Conflicts  int `json:"conflicts"`
	Sensitive  int `json:"sensitive"`
	Errors     int `json:"errors,omitempty"`
	Applied    int `json:"applied,omitempty"`
	Skipped    int `json:"skipped,omitempty"`
	Archived   int `json:"archived,omitempty"`
	ManualOnly int `json:"manualOnly,omitempty"`
}

type MigrationPlan struct {
	ProviderID string           `json:"providerId"`
	Source     string           `json:"source"`
	Target     string           `json:"target,omitempty"`
	Summary    MigrationSummary `json:"summary"`
	Items      []MigrationItem  `json:"items"`
	Warnings   []string         `json:"warnings,omitempty"`
	NextSteps  []string         `json:"nextSteps,omitempty"`
}

// MigrationApplyResult — apply 结果 = plan + 执行附加字段。
type MigrationApplyResult struct {
	MigrationPlan
	BackupPath string `json:"backupPath,omitempty"`
	ReportDir  string `json:"reportDir,omitempty"`
}

// DetectResult — UI 用，预先检测默认源目录是否存在。
type DetectResult struct {
	Provider string `json:"provider"`
	Path     string `json:"path"`
	Exists   bool   `json:"exists"`
}

// DefaultSourceDirs returns each known provider's expected source dir.
// 用户可在 plan/apply 时通过 --from 覆盖。
func DefaultSourceDirs() map[string]string {
	home, _ := os.UserHomeDir()
	if home == "" {
		return map[string]string{}
	}
	return map[string]string{
		"claude": filepath.Join(home, ".claude"),
		"hermes": filepath.Join(home, ".hermes"),
	}
}

// MigrateList wraps `openclaw migrate list --json`.
func MigrateList(ctx context.Context) (*MigrationListResult, error) {
	if !IsOpenClawInstalled() {
		return nil, fmt.Errorf("openclaw CLI is unavailable")
	}
	out, err := RunCLI(ctx, "migrate", "list", "--json")
	if err != nil {
		return nil, err
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return &MigrationListResult{Providers: []MigrationProvider{}}, nil
	}
	// `migrate list --json` 可能直接输出数组或带 wrapper，兼容两种。
	var asArray []MigrationProvider
	if jerr := json.Unmarshal([]byte(out), &asArray); jerr == nil {
		return &MigrationListResult{Providers: asArray}, nil
	}
	var asObj struct {
		Providers []MigrationProvider `json:"providers"`
	}
	if jerr := json.Unmarshal([]byte(out), &asObj); jerr != nil {
		return nil, fmt.Errorf("parse migrate list json: %w; raw=%s", jerr, out)
	}
	return &MigrationListResult{Providers: asObj.Providers}, nil
}

// MigrateOptions — 共享的 plan/apply 选项。
type MigrateOptions struct {
	Provider       string
	From           string
	IncludeSecrets bool
	Overwrite      bool
}

// MigratePlan wraps `openclaw migrate plan <provider> --json`.
// 永远不会改 OpenClaw 状态，安全可重复执行。
func MigratePlan(ctx context.Context, opts MigrateOptions) (*MigrationPlan, error) {
	if strings.TrimSpace(opts.Provider) == "" {
		return nil, fmt.Errorf("provider required")
	}
	args := []string{"migrate", "plan", opts.Provider, "--json"}
	if opts.From != "" {
		args = append(args, "--from", opts.From)
	}
	if opts.IncludeSecrets {
		args = append(args, "--include-secrets")
	}
	if opts.Overwrite {
		args = append(args, "--overwrite")
	}
	out, err := RunCLI(ctx, args...)
	if err != nil {
		return nil, err
	}
	var plan MigrationPlan
	if jerr := json.Unmarshal([]byte(out), &plan); jerr != nil {
		return nil, fmt.Errorf("parse migrate plan json: %w; raw=%s", jerr, out)
	}
	return &plan, nil
}

// ApplyOptions — apply 独有选项。
type ApplyOptions struct {
	MigrateOptions
	NoBackup     bool
	Force        bool
	BackupOutput string
}

// MigrateApply wraps `openclaw migrate apply <provider> --yes --json`.
// 永远使用 --yes 跳过 CLI 交互式确认；UI 端已显示 plan 并由用户点击同意。
// 注意：apply 默认会先做完整 backup，时间可能较长（120s timeout）。
func MigrateApply(opts ApplyOptions) (*MigrationApplyResult, error) {
	if strings.TrimSpace(opts.Provider) == "" {
		return nil, fmt.Errorf("provider required")
	}
	args := []string{"migrate", "apply", opts.Provider, "--yes", "--json"}
	if opts.From != "" {
		args = append(args, "--from", opts.From)
	}
	if opts.IncludeSecrets {
		args = append(args, "--include-secrets")
	}
	if opts.Overwrite {
		args = append(args, "--overwrite")
	}
	if opts.NoBackup {
		// CLI 强制要求 --no-backup 必须配合 --force 才能跳过备份。
		args = append(args, "--no-backup", "--force")
	}
	if opts.BackupOutput != "" {
		args = append(args, "--backup-output", opts.BackupOutput)
	}

	cmd := ResolveOpenClawCmd()
	if cmd == "" {
		return nil, fmt.Errorf("openclaw CLI is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, cmd, args...)
	executil.HideWindow(c)
	out, err := c.CombinedOutput()
	raw := strings.TrimSpace(string(out))
	if err != nil {
		// 失败时也试着解析 JSON（CLI 在某些 conflict 情况会写部分结果到 stdout）。
		var partial MigrationApplyResult
		if jerr := json.Unmarshal([]byte(raw), &partial); jerr == nil {
			return &partial, fmt.Errorf("openclaw migrate apply %s: %s", opts.Provider, raw)
		}
		return nil, fmt.Errorf("openclaw migrate apply %s: %s", opts.Provider, raw)
	}
	var result MigrationApplyResult
	if jerr := json.Unmarshal([]byte(raw), &result); jerr != nil {
		return nil, fmt.Errorf("parse migrate apply json: %w; raw=%s", jerr, raw)
	}
	return &result, nil
}

// DetectSources scans default source dirs for known providers.
func DetectSources() []DetectResult {
	out := []DetectResult{}
	for prov, dir := range DefaultSourceDirs() {
		exists := false
		if dir != "" {
			if st, err := os.Stat(dir); err == nil && st.IsDir() {
				exists = true
			}
		}
		out = append(out, DetectResult{Provider: prov, Path: dir, Exists: exists})
	}
	return out
}
