package agentroom

// RAG 一期：
//   - 文档粒度：AgentRoomDoc（元数据）+ AgentRoomDocChunk（切片，FTS5 索引对象）
//   - 支持上传的 MIME：text/markdown、text/plain；最大 1 MB、最多 200 chunks / 文档。
//   - 切分器：按 markdown heading (H1~H3) 切段；段落内若 > 800 字再按段落/硬换行细分。
//   - 检索：`SearchDocChunks` 复用 FTS5，返回 top-k chunks 带 rank + doc title。
//   - 注入：`Orchestrator.buildContextPrompt` 基于 trigger 消息关键词检索，把 top-3 chunk 放进
//     system prompt 的【背景资料】段落，明确标注来源避免 prompt injection。
//
// 本文件只负责：切分器 + FTS 虚表 + 检索 API。上传 / 列表 / 删除 endpoint 在 handler 里。

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"ClawDeckX/internal/database"
	"ClawDeckX/internal/logger"

	"gorm.io/gorm"
)

const (
	// MaxDocBytes 单个文档上传的最大字节数（1 MB）。
	MaxDocBytes int64 = 1024 * 1024
	// MaxChunksPerDoc 单个文档最多切出的 chunk 数。
	MaxChunksPerDoc = 200
	// DocChunkSoftSize chunk 目标字节数（软上限，按段落/句号就近切）。
	DocChunkSoftSize = 800
)

// ErrDocTooLarge 单个文件超过 MaxDocBytes。
var ErrDocTooLarge = errors.New("document exceeds size limit")

// ErrUnsupportedMime 文档 MIME 不在允许列表。
var ErrUnsupportedMime = errors.New("unsupported document type (md/txt only)")

// EnsureDocFTS 为 agentroom_doc_chunks 建立 FTS5 虚表 + 触发器。
// 与 EnsureFTS（消息全文检索）独立，避免搜索跨空间污染。
func EnsureDocFTS() error {
	stmts := []string{
		`CREATE VIRTUAL TABLE IF NOT EXISTS agentroom_doc_chunks_fts USING fts5(
			content,
			heading,
			content='agentroom_doc_chunks',
			content_rowid='rowid',
			tokenize='unicode61 remove_diacritics 2'
		)`,
		`CREATE TRIGGER IF NOT EXISTS agentroom_doc_ai AFTER INSERT ON agentroom_doc_chunks
			BEGIN
				INSERT INTO agentroom_doc_chunks_fts(rowid, content, heading) VALUES (NEW.rowid, NEW.content, NEW.heading);
			END`,
		`CREATE TRIGGER IF NOT EXISTS agentroom_doc_ad AFTER DELETE ON agentroom_doc_chunks
			BEGIN
				INSERT INTO agentroom_doc_chunks_fts(agentroom_doc_chunks_fts, rowid, content, heading) VALUES('delete', OLD.rowid, OLD.content, OLD.heading);
			END`,
		`CREATE TRIGGER IF NOT EXISTS agentroom_doc_au AFTER UPDATE ON agentroom_doc_chunks
			BEGIN
				INSERT INTO agentroom_doc_chunks_fts(agentroom_doc_chunks_fts, rowid, content, heading) VALUES('delete', OLD.rowid, OLD.content, OLD.heading);
				INSERT INTO agentroom_doc_chunks_fts(rowid, content, heading) VALUES (NEW.rowid, NEW.content, NEW.heading);
			END`,
	}
	for _, s := range stmts {
		if err := database.DB.Exec(s).Error; err != nil {
			return err
		}
	}
	// backfill
	var srcCount, ftsCount int64
	database.DB.Raw(`SELECT COUNT(1) FROM agentroom_doc_chunks`).Scan(&srcCount)
	database.DB.Raw(`SELECT COUNT(1) FROM agentroom_doc_chunks_fts`).Scan(&ftsCount)
	if srcCount > 0 && ftsCount == 0 {
		if err := database.DB.Exec(`INSERT INTO agentroom_doc_chunks_fts(rowid, content, heading)
			SELECT rowid, content, heading FROM agentroom_doc_chunks`).Error; err != nil {
			return err
		}
		logger.Log.Info().Int64("rows", srcCount).Msg("agentroom: doc-chunks FTS5 backfill complete")
	}
	return nil
}

// ChunkMarkdown 按 markdown heading (H1..H3) + 软上限 DocChunkSoftSize 切分文档。
// 返回值的 heading 为"所在标题路径"（"H1 > H2"），便于检索时回显来源。
// 不依赖任何外部解析器，采用行扫描 + 简单状态机。
func ChunkMarkdown(body string) []database.AgentRoomDocChunk {
	lines := strings.Split(normalizeLineBreaks(body), "\n")
	var (
		out      []database.AgentRoomDocChunk
		headings [3]string // H1, H2, H3 栈
		cur      strings.Builder
		curStart int
		seq      int
	)
	flush := func(endLine int) {
		_ = endLine
		content := strings.TrimSpace(cur.String())
		if content == "" {
			cur.Reset()
			return
		}
		heading := joinHeadings(headings[:])
		// 软上限：超过 DocChunkSoftSize 时按句号/空行递归二分
		for _, piece := range splitLarge(content, DocChunkSoftSize) {
			if strings.TrimSpace(piece) == "" {
				continue
			}
			if len(out) >= MaxChunksPerDoc {
				return
			}
			out = append(out, database.AgentRoomDocChunk{
				Seq:       seq,
				Heading:   heading,
				Content:   piece,
				CreatedAt: time.Now(),
			})
			seq++
		}
		cur.Reset()
	}

	for i, line := range lines {
		trim := strings.TrimSpace(line)
		level, title := mdHeadingLevel(trim)
		if level > 0 {
			// 遇到新标题：flush 前面累积的内容，更新标题栈
			flush(i)
			if level >= 1 && level <= 3 {
				headings[level-1] = title
				// 清空更深层级
				for d := level; d < 3; d++ {
					headings[d] = ""
				}
			}
			curStart = i + 1
			continue
		}
		cur.WriteString(line)
		cur.WriteByte('\n')
		_ = curStart
	}
	flush(len(lines))
	return out
}

