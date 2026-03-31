package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"ClawDeckX/internal/i18n"
	"ClawDeckX/internal/logger"
	"ClawDeckX/internal/openclaw"
	"ClawDeckX/internal/web"
)

// MultiAgentHandler handles multi-agent deployment operations.
type MultiAgentHandler struct {
	client *openclaw.GWClient
	wsHub  interface {
		Broadcast(channel, msgType string, data interface{})
	}
}

func NewMultiAgentHandler(client *openclaw.GWClient) *MultiAgentHandler {
	return &MultiAgentHandler{client: client}
}

// SetWSHub injects the WSHub for broadcasting generation progress events.
func (h *MultiAgentHandler) SetWSHub(hub interface {
	Broadcast(channel, msgType string, data interface{})
}) {
	h.wsHub = hub
}

// AgentConfig represents a single agent configuration in a multi-agent template.
type AgentConfig struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Role        string            `json:"role"`
	Description string            `json:"description,omitempty"`
	Icon        string            `json:"icon,omitempty"`
	Color       string            `json:"color,omitempty"`
	Soul        string            `json:"soul,omitempty"`
	AgentsMd    string            `json:"agentsMd,omitempty"`   // AGENTS.md workspace startup instructions
	UserMd      string            `json:"userMd,omitempty"`     // USER.md profile of the user this agent serves
	IdentityMd  string            `json:"identityMd,omitempty"` // IDENTITY.md agent name/creature/vibe/emoji
	Heartbeat   string            `json:"heartbeat,omitempty"`
	Tools       string            `json:"tools,omitempty"`
	Skills      []string          `json:"skills,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
}

// WorkflowStep represents a step in the multi-agent workflow.
type WorkflowStep struct {
	Agent     string   `json:"agent,omitempty"`
	Agents    []string `json:"agents,omitempty"`
	Action    string   `json:"action"`
	Parallel  bool     `json:"parallel,omitempty"`
	Condition string   `json:"condition,omitempty"`
	Timeout   int      `json:"timeout,omitempty"` // seconds
}

// WorkflowConfig represents the workflow configuration.
type WorkflowConfig struct {
	Type        string         `json:"type"` // sequential, parallel, collaborative, event-driven, routing
	Description string         `json:"description,omitempty"`
	Steps       []WorkflowStep `json:"steps"`
}

// BindingConfig represents routing bindings between agents and channels.
type BindingConfig struct {
	AgentID string                 `json:"agentId"`
	Match   map[string]interface{} `json:"match"`
}

// MultiAgentTemplate represents a complete multi-agent deployment template.
type MultiAgentTemplate struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Agents      []AgentConfig   `json:"agents"`
	Workflow    WorkflowConfig  `json:"workflow"`
	Bindings    []BindingConfig `json:"bindings,omitempty"`
}

// DeployRequest represents a multi-agent deployment request.
type DeployRequest struct {
	Template     MultiAgentTemplate `json:"template"`
	Prefix       string             `json:"prefix,omitempty"`       // Prefix for agent IDs
	SkipExisting bool               `json:"skipExisting,omitempty"` // Skip if agent already exists
	DryRun       bool               `json:"dryRun,omitempty"`       // Preview only, don't create
}

// DeployResult represents the result of a multi-agent deployment.
type DeployResult struct {
	Success            bool                `json:"success"`
	DeployedCount      int                 `json:"deployedCount"`
	SkippedCount       int                 `json:"skippedCount"`
	Agents             []AgentDeployStatus `json:"agents"`
	Bindings           []BindingStatus     `json:"bindings,omitempty"`
	Errors             []string            `json:"errors,omitempty"`
	CoordinatorUpdated bool                `json:"coordinatorUpdated"`
	CoordinatorError   string              `json:"coordinatorError,omitempty"`
}

// AgentDeployStatus represents the deployment status of a single agent.
type AgentDeployStatus struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"` // created, skipped, failed
	Workspace string `json:"workspace,omitempty"`
	Error     string `json:"error,omitempty"`
}

// BindingStatus represents the status of a binding configuration.
type BindingStatus struct {
	AgentID string `json:"agentId"`
	Status  string `json:"status"` // configured, failed
	Error   string `json:"error,omitempty"`
}

// GenerateRequest represents a request to generate a multi-agent team from a scenario description.
type GenerateRequest struct {
	ScenarioName string `json:"scenarioName"`
	Description  string `json:"description"`
	TeamSize     string `json:"teamSize"`     // small (3-4), medium (5-7), large (8+)
	WorkflowType string `json:"workflowType"` // sequential, parallel, collaborative, event-driven, routing
	Language     string `json:"language"`
	ModelID      string `json:"modelId"` // optional: provider/model path override
}

// GenerateResult represents the AI-generated multi-agent team definition.
type GenerateResult struct {
	Template  MultiAgentTemplate `json:"template"`
	Reasoning string             `json:"reasoning"`
}

