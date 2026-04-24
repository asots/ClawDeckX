package agentroom

import (
	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"
	"strings"
)

// EnsureFTS 建立 agentroom_messages 的 FTS5 虚表 + 同步触发器。
// 启动时调用一次；幂等（IF NOT EXISTS）。SQLite 必须编译带 FTS5，这也是 modernc.org/sqlite 默认能力。
//
// 设计：
//   - external-content 模式（content='agentroom_messages'），FTS 只存 rowid 引用不复制正文
//   - 仅索引 kind in ('chat','whisper','projection_in') 的消息；跳过 bidding/tool
//   - 触发器覆盖 insert/update/delete，保持索引与源表一致
//   - 首次启动时把现有消息回填进 FTS 表
func EnsureFTS() error {
	// 1) 虚表（external-content）
	stmts := []string{
		`CREATE VIRTUAL TABLE IF NOT EXISTS agentroom_messages_fts USING fts5(
			content,
			content='agentroom_messages',
			content_rowid='rowid',
			tokenize='unicode61 remove_diacritics 2'
		)`,
		`CREATE TRIGGER IF NOT EXISTS agentroom_msg_ai AFTER INSERT ON agentroom_messages
			WHEN NEW.kind IN ('chat','whisper','projection_in') AND NEW.deleted = 0
			BEGIN
				INSERT INTO agentroom_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
			END`,
		`CREATE TRIGGER IF NOT EXISTS agentroom_msg_ad AFTER DELETE ON agentroom_messages
			BEGIN
				INSERT INTO agentroom_messages_fts(agentroom_messages_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
			END`,
		`CREATE TRIGGER IF NOT EXISTS agentroom_msg_au AFTER UPDATE ON agentroom_messages
			BEGIN
				INSERT INTO agentroom_messages_fts(agentroom_messages_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
				INSERT INTO agentroom_messages_fts(rowid, content)
					SELECT NEW.rowid, NEW.content WHERE NEW.kind IN ('chat','whisper','projection_in') AND NEW.deleted = 0;
			END`,
	}
	for _, s := range stmts {
		if err := database.DB.Exec(s).Error; err != nil {
			return err
		}
	}
	// 2) 回填：若 FTS 表为空但源表非空，填充一次（幂等：仅当差异行数 > 0 时才填）
	var fromSrc int64
	var fromFTS int64
	database.DB.Raw(`SELECT COUNT(1) FROM agentroom_messages WHERE kind IN ('chat','whisper','projection_in') AND deleted = 0`).Scan(&fromSrc)
	database.DB.Raw(`SELECT COUNT(1) FROM agentroom_messages_fts`).Scan(&fromFTS)
	if fromSrc > 0 && fromFTS == 0 {
		if err := database.DB.Exec(`
			INSERT INTO agentroom_messages_fts(rowid, content)
			SELECT rowid, content FROM agentroom_messages
			WHERE kind IN ('chat','whisper','projection_in') AND deleted = 0
		`).Error; err != nil {
			return err
		}
		logger.Log.Info().Int64("rows", fromSrc).Msg("agentroom: FTS5 backfill complete")
	}
	// 3) 自愈：启动时做一次 FTS5 完整性检查；若索引损坏（SQLITE_CORRUPT_VTAB，常见 code 267）
	//    自动 rebuild，避免后续任何 DELETE/UPDATE 命中坏索引而返回 "database disk image is malformed"。
	//    rebuild 是可重复操作；失败不致命，仅记日志 —— 搜索功能不可用，但房间删除等正常写入不会再挂。
	healFTSIfCorrupt()
	return nil
}

// healFTSIfCorrupt 运行 `INSERT INTO ft(ft) VALUES('integrity-check')`；
// SQLite FTS5 的 integrity-check 在有损坏时返回错误。升级后的策略：
//  1. integrity OK → return
//  2. 损坏 → 先尝试软 `rebuild`（不丢 FTS 结构，SQLite 内部重算）
//  3. rebuild 失败 → 调 HardResetMessagesFTS 做 drop+recreate+backfill
//
// 这样即使 shadow 表彻底坏掉，后续 DELETE/UPDATE 也不会再触发 267 错误。
func healFTSIfCorrupt() {
	err := database.DB.Exec(
		`INSERT INTO agentroom_messages_fts(agentroom_messages_fts) VALUES('integrity-check')`,
	).Error
	if err == nil {
		return
	}
	if !IsFTSCorruptError(err) {
		logger.Log.Warn().Err(err).Msg("agentroom: FTS5 integrity check unexpected error, skipping self-heal")
		return
	}
	logger.Log.Warn().Err(err).Msg("agentroom: FTS5 index corrupt, trying soft rebuild…")
	if rebuildErr := database.DB.Exec(
		`INSERT INTO agentroom_messages_fts(agentroom_messages_fts) VALUES('rebuild')`,
	).Error; rebuildErr == nil {
		logger.Log.Info().Msg("agentroom: FTS5 index rebuilt (soft)")
		return
	} else {
		logger.Log.Warn().Err(rebuildErr).Msg("agentroom: soft rebuild failed, falling back to hard reset")
	}
	if hardErr := HardResetMessagesFTS(); hardErr != nil {
		logger.Log.Error().Err(hardErr).Msg("agentroom: FTS5 hard reset failed; search unavailable, but writes should work")
		return
	}
	logger.Log.Info().Msg("agentroom: FTS5 hard reset complete")
}

