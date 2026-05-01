package digest

import (
	"fmt"
	"strings"
)

type textMap map[string]string

var digestText = map[string]textMap{
	"en": {
		"subject": "ClawDeckX · %s",
		"empty":   "No valuable data for this period.",
		"health":  "Gateway Health", "alerts": "Alerts", "events": "Lifecycle Events", "sessions": "Sessions Usage", "tools": "Tool Calls", "audit": "Operations", "dream": "Dream", "snapshots": "Backups", "update": "Updates", "pending": "Action Items",
		"health_ok": "✓ Gateway healthy, no incidents.", "crashes": "• Crashes: %d", "unreachable": "• Unreachable: %d", "restart": "• Auto-restart triggered: %d", "recovered": "• Recovered: %d",
		"alerts_total": "• Total: %d  (%s)", "sessions_count": "• Sessions: %d", "messages": "• Messages: %d", "tokens": "• Tokens: %s", "cost": "• Estimated cost: $%.2f", "top_models": "• Top models: %s",
		"calls": "• Calls: %d  (errors: %d)", "top_tools": "• Top tools: %s", "ops_total": "• Total operations: %d", "backups": "• Backups created: %d  (auto: %d)", "new_version": "• New version available: %s", "unread_alerts": "• Unread alerts: %d",
		"event_crashed": "crashed", "event_unreachable": "unreachable", "event_heartbeat_restart": "auto-restarted", "event_recovered": "recovered", "event_started": "started", "event_stopped": "stopped",
	},
	"zh": {
		"subject": "ClawDeckX · %s 每日汇报",
		"empty":   "该时段暂无有价值数据。",
		"health":  "网关健康", "alerts": "告警概览", "events": "生命周期事件", "sessions": "会话用量", "tools": "工具调用", "audit": "操作日志", "dream": "梦境", "snapshots": "配置备份", "update": "版本更新", "pending": "待处理事项",
		"health_ok": "✓ 网关运行正常，无异常事件。", "crashes": "• 崩溃次数：%d", "unreachable": "• 不可达次数：%d", "restart": "• 自动重启触发：%d", "recovered": "• 恢复次数：%d",
		"alerts_total": "• 总数：%d（%s）", "sessions_count": "• 会话数：%d", "messages": "• 消息数：%d", "tokens": "• Token：%s", "cost": "• 预估成本：$%.2f", "top_models": "• Top 模型：%s",
		"calls": "• 调用数：%d（错误：%d）", "top_tools": "• Top 工具：%s", "ops_total": "• 操作总数：%d", "backups": "• 新增备份：%d（自动：%d）", "new_version": "• 有新版本可用：%s", "unread_alerts": "• 未读告警：%d",
		"event_crashed": "崩溃", "event_unreachable": "不可达", "event_heartbeat_restart": "自动重启", "event_recovered": "已恢复", "event_started": "已启动", "event_stopped": "已停止",
	},
	"zh-TW": {
		"subject": "ClawDeckX · %s 每日匯報",
		"empty":   "該時段暫無有價值資料。",
		"health":  "閘道健康", "alerts": "告警概覽", "events": "生命週期事件", "sessions": "工作階段用量", "tools": "工具呼叫", "audit": "操作紀錄", "dream": "夢境", "snapshots": "設定備份", "update": "版本更新", "pending": "待處理事項",
		"health_ok": "✓ 閘道運作正常，無異常事件。", "crashes": "• 崩潰次數：%d", "unreachable": "• 無法連線次數：%d", "restart": "• 自動重啟觸發：%d", "recovered": "• 恢復次數：%d",
		"alerts_total": "• 總數：%d（%s）", "sessions_count": "• 工作階段數：%d", "messages": "• 訊息數：%d", "tokens": "• Token：%s", "cost": "• 預估成本：$%.2f", "top_models": "• Top 模型：%s",
		"calls": "• 呼叫數：%d（錯誤：%d）", "top_tools": "• Top 工具：%s", "ops_total": "• 操作總數：%d", "backups": "• 新增備份：%d（自動：%d）", "new_version": "• 有新版本可用：%s", "unread_alerts": "• 未讀告警：%d",
		"event_crashed": "崩潰", "event_unreachable": "無法連線", "event_heartbeat_restart": "自動重啟", "event_recovered": "已恢復", "event_started": "已啟動", "event_stopped": "已停止",
	},
	"ja": {
		"subject": "ClawDeckX · %s 毎日ダイジェスト",
		"empty":   "この期間に表示する有用なデータはありません。",
		"health":  "ゲートウェイ健全性", "alerts": "アラート", "events": "ライフサイクルイベント", "sessions": "セッション利用", "tools": "ツール呼び出し", "audit": "操作ログ", "dream": "ドリーム", "snapshots": "バックアップ", "update": "アップデート", "pending": "未対応の項目",
		"health_ok": "✓ ゲートウェイは正常です。インシデントはありません。", "crashes": "• クラッシュ：%d", "unreachable": "• 到達不能：%d", "restart": "• 自動再起動：%d", "recovered": "• 復旧：%d",
		"alerts_total": "• 合計：%d（%s）", "sessions_count": "• セッション：%d", "messages": "• メッセージ：%d", "tokens": "• トークン：%s", "cost": "• 推定コスト：$%.2f", "top_models": "• 上位モデル：%s",
		"calls": "• 呼び出し：%d（エラー：%d）", "top_tools": "• 上位ツール：%s", "ops_total": "• 操作合計：%d", "backups": "• 作成バックアップ：%d（自動：%d）", "new_version": "• 新しいバージョンがあります：%s", "unread_alerts": "• 未読アラート：%d",
		"event_crashed": "クラッシュ", "event_unreachable": "到達不能", "event_heartbeat_restart": "自動再起動", "event_recovered": "復旧", "event_started": "開始", "event_stopped": "停止",
	},
	"ko": {
		"subject": "ClawDeckX · %s 데일리 다이제스트",
		"empty":   "이 기간에 표시할 유의미한 데이터가 없습니다.",
		"health":  "게이트웨이 상태", "alerts": "경보", "events": "라이프사이클 이벤트", "sessions": "세션 사용량", "tools": "도구 호출", "audit": "운영 로그", "dream": "드림", "snapshots": "백업", "update": "업데이트", "pending": "처리 대기",
		"health_ok": "✓ 게이트웨이가 정상입니다. 이상 이벤트가 없습니다.", "crashes": "• 충돌: %d", "unreachable": "• 연결 불가: %d", "restart": "• 자동 재시작: %d", "recovered": "• 복구: %d",
		"alerts_total": "• 총계: %d (%s)", "sessions_count": "• 세션: %d", "messages": "• 메시지: %d", "tokens": "• 토큰: %s", "cost": "• 예상 비용: $%.2f", "top_models": "• 상위 모델: %s",
		"calls": "• 호출: %d (오류: %d)", "top_tools": "• 상위 도구: %s", "ops_total": "• 총 작업: %d", "backups": "• 생성된 백업: %d (자동: %d)", "new_version": "• 새 버전 사용 가능: %s", "unread_alerts": "• 읽지 않은 경보: %d",
		"event_crashed": "충돌", "event_unreachable": "연결 불가", "event_heartbeat_restart": "자동 재시작", "event_recovered": "복구됨", "event_started": "시작됨", "event_stopped": "중지됨",
	},
}

func normalizeLang(lang string) string {
	lang = strings.TrimSpace(lang)
	lower := strings.ToLower(lang)
	if lower == "zh-cn" || lower == "zh" {
		return "zh"
	}
	if lower == "zh-tw" || lower == "zh_hant" || lower == "zh-hant" {
		return "zh-TW"
	}
	if lower == "ja" || strings.HasPrefix(lower, "ja-") {
		return "ja"
	}
	if lower == "ko" || strings.HasPrefix(lower, "ko-") {
		return "ko"
	}
	if lower == "en" || strings.HasPrefix(lower, "en-") {
		return "en"
	}
	if _, ok := digestText[lang]; ok {
		return lang
	}
	return "en"
}

func tr(lang, key string, args ...interface{}) string {
	lang = normalizeLang(lang)
	text := digestText[lang][key]
	if text == "" {
		text = digestText["en"][key]
	}
	if len(args) == 0 {
		return text
	}
	return fmt.Sprintf(text, args...)
}

func SectionTitle(lang string, id SectionID) string {
	return tr(lang, string(id))
}