// Generate uses the connected LLM to analyze a scenario and generate a multi-agent team definition.
func (h *MultiAgentHandler) Generate(w http.ResponseWriter, r *http.Request) {
	var req GenerateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.Fail(w, r, "INVALID_REQUEST", fmt.Sprintf("invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	if req.ScenarioName == "" || req.Description == "" {
		web.Fail(w, r, "INVALID_REQUEST", "scenarioName and description are required", http.StatusBadRequest)
		return
	}

	if req.TeamSize == "" {
		req.TeamSize = "medium"
	}
	if req.WorkflowType == "" {
		req.WorkflowType = "collaborative"
	}
	if req.Language == "" {
		req.Language = "en"
	}

	agentCountHint := "5 to 7"
	switch req.TeamSize {
	case "small":
		agentCountHint = "3 to 4"
	case "large":
		agentCountHint = "8 to 10"
	}

	langHint := "English"
	if req.Language == "zh" || req.Language == "zh-TW" {
		langHint = "Chinese"
	} else if req.Language == "ja" {
		langHint = "Japanese"
	} else if req.Language == "ko" {
		langHint = "Korean"
	}

	prompt := fmt.Sprintf(`You are an AI system architect. Analyze the following scenario and generate a multi-agent team configuration in strict JSON format.

Scenario Name: %s
Scenario Description: %s
Team Size: %s agents
Workflow Type: %s
Output Language for agent names/roles/descriptions: %s

Requirements:
1. Generate %s specialized AI agents appropriate for this scenario
2. Each agent should have a distinct role with clear responsibilities
3. Design a workflow that shows how agents collaborate
4. Generate detailed SOUL.md content for each agent (their persona, responsibilities, working style)
5. Generate AGENTS.md content for each agent (workspace startup instructions: which files to read, memory rules, red lines, group chat rules, heartbeat behavior — tailored to this agent's role)
6. Generate USER.md content for each agent (profile of the human/team member this agent primarily serves — name placeholder, context about what this role needs from the user, preferences)
7. Generate IDENTITY.md content for each agent (Name, Creature, Vibe, Emoji fields — fit the agent's personality)
8. Generate HEARTBEAT.md checklist items for each agent
9. Use lowercase kebab-case for agent IDs (e.g., "project-manager", "backend-dev")
10. Choose appropriate Material Symbols icon names for each agent
11. Choose appropriate Tailwind color classes (e.g., "from-blue-500 to-cyan-500")

Respond ONLY with a JSON object in this exact structure (no markdown, no explanation outside JSON):
{
  "reasoning": "Brief explanation of why you chose these agents and this workflow",
  "template": {
    "id": "kebab-case-id-based-on-scenario-name",
    "name": "Human-readable team name",
    "description": "Team purpose description",
    "agents": [
      {
        "id": "agent-id",
        "name": "Agent Display Name",
        "role": "One-line role description",
        "description": "Detailed description of agent responsibilities",
        "icon": "material_symbol_name",
        "color": "from-blue-500 to-cyan-500",
        "soul": "Full SOUL.md content in markdown — persona, responsibilities, working style",
        "agentsMd": "Full AGENTS.md content — workspace startup instructions tailored to this agent",
        "userMd": "Full USER.md content — profile template for the human this agent serves",
        "identityMd": "Full IDENTITY.md content — Name/Creature/Vibe/Emoji for this agent",
        "heartbeat": "- [ ] Task 1\n- [ ] Task 2"
      }
    ],
    "workflow": {
      "type": "%s",
      "description": "How agents collaborate",
      "steps": [
        {
          "agent": "agent-id",
          "action": "What this agent does in this step"
        }
      ]
    }
  }
}`, req.ScenarioName, req.Description, agentCountHint, req.WorkflowType, langHint, agentCountHint, req.WorkflowType)

	// Pre-flight: fail fast if gateway is not connected rather than waiting for a 600s timeout.
	if !h.client.IsConnected() {
		web.Fail(w, r, "GATEWAY_DISCONNECTED", "gateway is not connected", http.StatusServiceUnavailable)
		return
	}

	// Call the main agent via sessions.send to generate the team definition
	// First create a temporary session for generation
	sessionParams := map[string]interface{}{
		"agentId": "main",
		"label":   fmt.Sprintf("__gen_team_%d", time.Now().UnixNano()),
	}
	if req.ModelID != "" {
		sessionParams["model"] = req.ModelID
	}

	sessionData, err := h.client.RequestWithTimeout("sessions.create", sessionParams, 10*time.Second)
	if err != nil {
		web.Fail(w, r, "SESSION_CREATE_FAILED", fmt.Sprintf("failed to create generation session: %v", err), http.StatusBadGateway)
		return
	}

	var sessionResp struct {
		SessionKey string `json:"sessionKey"`
		Key        string `json:"key"`
	}
	if err := json.Unmarshal(sessionData, &sessionResp); err != nil {
		web.Fail(w, r, "SESSION_PARSE_FAILED", "failed to parse session response", http.StatusBadGateway)
		return
	}
	sessionKey := sessionResp.SessionKey
	if sessionKey == "" {
		sessionKey = sessionResp.Key
	}
	if sessionKey == "" {
		web.Fail(w, r, "SESSION_KEY_MISSING", "no session key returned", http.StatusBadGateway)
		return
	}

	// Send the generation prompt, broadcasting keepalive progress while waiting.
	sendParams := map[string]interface{}{
		"sessionKey": sessionKey,
		"message":    prompt,
	}

	// Keepalive: broadcast gen_progress so the frontend can subscribe to chat delta events
	// using the sessionKey, and track elapsed time server-side.
	type genProgressPayload struct {
		RequestID  string `json:"requestId"`
		SessionKey string `json:"sessionKey"`
		Elapsed    int    `json:"elapsed"`
		Phase      string `json:"phase"`
		ErrorCode  string `json:"errorCode,omitempty"`
		ErrorMsg   string `json:"errorMsg,omitempty"`
	}
	requestID := fmt.Sprintf("%d", time.Now().UnixNano())
	progDone := make(chan struct{})
	progStart := time.Now()
	if h.wsHub != nil {
		// Broadcast immediately so frontend gets the sessionKey before the first 5s tick
		h.wsHub.Broadcast("gw_event", "gen_progress", genProgressPayload{
			RequestID:  requestID,
			SessionKey: sessionKey,
			Elapsed:    0,
			Phase:      "thinking",
		})
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-progDone:
					return
				case <-ticker.C:
					elapsed := int(time.Since(progStart).Seconds())
					h.wsHub.Broadcast("gw_event", "gen_progress", genProgressPayload{
						RequestID:  requestID,
						SessionKey: sessionKey,
						Elapsed:    elapsed,
						Phase:      "thinking",
					})
				}
			}
		}()
	}

	msgData, err := h.client.RequestWithTimeout("sessions.send", sendParams, 600*time.Second)
	close(progDone)
	if h.wsHub != nil {
		// Signal completion/failure so frontend can stop waiting
		prog := genProgressPayload{
			RequestID:  requestID,
			SessionKey: sessionKey,
			Elapsed:    int(time.Since(progStart).Seconds()),
			Phase:      "done",
		}
		if err != nil {
			prog.Phase = "error"
			errStr := err.Error()
			switch {
			case strings.Contains(errStr, "not connected") ||
				strings.Contains(errStr, "connection closed") ||
				strings.Contains(errStr, "use of closed") ||
				strings.Contains(errStr, "broken pipe") ||
				strings.Contains(errStr, "EOF"):
				prog.ErrorCode = "GATEWAY_DISCONNECTED"
				prog.ErrorMsg = "Gateway connection lost during generation"
			case strings.Contains(errStr, "timeout") ||
				strings.Contains(errStr, "deadline") ||
				strings.Contains(errStr, "timed out"):
				prog.ErrorCode = "TIMEOUT"
				prog.ErrorMsg = "Generation timed out"
			default:
				prog.ErrorCode = "LLM_SEND_FAILED"
				prog.ErrorMsg = errStr
			}
		}
		h.wsHub.Broadcast("gw_event", "gen_progress", prog)
	}
	if err != nil {
		web.Fail(w, r, "LLM_SEND_FAILED", fmt.Sprintf("failed to send generation request: %v", err), http.StatusBadGateway)
		return
	}

	// Clean up the generation session asynchronously
	go func() {
		h.client.Request("sessions.delete", map[string]interface{}{"key": sessionKey, "deleteTranscript": true}) //nolint:errcheck
	}()

	// Parse the LLM response
	var msgResp struct {
		Content string `json:"content"`
		Text    string `json:"text"`
		Message struct {
			Content string `json:"content"`
			Text    string `json:"text"`
		} `json:"message"`
	}
	if err := json.Unmarshal(msgData, &msgResp); err != nil {
		web.Fail(w, r, "LLM_PARSE_FAILED", "failed to parse LLM response", http.StatusBadGateway)
		return
	}

	rawContent := msgResp.Content
	if rawContent == "" {
		rawContent = msgResp.Text
	}
	if rawContent == "" {
		rawContent = msgResp.Message.Content
	}
	if rawContent == "" {
		rawContent = msgResp.Message.Text
	}

	if rawContent == "" {
		web.Fail(w, r, "LLM_EMPTY_RESPONSE", "LLM returned empty response", http.StatusBadGateway)
		return
	}

	// Extract JSON from response (handle cases where LLM wraps it in markdown)
	jsonStr := extractJSON(rawContent)
	if jsonStr == "" {
		web.Fail(w, r, "LLM_NO_JSON", "could not extract JSON from LLM response", http.StatusBadGateway)
		return
	}

	var result GenerateResult
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		web.Fail(w, r, "LLM_JSON_INVALID", fmt.Sprintf("LLM returned invalid JSON: %v", err), http.StatusBadGateway)
		return
	}

	// Validate and sanitize the generated template
	if len(result.Template.Agents) == 0 {
		web.Fail(w, r, "LLM_NO_AGENTS", "LLM generated no agents", http.StatusBadGateway)
		return
	}

	// Ensure template has required fields
	if result.Template.ID == "" {
		result.Template.ID = sanitizeID(req.ScenarioName)
	}
	if result.Template.Name == "" {
		result.Template.Name = req.ScenarioName
	}
	if result.Template.Description == "" {
		result.Template.Description = req.Description
	}

	web.OK(w, r, result)
}

