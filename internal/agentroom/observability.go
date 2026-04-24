package agentroom

// Prometheus 轻量级 exporter —— 不引入 prometheus/client_golang 依赖，
// 手写 text exposition format。线程安全，适合进程级 agentroom 指标观测。
//
// 暴露端点：GET /api/v1/agentroom/admin/metrics （RequireAdmin）
// 格式：https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format
//
// 指标清单（所有都带 roomId / model / kind / status 等 label 能细分）：
//   - agentroom_llm_calls_total{model,status}       counter
//   - agentroom_llm_tokens_total{model,kind}         counter   (kind=input|output)
//   - agentroom_llm_cost_cny_total{model}            counter   (累计人民币)
//   - agentroom_llm_duration_seconds{model,quantile} summary   (P50/P90/P99)
//   - agentroom_rooms_total                          gauge     (已创建的房间数)
//   - agentroom_rooms_active                         gauge     (state=active)
//   - agentroom_breaker_state{model,state}           gauge     (0/1: open|half-open|closed)
//   - agentroom_messages_total{kind}                 counter
//   - agentroom_user_messages_total                  counter   (人类消息)
//   - agentroom_ratelimit_rejected_total             counter
//
// 设计：采用 sync.Map + atomic 保证高并发下不锁；summary 用蓄水池抽样近似分位。

