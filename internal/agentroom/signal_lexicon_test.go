package agentroom

import "testing"

func TestSignalMatch_ZH(t *testing.T) {
	cases := []struct {
		cat  SignalCategory
		text string
		want bool
	}{
		{SigChallenging, "我不同意这个方案", true},
		{SigChallenging, "完全赞同", false},
		{SigSupportive, "我同意你的看法", true},
		{SigSupportive, "这不对", false},
		{SigProposal, "我建议我们定下来", true},
		{SigCreativity, "如果换个角度看呢", true},
		{SigConcrete, "数据显示转化率上升了", true},
		{SigAssumption, "我觉得应该会成功", true},
		{SigVerification, "根据实测数据显示", true},
		{SigProblemDef, "核心问题在于", true},
		{SigAlternative, "方案二也可以", true},
		{SigRisk, "最大的风险在于", true},
		{SigEscalation, "你根本不懂", true},
		{SigAgreement, "我也这么想", true},
		{SigConcession, "你说得有道理", true},
	}
	for _, c := range cases {
		got := SignalMatch(c.cat, c.text)
		if got != c.want {
			t.Errorf("SignalMatch(%s, %q) = %v, want %v", c.cat, c.text, got, c.want)
		}
	}
}

func TestSignalMatch_EN(t *testing.T) {
	cases := []struct {
		cat  SignalCategory
		text string
		want bool
	}{
		{SigChallenging, "i disagree with this approach", true},
		{SigSupportive, "i agree with your point", true},
		{SigProposal, "i propose we finalize this", true},
		{SigCreativity, "what if we flip it around", true},
		{SigConcrete, "for example in practice", true},
		{SigAssumption, "this should be fine probably", true},
		{SigVerification, "data shows a clear trend", true},
		{SigProblemDef, "the root cause is clear", true},
		{SigAlternative, "alternatively we could", true},
		{SigRisk, "the worst case scenario", true},
		{SigEscalation, "that's wrong and you know it", true},
		{SigAgreement, "makes sense to me", true},
		{SigConcession, "fair point on that one", true},
	}
	for _, c := range cases {
		got := SignalMatch(c.cat, c.text)
		if got != c.want {
			t.Errorf("SignalMatch(%s, %q) = %v, want %v", c.cat, c.text, got, c.want)
		}
	}
}

func TestSignalMatchExclude(t *testing.T) {
	// 有支持信号但无挑战信号 → true
	if !SignalMatchExclude(SigSupportive, SigChallenging, "我同意你的方案") {
		t.Error("pure supportive should match")
	}
	// 既有支持又有挑战 → false
	if SignalMatchExclude(SigSupportive, SigChallenging, "我同意，但是有问题是这样的") {
		t.Error("mixed should not match exclude")
	}
}

func TestSignalCount(t *testing.T) {
	text := "我觉得大概率可以，估计应该会成功"
	count := SignalCount(SigAssumption, text)
	if count < 2 {
		t.Errorf("expected >=2 assumption signals, got %d", count)
	}
}

func TestIsStopWord(t *testing.T) {
	if !IsStopWord("the") {
		t.Error("'the' should be a stop word")
	}
	if !IsStopWord("的") {
		t.Error("'的' should be a stop word")
	}
	if IsStopWord("algorithm") {
		t.Error("'algorithm' should not be a stop word")
	}
}

func TestSignalMatch_UnknownCategory(t *testing.T) {
	// 未注册的 category 应返回 false，不 panic
	if SignalMatch("nonexistent", "anything") {
		t.Error("unknown category should return false")
	}
}