// IsFTSCorruptError 判定一个 error 是否属于 FTS5 损坏类。
// 被 healFTSIfCorrupt 和 DeleteRoom 重试路径共用 —— 保持判断逻辑统一。
//
// SQLite 返回的错误文本通常含：
//   - "database disk image is malformed"
//   - "SQL logic error: database disk image is malformed (267)"
//   - "SQLITE_CORRUPT_VTAB"
//   - "corrupt" （兜底）
func IsFTSCorruptError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "malformed") ||
		strings.Contains(msg, "corrupt") ||
		strings.Contains(msg, "267") ||
		strings.Contains(msg, "sqlite_corrupt")
}

func DropMessagesFTSTriggers() error {
	stmts := []string{
		`DROP TRIGGER IF EXISTS agentroom_msg_ai`,
		`DROP TRIGGER IF EXISTS agentroom_msg_ad`,
		`DROP TRIGGER IF EXISTS agentroom_msg_au`,
	}
	for _, s := range stmts {
		if err := database.DB.Exec(s).Error; err != nil {
			return err
		}
	}
	return nil
}

// HardResetMessagesFTS —— 比 rebuild 更彻底的恢复手段：
//  1. DROP 所有 FTS5 shadow 表（_data / _idx / _docsize / _config / _content）
//  2. DROP 触发器
//  3. 重新执行 EnsureFTS 的建表 + 触发器 + backfill
//
// 使用场景：
//   - 启动自愈 rebuild 失败时
//   - DeleteRoom 运行时命中 267 → 重置后重试
//   - 管理员手动触发（/admin/fts/rebuild）
//
// 注意：重置期间 FTS 表为空；backfill 完成前搜索无结果。backfill 是幂等的。
// 不使用事务包裹：DROP VIRTUAL TABLE 在某些 SQLite 版本下不能在 tx 内执行。
func HardResetMessagesFTS() error {
	stmts := []string{
		`DROP TABLE IF EXISTS agentroom_messages_fts`,
	}
	if err := DropMessagesFTSTriggers(); err != nil {
		logger.Log.Warn().Err(err).Msg("agentroom: FTS5 hard reset trigger drop step warn")
	}
	for _, s := range stmts {
		if err := database.DB.Exec(s).Error; err != nil {
			// drop 失败不致命；继续往下 —— EnsureFTS 用 IF NOT EXISTS
			logger.Log.Warn().Err(err).Str("stmt", s).Msg("agentroom: FTS5 hard reset drop step warn")
		}
	}
	// 重建 + backfill
	return EnsureFTS()
}

// SearchMessages 在指定房间内 FTS5 搜索。query 支持 FTS5 语法（AND / OR / NEAR / ""）。
// 简单查询（纯关键字）会被自动包成短语，避免 "syntax error" 误伤普通用户。
// 返回按 rank 相关度排序 + timestamp DESC 兜底。
func (r *Repo) SearchMessages(roomID, query string, limit int) ([]database.AgentRoomMessage, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	// 为新手用户：如果 query 不含 FTS5 特殊符号，包成短语避免 "tokenize" 失败。
	safeQuery := wrapFTSQuery(query)
	var ms []database.AgentRoomMessage
	err := database.DB.Raw(`
		SELECT m.*
		FROM agentroom_messages m
		JOIN agentroom_messages_fts fts ON fts.rowid = m.rowid
		WHERE m.room_id = ?
		  AND m.deleted = 0
		  AND agentroom_messages_fts MATCH ?
		ORDER BY bm25(agentroom_messages_fts) ASC, m.timestamp DESC
		LIMIT ?`, roomID, safeQuery, limit).Scan(&ms).Error
	return ms, err
}

// wrapFTSQuery 保守地包装用户输入：含 FTS5 操作符的保留原样，否则作为短语查询。
// 纯关键字 "hello world" → `"hello world"`；已经带 AND/OR/NEAR/""/col: 的按原样传入。
func wrapFTSQuery(q string) string {
	// 1) 符号类 FTS5 语法：双引号（短语）、冒号（列过滤）、星号（前缀）
	for _, ch := range q {
		if ch == '"' || ch == ':' || ch == '*' {
			return q
		}
	}
	// 2) 词级 FTS5 操作符：AND / OR / NOT / NEAR（大写敏感，FTS5 原样识别）
	//    用 " AND "/" OR " 等含空格的 token 判定，避免把单词里的 "or" 误伤。
	for _, op := range []string{" AND ", " OR ", " NOT ", " NEAR", "NEAR("} {
		if containsASCII(q, op) {
			return q
		}
	}
	// 3) 其它：作为完整短语查询，双引号 escape
	escaped := make([]byte, 0, len(q)+2)
	escaped = append(escaped, '"')
	for _, ch := range q {
		if ch == '"' {
			escaped = append(escaped, '"', '"')
		} else {
			escaped = append(escaped, []byte(string(ch))...)
		}
	}
	escaped = append(escaped, '"')
	return string(escaped)
}

// containsASCII 是 strings.Contains 的本地替代，避免 fts.go 只为这一处引入 strings。
func containsASCII(s, sub string) bool {
	if len(sub) == 0 {
		return true
	}
	if len(sub) > len(s) {
		return false
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