import (
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─────────────────────── Counter / Gauge ───────────────────────

// counterVec 是带 label 的计数器容器。key = 标签拼接字符串。
type counterVec struct {
	mu     sync.Mutex
	values map[string]*atomic.Uint64
	// labels 用于 exposition 格式化，保留每个 key 的原始 label 键值对
	labels map[string][]labelKV
}

type labelKV struct {
	Key string
	Val string
}

// counterFloatVec 是带 label 的浮点计数器（累计金额用）。单独实现是因为 atomic
// 标准库只支持整型，用 bits 技巧包装 float64。
type counterFloatVec struct {
	mu     sync.Mutex
	values map[string]*atomic.Uint64
	labels map[string][]labelKV
}

type gaugeVec struct {
	mu     sync.Mutex
	values map[string]*atomic.Int64
	labels map[string][]labelKV
}

func newCounterVec() *counterVec {
	return &counterVec{values: map[string]*atomic.Uint64{}, labels: map[string][]labelKV{}}
}
func newCounterFloatVec() *counterFloatVec {
	return &counterFloatVec{values: map[string]*atomic.Uint64{}, labels: map[string][]labelKV{}}
}
func newGaugeVec() *gaugeVec {
	return &gaugeVec{values: map[string]*atomic.Int64{}, labels: map[string][]labelKV{}}
}

func (c *counterVec) Inc(labels ...labelKV) {
	c.Add(1, labels...)
}
func (c *counterVec) Add(delta uint64, labels ...labelKV) {
	key := labelKey(labels)
	c.mu.Lock()
	v, ok := c.values[key]
	if !ok {
		v = &atomic.Uint64{}
		c.values[key] = v
		c.labels[key] = labels
	}
	c.mu.Unlock()
	v.Add(delta)
}

func (c *counterFloatVec) AddFloat(delta float64, labels ...labelKV) {
	if delta <= 0 || math.IsNaN(delta) || math.IsInf(delta, 0) {
		return
	}
	key := labelKey(labels)
	c.mu.Lock()
	v, ok := c.values[key]
	if !ok {
		v = &atomic.Uint64{}
		c.values[key] = v
		c.labels[key] = labels
	}
	c.mu.Unlock()
	// float64 → bits CAS loop
	for {
		old := v.Load()
		sum := math.Float64frombits(old) + delta
		if v.CompareAndSwap(old, math.Float64bits(sum)) {
			return
		}
	}
}

func (g *gaugeVec) Set(val int64, labels ...labelKV) {
	key := labelKey(labels)
	g.mu.Lock()
	v, ok := g.values[key]
	if !ok {
		v = &atomic.Int64{}
		g.values[key] = v
		g.labels[key] = labels
	}
	g.mu.Unlock()
	v.Store(val)
}

func labelKey(labels []labelKV) string {
	if len(labels) == 0 {
		return ""
	}
	parts := make([]string, len(labels))
	for i, l := range labels {
		parts[i] = l.Key + "=" + l.Val
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// ─────────────────────── Histogram (简化分位) ───────────────────────

// sampleRing 固定窗口蓄水池，计算 p50/p90/p99 近似值。
// LLM 调用频率较低（≤ N/分钟），1024 槽足够窗口内覆盖。
type sampleRing struct {
	mu      sync.Mutex
	samples [1024]float64
	count   uint64 // 已写入总数
	// 按 label 分桶
	byLabels map[string]*samplePartition
	labels   map[string][]labelKV
}

type samplePartition struct {
	mu      sync.Mutex
	samples [1024]float64
	count   uint64
}

func newSampleRing() *sampleRing {
	return &sampleRing{
		byLabels: map[string]*samplePartition{},
		labels:   map[string][]labelKV{},
	}
}

func (s *sampleRing) Observe(v float64, labels ...labelKV) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return
	}
	key := labelKey(labels)
	s.mu.Lock()
	p, ok := s.byLabels[key]
	if !ok {
		p = &samplePartition{}
		s.byLabels[key] = p
		s.labels[key] = labels
	}
	s.mu.Unlock()
	p.mu.Lock()
	idx := p.count % uint64(len(p.samples))
	p.samples[idx] = v
	p.count++
	p.mu.Unlock()
}

// quantile 取指定分位。q ∈ [0, 1]。
func (p *samplePartition) quantile(q float64) float64 {
	p.mu.Lock()
	n := int(p.count)
	if n > len(p.samples) {
		n = len(p.samples)
	}
	if n == 0 {
		p.mu.Unlock()
		return 0
	}
	cp := make([]float64, n)
	copy(cp, p.samples[:n])
	p.mu.Unlock()
	sort.Float64s(cp)
	idx := int(q * float64(n-1))
	if idx < 0 {
		idx = 0
	}
	if idx >= n {
		idx = n - 1
	}
	return cp[idx]
}

// ─────────────────────── Registry 单例 ───────────────────────

// metricsRegistry 进程单例。orchestrator/handler 通过导出函数间接操作，避免直接暴露内部结构。
type metricsRegistry struct {
	LLMCalls         *counterVec      // {model, status=ok|error|breaker_skip}
	LLMTokens        *counterVec      // {model, kind=input|output}
	LLMCostCNY       *counterFloatVec // {model}
	LLMDuration      *sampleRing      // {model}
	RoomsTotal       *gaugeVec        // no labels
	RoomsActive      *gaugeVec
	BreakerOpen      *gaugeVec // {model}
	MessagesTotal    *counterVec // {kind}
	UserMessages     *counterVec // no labels
	RateLimitReject  *counterVec // no labels
	StartedAt        time.Time
}

var metrics = &metricsRegistry{
	LLMCalls:        newCounterVec(),
	LLMTokens:       newCounterVec(),
	LLMCostCNY:      newCounterFloatVec(),
	LLMDuration:     newSampleRing(),
	RoomsTotal:      newGaugeVec(),
	RoomsActive:     newGaugeVec(),
	BreakerOpen:     newGaugeVec(),
	MessagesTotal:   newCounterVec(),
	UserMessages:    newCounterVec(),
	RateLimitReject: newCounterVec(),
	StartedAt:       time.Now(),
}

// ─────────────────────── 导出函数（orchestrator/handler 调用） ───────────────────────

// MetricLLMCall 记录一次 LLM 调用：model、状态（ok|error|breaker_skip）、耗时。
func MetricLLMCall(model, status string, duration time.Duration) {
	metrics.LLMCalls.Inc(labelKV{"model", model}, labelKV{"status", status})
	if status == "ok" {
		metrics.LLMDuration.Observe(duration.Seconds(), labelKV{"model", model})
	}
}

// MetricLLMTokens 累加 token 消耗。kind = "input" | "output"。
func MetricLLMTokens(model, kind string, n int) {
	if n <= 0 {
		return
	}
	metrics.LLMTokens.Add(uint64(n), labelKV{"model", model}, labelKV{"kind", kind})
}

// MetricLLMCost 累加本次 LLM 调用的人民币成本。
func MetricLLMCost(model string, cny float64) {
	metrics.LLMCostCNY.AddFloat(cny, labelKV{"model", model})
}

// MetricBreakerState 0 = closed/half-open, 1 = open。
func MetricBreakerState(model string, open bool) {
	var v int64
	if open {
		v = 1
	}
	metrics.BreakerOpen.Set(v, labelKV{"model", model})
}

// MetricMessageAppend 任意消息写入时调用。kind = chat/whisper/tool/...
func MetricMessageAppend(kind string) {
	metrics.MessagesTotal.Inc(labelKV{"kind", kind})
}

// MetricUserMessage 人类消息专用计数（排除 orchestrator 自写的 agent 消息）。
func MetricUserMessage() {
	metrics.UserMessages.Inc()
}

// MetricRateLimitReject 速率限制拒绝一次调用。
func MetricRateLimitReject() {
	metrics.RateLimitReject.Inc()
}

// MetricRoomCounts 外部（Manager 周期或 handler 调用）更新房间总数与活跃数。
func MetricRoomCounts(total, active int) {
	metrics.RoomsTotal.Set(int64(total))
	metrics.RoomsActive.Set(int64(active))
}

// ─────────────────────── Text exposition ───────────────────────

// WriteMetrics 把全部指标以 Prometheus text format 写入 w。
// 调用方应先设置 Content-Type: text/plain; version=0.0.4
func WriteMetrics(w io.Writer) {
	writeCounter(w, "agentroom_llm_calls_total", "Total LLM API calls grouped by model and result", metrics.LLMCalls)
	writeCounter(w, "agentroom_llm_tokens_total", "Total LLM tokens consumed (input/output)", metrics.LLMTokens)
	writeCounterFloat(w, "agentroom_llm_cost_cny_total", "Accumulated LLM cost in CNY", metrics.LLMCostCNY)
	writeSummary(w, "agentroom_llm_duration_seconds", "LLM call duration in seconds", metrics.LLMDuration)
	writeGauge(w, "agentroom_rooms_total", "Total number of rooms created", metrics.RoomsTotal)
	writeGauge(w, "agentroom_rooms_active", "Number of rooms in active state", metrics.RoomsActive)
	writeGauge(w, "agentroom_breaker_open", "Model breaker state (1=open, 0=closed)", metrics.BreakerOpen)
	writeCounter(w, "agentroom_messages_total", "Total messages appended grouped by kind", metrics.MessagesTotal)
	writeCounter(w, "agentroom_user_messages_total", "Total human-authored messages", metrics.UserMessages)
	writeCounter(w, "agentroom_ratelimit_rejected_total", "Total messages rejected by the per-room rate limiter", metrics.RateLimitReject)
	// Process-level uptime
	uptime := time.Since(metrics.StartedAt).Seconds()
	fmt.Fprintf(w, "# HELP agentroom_uptime_seconds Uptime of the agentroom subsystem in seconds\n")
	fmt.Fprintf(w, "# TYPE agentroom_uptime_seconds gauge\n")
	fmt.Fprintf(w, "agentroom_uptime_seconds %v\n", uptime)
}

func writeHeader(w io.Writer, name, help, mtype string) {
	fmt.Fprintf(w, "# HELP %s %s\n", name, help)
	fmt.Fprintf(w, "# TYPE %s %s\n", name, mtype)
}

func writeCounter(w io.Writer, name, help string, c *counterVec) {
	writeHeader(w, name, help, "counter")
	c.mu.Lock()
	keys := make([]string, 0, len(c.values))
	for k := range c.values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "%s%s %d\n", name, formatLabels(c.labels[k]), c.values[k].Load())
	}
	c.mu.Unlock()
	if len(c.values) == 0 {
		fmt.Fprintf(w, "%s 0\n", name)
	}
}