func normalizeLineBreaks(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return s
}

func mdHeadingLevel(line string) (int, string) {
	// ATX 样式 "# title" "## title" "### title"
	i := 0
	for i < len(line) && line[i] == '#' {
		i++
	}
	if i == 0 || i > 3 {
		return 0, ""
	}
	if i >= len(line) || line[i] != ' ' {
		return 0, ""
	}
	return i, strings.TrimSpace(line[i+1:])
}

func joinHeadings(h []string) string {
	var parts []string
	for _, s := range h {
		if s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, " > ")
}

// splitLarge 把 s 按软上限切成多段：优先按"双换行"，其次按句号，再其次硬切。
func splitLarge(s string, softSize int) []string {
	if utf8.RuneCountInString(s) <= softSize {
		return []string{s}
	}
	var out []string
	// 先按双换行切段落
	paras := strings.Split(s, "\n\n")
	buf := ""
	for _, p := range paras {
		if utf8.RuneCountInString(buf)+utf8.RuneCountInString(p)+2 > softSize && buf != "" {
			out = append(out, strings.TrimSpace(buf))
			buf = p
		} else {
			if buf != "" {
				buf += "\n\n"
			}
			buf += p
		}
	}
	if strings.TrimSpace(buf) != "" {
		out = append(out, strings.TrimSpace(buf))
	}
	// 若单段仍然超长，硬切
	final := make([]string, 0, len(out))
	for _, seg := range out {
		if utf8.RuneCountInString(seg) <= softSize*2 {
			final = append(final, seg)
			continue
		}
		runes := []rune(seg)
		for start := 0; start < len(runes); start += softSize {
			end := start + softSize
			if end > len(runes) {
				end = len(runes)
			}
			final = append(final, strings.TrimSpace(string(runes[start:end])))
		}
	}
	return final
}

// ── Repo 方法 ──

// CreateDoc 在事务中落库文档 + 所有 chunks。触发器会自动同步到 FTS5。
func (r *Repo) CreateDoc(doc *database.AgentRoomDoc, chunks []database.AgentRoomDocChunk) error {
	if doc.ID == "" {
		doc.ID = GenID("doc")
	}
	doc.ChunkCnt = len(chunks)
	doc.CreatedAt = time.Now()
	return database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(doc).Error; err != nil {
			return err
		}
		for i := range chunks {
			if chunks[i].ID == "" {
				chunks[i].ID = GenID("chunk")
			}
			chunks[i].DocID = doc.ID
			chunks[i].RoomID = doc.RoomID
			if chunks[i].CreatedAt.IsZero() {
				chunks[i].CreatedAt = time.Now()
			}
			if err := tx.Create(&chunks[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// ListDocs 返回房间内的文档元数据（按 createdAt DESC）。
func (r *Repo) ListDocs(roomID string) ([]database.AgentRoomDoc, error) {
	var docs []database.AgentRoomDoc
	return docs, database.DB.Where("room_id = ?", roomID).Order("created_at DESC").Find(&docs).Error
}

// DeleteDoc 删除文档 + 级联 chunks（FTS5 触发器会同步清理）。
func (r *Repo) DeleteDoc(roomID, docID string) error {
	return database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&database.AgentRoomDocChunk{}, "room_id = ? AND doc_id = ?", roomID, docID).Error; err != nil {
			return err
		}
		return tx.Delete(&database.AgentRoomDoc{}, "room_id = ? AND id = ?", roomID, docID).Error
	})
}

// DocSearchResult 是一条 chunk 命中 + 原文档标题。
type DocSearchResult struct {
	ChunkID  string  `json:"chunkId"`
	DocID    string  `json:"docId"`
	DocTitle string  `json:"docTitle"`
	Heading  string  `json:"heading,omitempty"`
	Content  string  `json:"content"`
	Rank     float64 `json:"rank"` // bm25 原始值，越小越相关
}

// SearchDocChunks 在指定房间内 FTS5 搜索文档切片。
func (r *Repo) SearchDocChunks(roomID, query string, topK int) ([]DocSearchResult, error) {
	if topK <= 0 || topK > 20 {
		topK = 5
	}
	safe := wrapFTSQuery(query)
	rows, err := database.DB.Raw(`
		SELECT c.id, c.doc_id, c.heading, c.content, d.title, bm25(agentroom_doc_chunks_fts) AS rank
		FROM agentroom_doc_chunks c
		JOIN agentroom_doc_chunks_fts fts ON fts.rowid = c.rowid
		JOIN agentroom_docs d ON d.id = c.doc_id
		WHERE c.room_id = ? AND agentroom_doc_chunks_fts MATCH ?
		ORDER BY rank ASC
		LIMIT ?`, roomID, safe, topK).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]DocSearchResult, 0, topK)
	for rows.Next() {
		var r DocSearchResult
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Heading, &r.Content, &r.DocTitle, &r.Rank); err != nil {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}