// extractJSON extracts a JSON object from a string that may contain markdown code fences or extra text.
func extractJSON(s string) string {
	// Try direct parse first
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "{") {
		return s
	}

	// Strip markdown code fences
	for _, fence := range []string{"```json", "```JSON", "```"} {
		if idx := strings.Index(s, fence); idx >= 0 {
			s = s[idx+len(fence):]
			if end := strings.LastIndex(s, "```"); end >= 0 {
				s = s[:end]
			}
			s = strings.TrimSpace(s)
			if strings.HasPrefix(s, "{") {
				return s
			}
		}
	}

	// Find first { to last }
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}

	return ""
}

// sanitizeID converts a string to a valid kebab-case ID.
func sanitizeID(s string) string {
	s = strings.ToLower(s)
	var result strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			result.WriteRune(r)
		} else if r == ' ' || r == '-' || r == '_' {
			result.WriteRune('-')
		}
	}
	id := strings.Trim(result.String(), "-")
	if id == "" {
		return "custom-team"
	}
	return id
}

// Deploy handles the multi-agent deployment request.
func (h *MultiAgentHandler) Deploy(w http.ResponseWriter, r *http.Request) {
	var req DeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.Fail(w, r, "INVALID_REQUEST", fmt.Sprintf("invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	// Execute deployment logic
	h.executeDeploy(w, r, &req)
}

// Preview returns a preview of what would be deployed.
func (h *MultiAgentHandler) Preview(w http.ResponseWriter, r *http.Request) {
	var req DeployRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.Fail(w, r, "INVALID_REQUEST", fmt.Sprintf("invalid request body: %v", err), http.StatusBadRequest)
		return
	}

	// Force dry run for preview
	req.DryRun = true

	// Execute deployment logic
	h.executeDeploy(w, r, &req)
}

// executeDeploy contains the main deployment logic
func (h *MultiAgentHandler) executeDeploy(w http.ResponseWriter, r *http.Request, req *DeployRequest) {
	if len(req.Template.Agents) == 0 {
		web.Fail(w, r, "INVALID_TEMPLATE", "template must have at least one agent", http.StatusBadRequest)
		return
	}

	result := DeployResult{
		Success: true,
		Agents:  make([]AgentDeployStatus, 0, len(req.Template.Agents)),
	}

	// Get OpenClaw home directory
	homeDir, err := h.getOpenClawHome()
	if err != nil {
		web.Fail(w, r, "OPENCLAW_HOME_ERROR", err.Error(), http.StatusInternalServerError)
		return
	}

	// Get current config to check existing agents
	existingAgents, err := h.getExistingAgents()
	if err != nil {
		web.Fail(w, r, "GET_AGENTS_FAILED", err.Error(), http.StatusBadGateway)
		return
	}

	existingMap := make(map[string]bool)
	for _, a := range existingAgents {
		existingMap[a] = true
	}

	// Deploy each agent
	for _, agentCfg := range req.Template.Agents {
		agentID := agentCfg.ID
		if req.Prefix != "" {
			agentID = req.Prefix + "-" + agentID
		}

		status := AgentDeployStatus{
			ID:   agentID,
			Name: agentCfg.Name,
		}

		// Check if agent already exists
		if existingMap[agentID] {
			if req.SkipExisting {
				status.Status = "skipped"
				result.SkippedCount++
				result.Agents = append(result.Agents, status)
				continue
			}
		}

		if req.DryRun {
			status.Status = "preview"
			status.Workspace = filepath.Join(homeDir, "agents", agentID)
			result.Agents = append(result.Agents, status)
			continue
		}

		// Create agent using agents.create API
		// Note: OpenClaw uses 'name' to generate agentId, so we pass the agentID as name
		// The display name will be set via IDENTITY.md file
		workspace := filepath.Join(homeDir, "agents", agentID)
		createParams := map[string]interface{}{
			"name":      agentID, // Use agentID as name (OpenClaw generates agentId from name)
			"workspace": workspace,
		}
		if agentCfg.Icon != "" {
			createParams["emoji"] = agentCfg.Icon
		}

		_, err := h.client.Request("agents.create", createParams)
		if err != nil {
			// If agent already exists, try to continue
			errStr := err.Error()
			if strings.Contains(errStr, "already exists") {
				status.Status = "skipped"
				status.Workspace = workspace
				result.SkippedCount++
			} else {
				status.Status = "failed"
				status.Error = errStr
				result.Errors = append(result.Errors, fmt.Sprintf("agent %s: %s", agentID, errStr))
				result.Success = false
			}
		} else {
			status.Status = "created"
			status.Workspace = workspace
			result.DeployedCount++

			// Write agent configuration files
			if _, writeErr := h.createAgentWorkspace(homeDir, agentID, agentCfg); writeErr != nil {
				logger.Log.Warn().Err(writeErr).Str("agentId", agentID).Msg("Failed to write agent config files")
			}
		}

		result.Agents = append(result.Agents, status)
	}

	// Note: agents.reload is not a valid gateway RPC method.
	// Gateway auto-reloads agents after config changes.

	// Configure main agent to know about deployed subagents
	// Do this even if all agents were skipped (already exist)
	if !req.DryRun {
		deployedAgents := make([]AgentDeployStatus, 0)
		for _, status := range result.Agents {
			if status.Status == "created" || status.Status == "skipped" {
				deployedAgents = append(deployedAgents, status)
			}
		}
		if len(deployedAgents) > 0 {
			// Update main agent's SOUL.md with subagent information
			logger.Log.Info().
				Int("deployedCount", result.DeployedCount).
				Int("skippedCount", result.SkippedCount).
				Int("totalAgents", len(deployedAgents)).
				Msg("Configuring coordinator agent")

			if err := h.configureCoordinatorAgent("main", req.Template.Name, deployedAgents); err != nil {
				logger.Log.Warn().Err(err).Msg("Failed to configure coordinator agent")
				result.CoordinatorError = err.Error()
			} else {
				result.CoordinatorUpdated = true
			}
		}
	}

	// Configure bindings if provided
	if !req.DryRun && len(req.Template.Bindings) > 0 {
		result.Bindings = h.configureBindings(req.Template.Bindings, req.Prefix)
	}

	web.OK(w, r, result)
}

// Status returns the status of deployed multi-agent systems.
func (h *MultiAgentHandler) Status(w http.ResponseWriter, r *http.Request) {
	// Get current agents
	data, err := h.client.Request("agents.list", map[string]interface{}{})
	if err != nil {
		web.Fail(w, r, "GET_AGENTS_FAILED", err.Error(), http.StatusBadGateway)
		return
	}

	var agentsResp struct {
		Agents []struct {
			ID        string `json:"id"`
			Workspace string `json:"workspace"`
			Default   bool   `json:"default"`
		} `json:"agents"`
	}

	if err := json.Unmarshal(data, &agentsResp); err != nil {
		// Try alternative format
		var altResp []struct {
			ID        string `json:"id"`
			Workspace string `json:"workspace"`
			Default   bool   `json:"default"`
		}
		if err2 := json.Unmarshal(data, &altResp); err2 != nil {
			web.Fail(w, r, "PARSE_AGENTS_FAILED", err.Error(), http.StatusBadGateway)
			return
		}
		agentsResp.Agents = altResp
	}

	// Group agents by prefix to identify multi-agent deployments
	deployments := make(map[string][]string)
	standalone := make([]string, 0)

	for _, agent := range agentsResp.Agents {
		parts := strings.SplitN(agent.ID, "-", 2)
		if len(parts) == 2 {
			deployments[parts[0]] = append(deployments[parts[0]], agent.ID)
		} else {
			standalone = append(standalone, agent.ID)
		}
	}

	web.OK(w, r, map[string]interface{}{
		"totalAgents": len(agentsResp.Agents),
		"deployments": deployments,
		"standalone":  standalone,
	})
}

// Delete removes a multi-agent deployment.
func (h *MultiAgentHandler) Delete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Prefix string   `json:"prefix"`
		Agents []string `json:"agents,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		web.Fail(w, r, "INVALID_REQUEST", "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Prefix == "" && len(req.Agents) == 0 {
		web.Fail(w, r, "INVALID_REQUEST", "prefix or agents list required", http.StatusBadRequest)
		return
	}

	// Get current config
	raw, err := h.client.Request("config.get", map[string]interface{}{})
	if err != nil {
		web.Fail(w, r, "GET_CONFIG_FAILED", err.Error(), http.StatusBadGateway)
		return
	}

	var wrapper map[string]interface{}
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		web.Fail(w, r, "PARSE_CONFIG_FAILED", err.Error(), http.StatusBadGateway)
		return
	}

	var currentCfg map[string]interface{}
	if parsed, ok := wrapper["parsed"]; ok {
		if m, ok := parsed.(map[string]interface{}); ok {
			currentCfg = m
		}
	}
	if currentCfg == nil {
		web.Fail(w, r, "PARSE_CONFIG_FAILED", "failed to parse current config", http.StatusBadGateway)
		return
	}

	// Remove agents from config
	agentsCfg, _ := currentCfg["agents"].(map[string]interface{})
	if agentsCfg == nil {
		web.OK(w, r, map[string]interface{}{"removed": 0})
		return
	}

	agentsList, _ := agentsCfg["list"].([]interface{})
	if agentsList == nil {
		web.OK(w, r, map[string]interface{}{"removed": 0})
		return
	}

	// Filter out agents to remove
	toRemove := make(map[string]bool)
	if req.Prefix != "" {
		for _, a := range agentsList {
			if agent, ok := a.(map[string]interface{}); ok {
				if id, ok := agent["id"].(string); ok {
					if strings.HasPrefix(id, req.Prefix+"-") {
						toRemove[id] = true
					}
				}
			}
		}
	}
	for _, id := range req.Agents {
		toRemove[id] = true
	}

	newList := make([]interface{}, 0)
	removed := 0
	for _, a := range agentsList {
		if agent, ok := a.(map[string]interface{}); ok {
			if id, ok := agent["id"].(string); ok {
				if toRemove[id] {
					removed++
					continue
				}
			}
		}
		newList = append(newList, a)
	}

	agentsCfg["list"] = newList

	// Update config
	cfgJSON, jsonErr := json.Marshal(currentCfg)
	if jsonErr != nil {
		web.Fail(w, r, "CONFIG_SERIALIZE_FAILED", jsonErr.Error(), http.StatusInternalServerError)
		return
	}
	_, err = h.client.Request("config.set", map[string]interface{}{
		"raw": string(cfgJSON),
	})
	if err != nil {
		web.Fail(w, r, "UPDATE_CONFIG_FAILED", err.Error(), http.StatusBadGateway)
		return
	}

	web.OK(w, r, map[string]interface{}{
		"removed": removed,
		"agents":  toRemove,
	})
}

// Helper functions

func (h *MultiAgentHandler) getOpenClawHome() (string, error) {
	// Try to get from config
	data, err := h.client.Request("config.get", map[string]interface{}{})
	if err == nil {
		var wrapper map[string]interface{}
		if json.Unmarshal(data, &wrapper) == nil {
			if parsed, ok := wrapper["parsed"].(map[string]interface{}); ok {
				if home, ok := parsed["home"].(string); ok && home != "" {
					return home, nil
				}
			}
		}
	}

	// Fallback to default
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".openclaw"), nil
}

func (h *MultiAgentHandler) getExistingAgents() ([]string, error) {
	data, err := h.client.Request("agents.list", map[string]interface{}{})
	if err != nil {
		return nil, err
	}

	var result []string

	// Try parsing as object with agents array
	var agentsResp struct {
		Agents []struct {
			ID string `json:"id"`
		} `json:"agents"`
	}
	if json.Unmarshal(data, &agentsResp) == nil && len(agentsResp.Agents) > 0 {
		for _, a := range agentsResp.Agents {
			result = append(result, a.ID)
		}
		return result, nil
	}

	// Try parsing as direct array
	var directList []struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &directList) == nil {
		for _, a := range directList {
			result = append(result, a.ID)
		}
	}

	return result, nil
}

func (h *MultiAgentHandler) createAgentWorkspace(homeDir, agentID string, cfg AgentConfig) (string, error) {
	workspace := filepath.Join(homeDir, "agents", agentID)

	// Create workspace directory
	if err := os.MkdirAll(workspace, 0755); err != nil {
		return "", fmt.Errorf("%s", i18n.T(i18n.MsgFileDirCreateFailed, map[string]interface{}{"Error": err.Error()}))
	}

	// Create SOUL.md
	soulContent := fmt.Sprintf("# %s\n\n**Role:** %s\n\n%s\n", cfg.Name, cfg.Role, cfg.Description)
	if cfg.Soul != "" {
		soulContent = cfg.Soul
	}
	if err := os.WriteFile(filepath.Join(workspace, "SOUL.md"), []byte(soulContent), 0644); err != nil {
		return "", fmt.Errorf("%s", i18n.T(i18n.MsgFileCreateFailed, map[string]interface{}{"File": "SOUL.md", "Error": err.Error()}))
	}

	// Create AGENTS.md
	agentsMdContent := fmt.Sprintf("# AGENTS.md - %s Workspace\n\nThis is the workspace for **%s** (%s).\n\n## Session Startup\n\n1. Read `SOUL.md` — this is who you are\n2. Read `USER.md` — this is who you're helping\n3. Read `memory/YYYY-MM-DD.md` for recent context\n\n## Red Lines\n\n- Don't exfiltrate private data. Ever.\n- Don't run destructive commands without asking.\n- When in doubt, ask.\n", cfg.Name, cfg.Name, cfg.Role)
	if cfg.AgentsMd != "" {
		agentsMdContent = cfg.AgentsMd
	}
	if err := os.WriteFile(filepath.Join(workspace, "AGENTS.md"), []byte(agentsMdContent), 0644); err != nil {
		return "", fmt.Errorf("%s", i18n.T(i18n.MsgFileCreateFailed, map[string]interface{}{"File": "AGENTS.md", "Error": err.Error()}))
	}

	// Create USER.md if provided, else write a blank template
	userMdContent := fmt.Sprintf("# USER.md - About Your Human\n\n_Learn about the person you're helping. Update this as you go._\n\n- **Name:**\n- **What to call them:**\n- **Pronouns:** _(optional)_\n- **Timezone:**\n- **Notes:**\n\n## Context\n\n_(What are their goals for the %s role? What do they care about? Build this over time.)_\n", cfg.Role)
	if cfg.UserMd != "" {
		userMdContent = cfg.UserMd
	}
	if err := os.WriteFile(filepath.Join(workspace, "USER.md"), []byte(userMdContent), 0644); err != nil {
		return "", fmt.Errorf("%s", i18n.T(i18n.MsgFileCreateFailed, map[string]interface{}{"File": "USER.md", "Error": err.Error()}))
	}

	// Create IDENTITY.md if provided, else write defaults
	identityMdContent := fmt.Sprintf("# IDENTITY.md - Who Am I?\n\n- **Name:** %s\n- **Creature:** AI agent\n- **Vibe:** professional, focused\n- **Emoji:** 🤖\n", cfg.Name)
	if cfg.IdentityMd != "" {
		identityMdContent = cfg.IdentityMd
	}
	if err := os.WriteFile(filepath.Join(workspace, "IDENTITY.md"), []byte(identityMdContent), 0644); err != nil {
		return "", fmt.Errorf("%s", i18n.T(i18n.MsgFileCreateFailed, map[string]interface{}{"File": "IDENTITY.md", "Error": err.Error()}))
	}

	// Create HEARTBEAT.md if provided
	if cfg.Heartbeat != "" {
		if err := os.WriteFile(filepath.Join(workspace, "HEARTBEAT.md"), []byte(cfg.Heartbeat), 0644); err != nil {
			return "", fmt.Errorf("%s", i18n.T(i18n.MsgFileCreateFailed, map[string]interface{}{"File": "HEARTBEAT.md", "Error": err.Error()}))
		}
	}

	// Create TOOLS.md if provided
	if cfg.Tools != "" {
		if err := os.WriteFile(filepath.Join(workspace, "TOOLS.md"), []byte(cfg.Tools), 0644); err != nil {
			return "", fmt.Errorf("%s", i18n.T(i18n.MsgFileCreateFailed, map[string]interface{}{"File": "TOOLS.md", "Error": err.Error()}))
		}
	}

	// Create skills directory if skills are specified
	if len(cfg.Skills) > 0 {
		skillsDir := filepath.Join(workspace, "skills")
		if err := os.MkdirAll(skillsDir, 0755); err != nil {
			return "", fmt.Errorf("%s", i18n.T(i18n.MsgFileDirCreateFailed, map[string]interface{}{"Error": err.Error()}))
		}
		// Note: Actual skill installation would require additional logic
	}

	return workspace, nil
}

func (h *MultiAgentHandler) updateOpenClawConfig(template MultiAgentTemplate, prefix string) error {
	// Get current config
	raw, err := h.client.Request("config.get", map[string]interface{}{})
	if err != nil {
		return err
	}

	var wrapper map[string]interface{}
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return err
	}

	var currentCfg map[string]interface{}
	if parsed, ok := wrapper["parsed"]; ok {
		if m, ok := parsed.(map[string]interface{}); ok {
			currentCfg = m
		}
	}
	if currentCfg == nil {
		currentCfg = make(map[string]interface{})
	}

	// Get OpenClaw home
	homeDir, _ := h.getOpenClawHome()

	// Update agents.list
	agentsCfg, _ := currentCfg["agents"].(map[string]interface{})
	if agentsCfg == nil {
		agentsCfg = make(map[string]interface{})
		currentCfg["agents"] = agentsCfg
	}

	agentsList, _ := agentsCfg["list"].([]interface{})
	if agentsList == nil {
		agentsList = make([]interface{}, 0)
	}

	// Add new agents
	for _, agentCfg := range template.Agents {
		agentID := agentCfg.ID
		if prefix != "" {
			agentID = prefix + "-" + agentID
		}

		newAgent := map[string]interface{}{
			"id":        agentID,
			"workspace": filepath.Join(homeDir, "agents", agentID),
		}

		// Check if already exists
		exists := false
		for _, a := range agentsList {
			if agent, ok := a.(map[string]interface{}); ok {
				if agent["id"] == agentID {
					exists = true
					break
				}
			}
		}

		if !exists {
			agentsList = append(agentsList, newAgent)
		}
	}

	agentsCfg["list"] = agentsList

	// Update bindings if provided
	if len(template.Bindings) > 0 {
		bindings, _ := currentCfg["bindings"].([]interface{})
		if bindings == nil {
			bindings = make([]interface{}, 0)
		}

		for _, binding := range template.Bindings {
			agentID := binding.AgentID
			if prefix != "" {
				agentID = prefix + "-" + agentID
			}

			newBinding := map[string]interface{}{
				"agentId": agentID,
				"match":   binding.Match,
			}
			bindings = append(bindings, newBinding)
		}

		currentCfg["bindings"] = bindings
	}

	// Save config
	cfgJSONBytes, jsonErr := json.Marshal(currentCfg)
	if jsonErr != nil {
		return fmt.Errorf("config serialize: %w", jsonErr)
	}
	_, err = h.client.RequestWithTimeout("config.set", map[string]interface{}{
		"raw": string(cfgJSONBytes),
	}, 15*time.Second)

	if err != nil {
		return err
	}

	// Note: agents.reload is not a valid gateway RPC method.
	// config.set already triggers automatic reload in the gateway.

	return nil
}

func (h *MultiAgentHandler) configureBindings(bindings []BindingConfig, prefix string) []BindingStatus {
	results := make([]BindingStatus, 0, len(bindings))

	for _, binding := range bindings {
		agentID := binding.AgentID
		if prefix != "" {
			agentID = prefix + "-" + agentID
		}

		status := BindingStatus{
			AgentID: agentID,
			Status:  "configured",
		}

		// Bindings are configured via config.set in updateOpenClawConfig
		// This is just for status reporting
		results = append(results, status)
	}

	return results
}

// configureCoordinatorAgent updates the coordinator agent's SOUL.md with subagent information
// This enables the coordinator to know about and use sessions_spawn to call subagents
// Uses intelligent block management to replace existing blocks instead of duplicating
func (h *MultiAgentHandler) configureCoordinatorAgent(coordinatorId string, workflowName string, subagents []AgentDeployStatus) error {
	logger.Log.Info().
		Str("coordinator", coordinatorId).
		Str("workflow", workflowName).
		Int("subagentCount", len(subagents)).
		Msg("Starting coordinator agent configuration")

	// Build subagent list content
	var agentList strings.Builder
	var agentIds []string
	for _, agent := range subagents {
		agentList.WriteString(fmt.Sprintf("- **%s**: %s\n", agent.ID, agent.Name))
		agentIds = append(agentIds, agent.ID)
	}

	// Build the content block
	blockId := strings.ToLower(strings.ReplaceAll(workflowName, " ", "-"))
	blockStart := fmt.Sprintf("<!-- workflow:%s -->", blockId)
	blockEnd := fmt.Sprintf("<!-- /workflow:%s -->", blockId)
	newBlock := fmt.Sprintf(`

%s
## %s - Subagent Orchestration

### Available Subagents

%s
### How to Use

When you receive a task related to this workflow, use the sessions_spawn tool to delegate to the appropriate subagent:

~~~
sessions_spawn(task="your task description", agentId="subagent-id")
~~~

### Tips

- Analyze the task first, then decide which subagent is most suitable
- You can spawn multiple subagents for complex tasks
- Subagents will automatically report back when they complete their work
- Available agent IDs: %s
%s
`, blockStart, workflowName, agentList.String(), strings.Join(agentIds, ", "), blockEnd)

	// First, try to read existing SOUL.md content
	existingContent := ""
	data, err := h.client.RequestWithTimeout("agents.files.get", map[string]interface{}{
		"agentId": coordinatorId,
		"name":    "SOUL.md",
	}, 5*time.Second)
	if err != nil {
		logger.Log.Warn().Err(err).Msg("Failed to read existing SOUL.md, will create new")
	} else if data != nil {
		var fileResp struct {
			File struct {
				Content string `json:"content"`
				Missing bool   `json:"missing"`
			} `json:"file"`
		}
		if json.Unmarshal(data, &fileResp) == nil {
			if fileResp.File.Missing {
				logger.Log.Info().Msg("SOUL.md does not exist, will create new")
			} else {
				existingContent = fileResp.File.Content
				logger.Log.Info().Int("contentLength", len(existingContent)).Msg("Read existing SOUL.md")
			}
		} else {
			logger.Log.Warn().Msg("Failed to parse agents.files.get response")
		}
	}

	// Intelligent block management: replace existing block or append
	var finalContent string
	if strings.Contains(existingContent, blockStart) {
		// Block exists, replace it using regex
		pattern := regexp.MustCompile(`(?s)\n?` + regexp.QuoteMeta(blockStart) + `.*?` + regexp.QuoteMeta(blockEnd) + `\n?`)
		finalContent = pattern.ReplaceAllString(existingContent, newBlock)
		logger.Log.Debug().Str("blockId", blockId).Msg("Replacing existing workflow block")
	} else {
		// Block doesn't exist, append
		finalContent = existingContent + newBlock
		logger.Log.Debug().Str("blockId", blockId).Msg("Appending new workflow block")
	}

	// Write the final content
	logger.Log.Info().
		Int("finalContentLength", len(finalContent)).
		Bool("isReplacement", strings.Contains(existingContent, blockStart)).
		Msg("Writing SOUL.md to coordinator agent")

	_, err = h.client.RequestWithTimeout("agents.files.set", map[string]interface{}{
		"agentId": coordinatorId,
		"name":    "SOUL.md",
		"content": finalContent,
	}, 10*time.Second)

	if err != nil {
		logger.Log.Error().
			Err(err).
			Str("coordinator", coordinatorId).
			Str("rpcMethod", "agents.files.set").
			Msg("Failed to write SOUL.md to coordinator agent")
		return fmt.Errorf("%s", i18n.T(i18n.MsgFileWriteFailed, map[string]interface{}{"File": "SOUL.md", "Error": err.Error()}))
	}

	logger.Log.Info().
		Str("coordinator", coordinatorId).
		Str("workflow", workflowName).
		Int("subagentCount", len(subagents)).
		Msg("Configured coordinator agent with subagent information")

	return nil
}