func writeCounterFloat(w io.Writer, name, help string, c *counterFloatVec) {
	writeHeader(w, name, help, "counter")
	c.mu.Lock()
	keys := make([]string, 0, len(c.values))
	for k := range c.values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		bits := c.values[k].Load()
		fmt.Fprintf(w, "%s%s %g\n", name, formatLabels(c.labels[k]), math.Float64frombits(bits))
	}
	c.mu.Unlock()
	if len(c.values) == 0 {
		fmt.Fprintf(w, "%s 0\n", name)
	}
}

func writeGauge(w io.Writer, name, help string, g *gaugeVec) {
	writeHeader(w, name, help, "gauge")
	g.mu.Lock()
	keys := make([]string, 0, len(g.values))
	for k := range g.values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "%s%s %d\n", name, formatLabels(g.labels[k]), g.values[k].Load())
	}
	g.mu.Unlock()
	if len(g.values) == 0 {
		fmt.Fprintf(w, "%s 0\n", name)
	}
}

func writeSummary(w io.Writer, name, help string, s *sampleRing) {
	writeHeader(w, name, help, "summary")
	s.mu.Lock()
	keys := make([]string, 0, len(s.byLabels))
	for k := range s.byLabels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	s.mu.Unlock()
	if len(keys) == 0 {
		fmt.Fprintf(w, "%s{quantile=\"0.5\"} 0\n", name)
		fmt.Fprintf(w, "%s{quantile=\"0.9\"} 0\n", name)
		fmt.Fprintf(w, "%s{quantile=\"0.99\"} 0\n", name)
		return
	}
	for _, k := range keys {
		s.mu.Lock()
		p := s.byLabels[k]
		base := s.labels[k]
		s.mu.Unlock()
		for _, q := range []float64{0.5, 0.9, 0.99} {
			labels := append([]labelKV{}, base...)
			labels = append(labels, labelKV{"quantile", fmt.Sprintf("%g", q)})
			fmt.Fprintf(w, "%s%s %g\n", name, formatLabels(labels), p.quantile(q))
		}
	}
}

// formatLabels 把 labels 渲染成 `{k="v",k2="v2"}`；空 → 空串。
// label value 里的 " 和 \ 按 Prometheus 规范转义。
func formatLabels(labels []labelKV) string {
	if len(labels) == 0 {
		return ""
	}
	// 保证输出有序
	cp := append([]labelKV{}, labels...)
	sort.Slice(cp, func(i, j int) bool { return cp[i].Key < cp[j].Key })
	var b strings.Builder
	b.WriteByte('{')
	for i, l := range cp {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(l.Key)
		b.WriteString(`="`)
		b.WriteString(escapeLabelValue(l.Val))
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}

func escapeLabelValue(s string) string {
	if !strings.ContainsAny(s, `\"`+"\n") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 4)
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
