// exportMeetingHtml.ts — 将 AI 会议室会话导出为自包含 HTML 文件
// 外观对齐 MessageBubble / MarkdownView 真实 UI；支持消息类型筛选。
// 零外部依赖；内联 CSS + 少量 JS（主题切换 / 筛选 / 搜索 / 代码块复制）。

import type { Room, Member, Message, MessageKind } from './types';

// ── helpers ──

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

const POLICY_NAMES: Record<string, string> = {
  free: '自由发言', reactive: '反应式', roundRobin: '轮流发言',
  moderator: '主持人', bidding: '竞价发言', observer: '静默观察',
  planned: '结构化执行', parallel: '并行', debate: '辩论',
};

// ── Markdown → HTML（对齐 MarkdownView 渲染效果）──

function mdToHtml(md: string): string {
  let h = escHtml(md);

  // fenced code blocks → dark pre with copy button
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const id = 'cb' + Math.random().toString(36).slice(2, 8);
    return `<div class="code-wrap"><pre class="code-block" id="${id}" data-lang="${lang}"><code>${code.trimEnd()}</code></pre><button class="code-copy" onclick="copyCode('${id}')">复制</button></div>`;
  });

  // inline code
  h = h.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // bold / italic (order matters)
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // headings
  h = h.replace(/^#### (.+)$/gm, '<h5 class="md-h">$1</h5>');
  h = h.replace(/^### (.+)$/gm, '<h4 class="md-h">$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3 class="md-h">$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2 class="md-h">$1</h2>');

  // blockquote
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');

  // hr
  h = h.replace(/^---$/gm, '<hr class="md-hr"/>');

  // unordered list
  h = h.replace(/^- (.+)$/gm, '<li class="md-li">$1</li>');
  h = h.replace(/((?:<li class="md-li">.*<\/li>\n?)+)/g, '<ul class="md-ul">$1</ul>');

  // ordered list
  h = h.replace(/^\d+\. (.+)$/gm, '<li class="md-oli">$1</li>');
  h = h.replace(/((?:<li class="md-oli">.*<\/li>\n?)+)/g, '<ol class="md-ol">$1</ol>');

  // simple table support (GFM)
  h = h.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_m, headerLine: string, _sep: string, bodyLines: string) => {
    const headers = headerLine.split('|').filter((c: string) => c.trim()).map((c: string) => `<th>${c.trim()}</th>`).join('');
    const rows = bodyLines.trim().split('\n').map((row: string) => {
      const cells = row.split('|').filter((c: string) => c.trim()).map((c: string) => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
  });

  // paragraphs
  h = h.replace(/\n\n/g, '</p><p class="md-p">');
  h = h.replace(/\n/g, '<br/>');
  h = `<p class="md-p">${h}</p>`;
  h = h.replace(/<p class="md-p"><\/p>/g, '');
  // don't wrap block elements in <p>
  h = h.replace(/<p class="md-p">(<(?:h[2-5]|ul|ol|blockquote|div|pre|hr|table))/g, '$1');
  h = h.replace(/(<\/(?:h[2-5]|ul|ol|blockquote|div|pre|hr|table)>)<\/p>/g, '$1');

  return h;
}

// ── 消息类别（用于筛选）──

type FilterKind = 'chat' | 'thinking' | 'tool' | 'system' | 'whisper' | 'bidding' | 'other';

function filterKindOf(kind: MessageKind): FilterKind {
  if (kind === 'chat' || kind === 'decision' || kind === 'minutes' || kind === 'summary' ||
      kind === 'critique' || kind === 'error' || kind === 'impersonating' ||
      kind === 'projection_in' || kind === 'projection_out') return 'chat';
  if (kind === 'thinking') return 'thinking';
  if (kind === 'tool' || kind === 'tool_approval') return 'tool';
  if (kind === 'system' || kind === 'checkpoint' || kind === 'intervention') return 'system';
  if (kind === 'whisper') return 'whisper';
  if (kind === 'bidding') return 'bidding';
  return 'other';
}

// ── 主入口 ──

export interface ExportOptions {
  room: Room;
  members: Member[];
  messages: Message[];
}

export function exportMeetingHtml({ room, members, messages }: ExportOptions): void {
  const memberMap = new Map(members.map(m => [m.id, m]));
  const sortedMsgs = [...messages]
    .filter(m => !m.deleted)
    .sort((a, b) => a.timestamp - b.timestamp);

  const chatCount = sortedMsgs.filter(m => filterKindOf(m.kind) === 'chat').length;
  const toolCount = sortedMsgs.filter(m => filterKindOf(m.kind) === 'tool').length;
  const thinkingCount = sortedMsgs.filter(m => filterKindOf(m.kind) === 'thinking').length;
  const firstTs = sortedMsgs[0]?.timestamp || room.createdAt;
  const lastTs = sortedMsgs[sortedMsgs.length - 1]?.timestamp || room.updatedAt;

  // ── 渲染每条消息 ──
  const msgsHtml = sortedMsgs.map((msg, idx) => {
    const member = memberMap.get(msg.authorId);
    const fk = filterKindOf(msg.kind);
    const isHuman = member?.kind === 'human';
    const isSystem = msg.kind === 'system' || msg.kind === 'checkpoint' || msg.kind === 'intervention';
    const isTool = msg.kind === 'tool' || msg.kind === 'tool_approval';
    const isThinking = msg.kind === 'thinking';

    const name = member?.name || msg.authorId;
    const emoji = member?.emoji || (isHuman ? '👤' : '🤖');
    const role = member?.role || '';
    const model = msg.model || member?.model || '';

    // 系统消息：居中分割线
    if (isSystem) {
      return `<div class="msg msg-system" data-kind="${fk}">
        <div class="sys-line"></div>
        <span class="sys-icon">${msg.kind === 'checkpoint' ? '📌' : msg.kind === 'intervention' ? '🖐️' : 'ℹ️'}</span>
        <span class="sys-text">${escHtml(msg.content)}</span>
        <span class="sys-time">${fmtTime(msg.timestamp)}</span>
        <div class="sys-line"></div>
      </div>`;
    }

    // 思考消息：折叠块
    if (isThinking) {
      return `<div class="msg msg-thinking" data-kind="${fk}">
        <div class="avatar">${emoji}</div>
        <div class="msg-body">
          <div class="msg-header">
            <span class="msg-name">${escHtml(name)}</span>
            <span class="badge badge-thinking">思考中</span>
            <span class="msg-time">${fmtTime(msg.timestamp)}</span>
          </div>
          <details class="thinking-details">
            <summary class="thinking-summary">💭 思考过程（点击展开 ${msg.content.length} 字）</summary>
            <div class="thinking-content">${mdToHtml(msg.content)}</div>
          </details>
        </div>
      </div>`;
    }

    // 工具调用：折叠卡片
    if (isTool) {
      const status = msg.toolStatus || '';
      const statusCls = status === 'success' ? 'tool-ok' : (status === 'failure' || status === 'timeout' || status === 'rejected') ? 'tool-fail' : 'tool-running';
      const statusIcon = status === 'success' ? '✅' : (status === 'failure' || status === 'timeout' || status === 'rejected') ? '❌' : '⏳';
      const preview = (msg.toolResult || '').split(/\r?\n/).find(l => l.trim())?.trim().slice(0, 100) || '';
      return `<div class="msg msg-tool" data-kind="${fk}">
        <div class="avatar avatar-xs">${emoji}</div>
        <div class="msg-body">
          <details class="tool-card ${statusCls}">
            <summary class="tool-header">
              <span class="tool-icon">${statusIcon}</span>
              <span class="tool-name">${escHtml(msg.toolName || 'tool')}</span>
              ${name ? `<span class="tool-author">· ${escHtml(name)}</span>` : ''}
              <span class="tool-time">${fmtTime(msg.timestamp)}</span>
              ${!preview ? '' : `<span class="tool-preview">${escHtml(preview)}${preview.length >= 100 ? '…' : ''}</span>`}
            </summary>
            <div class="tool-body">
              ${msg.toolArgs ? `<div class="tool-section"><div class="tool-label">参数</div><pre class="code-block"><code>${escHtml(JSON.stringify(msg.toolArgs, null, 2))}</code></pre></div>` : ''}
              ${msg.toolResult ? `<div class="tool-section"><div class="tool-label">结果</div><pre class="code-block tool-result"><code>${escHtml(msg.toolResult)}</code></pre></div>` : ''}
            </div>
          </details>
        </div>
      </div>`;
    }

    // 竞价
    if (msg.kind === 'bidding') {
      const scores = (msg.biddingScores || []).map((s, i) => {
        const m = memberMap.get(s.memberId);
        return `<div class="bid-row ${i === 0 ? 'bid-winner' : ''}">
          <span class="bid-emoji">${m?.emoji || '🤖'}</span>
          <span class="bid-name">${escHtml(m?.name || s.memberId)}</span>
          <div class="bid-bar"><div class="bid-fill ${i === 0 ? 'bid-fill-win' : ''}" style="width:${(s.score / 10) * 100}%"></div></div>
          <span class="bid-score">${s.score.toFixed(1)}</span>
          ${i === 0 ? '<span class="bid-trophy">🏆</span>' : ''}
        </div>`;
      }).join('');
      return `<div class="msg msg-bidding" data-kind="${fk}">
        <div class="bidding-card">
          <div class="bidding-title">⚖️ 竞价发言 · 下一位发言人</div>
          ${scores}
        </div>
      </div>`;
    }

    // 私聊
    if (msg.kind === 'whisper') {
      const targets = (msg.whisperTargetIds || []).map(id => memberMap.get(id)?.name).filter(Boolean).join('、');
      return `<div class="msg msg-whisper" data-kind="${fk}">
        <div class="avatar">${emoji}</div>
        <div class="msg-body">
          <div class="msg-header">
            <span class="msg-name">${escHtml(name)}</span>
            <span class="badge badge-whisper">🔒 私聊 → ${escHtml(targets || '指定成员')}</span>
            <span class="msg-time">${fmtTime(msg.timestamp)}</span>
          </div>
          <div class="bubble bubble-whisper"><div class="md-content">${mdToHtml(msg.content)}</div></div>
        </div>
      </div>`;
    }

    // 错误
    if (msg.kind === 'error') {
      return `<div class="msg" data-kind="${fk}">
        <div class="avatar">${emoji}</div>
        <div class="msg-body">
          <div class="msg-header">
            <span class="msg-name msg-name-error">${escHtml(name)}</span>
            <span class="badge badge-error">模型错误</span>
            <span class="msg-time">${fmtTime(msg.timestamp)}</span>
          </div>
          <div class="bubble bubble-error"><span class="error-icon">⚠️</span><div class="md-content">${mdToHtml(msg.content)}</div></div>
        </div>
      </div>`;
    }

    // ── 默认 chat 消息（主要视觉）──
    const badges: string[] = [];
    if (member?.isModerator) badges.push('<span class="badge badge-mod">MOD</span>');
    if (msg.kind === 'decision' || msg.isDecision) badges.push('<span class="badge badge-decision">🔖 决策</span>');
    if (msg.kind === 'minutes') badges.push('<span class="badge badge-minutes">📋 会议纪要</span>');
    if (msg.kind === 'summary') badges.push('<span class="badge badge-summary">📝 摘要</span>');
    if (msg.kind === 'critique') badges.push('<span class="badge badge-critique">🔍 自我批判</span>');
    if (msg.kind === 'impersonating') badges.push(`<span class="badge badge-impersonate">🎭 ${escHtml(memberMap.get(msg.authorId)?.name || '')} 扮演</span>`);
    if (typeof msg.confidence === 'number' && msg.confidence > 0) {
      const cls = msg.confidence >= 80 ? 'conf-high' : msg.confidence >= 50 ? 'conf-mid' : 'conf-low';
      badges.push(`<span class="badge badge-conf ${cls}">${msg.confidence}%</span>`);
    }
    if (msg.stance) {
      const stanceMap: Record<string, string> = { agree: '同意', disagree: '反对', abstain: '弃权', uncertain: '不确定' };
      badges.push(`<span class="badge badge-stance">${stanceMap[msg.stance] || msg.stance}</span>`);
    }
    if (msg.humanNeeded) badges.push('<span class="badge badge-human-needed">🖐️ 需人介入</span>');

    let contentHtml = '';
    if (isHuman) {
      // 人类消息：纯文本保留 @ 高亮
      contentHtml = `<div class="whitespace-pre-wrap">${escHtml(msg.content)}</div>`;
    } else {
      // agent 消息：Markdown 渲染
      contentHtml = `<div class="md-content">${mdToHtml(msg.content)}</div>`;
    }

    // 图片附件
    if (msg.attachments?.length) {
      const imgs = msg.attachments.filter(a => a.type === 'image').map(a =>
        `<a href="data:${a.mimeType};base64,${a.content}" target="_blank" class="attach-link"><img class="attach-img" src="data:${a.mimeType};base64,${a.content}" alt="${escHtml(a.fileName || 'image')}" /></a>`
      ).join('');
      if (imgs) contentHtml += `<div class="attachments">${imgs}</div>`;
    }

    const costInfo = msg.costCNY ? `<span class="msg-cost">¥${msg.costCNY.toFixed(4)}</span>` : '';
    const tokenInfo = (msg.tokensIn || msg.tokensOut) ? `<span class="msg-tokens">${msg.tokensIn || 0}→${msg.tokensOut || 0}</span>` : '';

    return `<div class="msg ${isHuman ? 'msg-human' : 'msg-agent'}" data-kind="${fk}" id="msg-${idx}">
      <div class="avatar">${emoji}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-name">${escHtml(name)}</span>
          ${role ? `<span class="msg-role">${escHtml(role)}</span>` : ''}
          ${badges.join('')}
          ${model ? `<span class="msg-model">${escHtml(model)}</span>` : ''}
          <span class="msg-time">${fmtTime(msg.timestamp)}</span>
          ${costInfo}${tokenInfo}
        </div>
        <div class="bubble">${contentHtml}</div>
      </div>
    </div>`;
  }).join('\n');

  // ── 成员列表 ──
  const membersHtml = members.map(m => {
    const b: string[] = [];
    if (m.kind === 'human') b.push('<span class="badge badge-human-tag">人类</span>');
    if (m.isModerator) b.push('<span class="badge badge-mod">主持人</span>');
    if (m.stance) b.push(`<span class="badge badge-stance">${m.stance}</span>`);
    if (m.isKicked) b.push('<span class="badge badge-kicked">已离席</span>');
    const gradient = m.emoji ? '' : `background:linear-gradient(135deg,${m.avatarColor || '#00c8ff'},${m.avatarColor || '#8b5cf6'});color:#fff;`;
    return `<div class="member-card">
      <div class="member-avatar" style="${gradient}">${m.emoji || m.name.slice(0, 1).toUpperCase()}</div>
      <div class="member-info">
        <div class="member-name">${escHtml(m.name)} ${b.join(' ')}</div>
        <div class="member-role">${escHtml(m.role)}${m.model ? ` · <span class="member-model">${escHtml(m.model)}</span>` : ''}</div>
      </div>
    </div>`;
  }).join('\n');

  // Stats
  const totalTokens = sortedMsgs.reduce((s, m) => s + (m.tokensIn || 0) + (m.tokensOut || 0), 0);
  const totalCost = sortedMsgs.reduce((s, m) => s + (m.costCNY || 0), 0);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(room.title)} — AI 会议记录</title>
<style>
${CSS_CONTENT}
</style>
</head>
<body>
<div class="container">
  <!-- Header -->
  <header class="header">
    <div class="header-top">
      <h1>${escHtml(room.title)}</h1>
      <div class="header-actions">
        <button onclick="toggleTheme()" id="themeBtn" title="切换主题">☀️</button>
        <button onclick="toggleSearch()" title="搜索">🔍</button>
        <button onclick="copyAll()" title="复制全文">📋</button>
      </div>
    </div>
    <div class="meta-row">
      <span>📅 ${fmtDate(firstTs)}</span>
      <span>⏱️ ${fmtDuration(lastTs - firstTs)}</span>
      <span>💬 ${chatCount} 轮对话</span>
      <span>🎯 ${POLICY_NAMES[room.policy] || room.policy}</span>
      ${room.state !== 'active' ? `<span>📌 ${room.state}</span>` : ''}
      ${totalTokens > 0 ? `<span>🔤 ${(totalTokens / 1000).toFixed(1)}k tokens</span>` : ''}
      ${totalCost > 0 ? `<span>💰 ¥${totalCost.toFixed(2)}</span>` : ''}
    </div>
    ${room.goal ? `<div class="room-goal"><strong>🎯 议题：</strong>${escHtml(room.goal)}</div>` : ''}
  </header>

  <!-- Filter bar -->
  <div class="filter-bar" id="filterBar">
    <span class="filter-label">显示：</span>
    <label class="filter-chip active" data-filter="chat"><input type="checkbox" checked onchange="toggleFilter('chat',this.checked)"/>💬 对话 <span class="filter-count">${chatCount}</span></label>
    ${thinkingCount > 0 ? `<label class="filter-chip" data-filter="thinking"><input type="checkbox" onchange="toggleFilter('thinking',this.checked)"/>💭 思考 <span class="filter-count">${thinkingCount}</span></label>` : ''}
    ${toolCount > 0 ? `<label class="filter-chip" data-filter="tool"><input type="checkbox" onchange="toggleFilter('tool',this.checked)"/>🔧 工具 <span class="filter-count">${toolCount}</span></label>` : ''}
    <label class="filter-chip" data-filter="system"><input type="checkbox" onchange="toggleFilter('system',this.checked)"/>⚙️ 系统</label>
    <label class="filter-chip" data-filter="whisper"><input type="checkbox" onchange="toggleFilter('whisper',this.checked)"/>🔒 私聊</label>
    <label class="filter-chip" data-filter="bidding"><input type="checkbox" onchange="toggleFilter('bidding',this.checked)"/>⚖️ 竞价</label>
  </div>

  <!-- Search bar -->
  <div class="search-bar" id="searchBar" style="display:none">
    <input type="text" id="searchInput" placeholder="搜索消息内容…" oninput="doSearch(this.value)" />
    <span id="searchCount"></span>
  </div>

  <!-- Members -->
  <details class="members-section">
    <summary>👥 参会成员 (${members.length})</summary>
    <div class="members-grid">${membersHtml}</div>
  </details>

  <!-- Messages -->
  <div class="messages" id="messages">
    ${msgsHtml}
  </div>

  <!-- Footer -->
  <footer class="footer">
    <div class="footer-brand">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px;opacity:0.6"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <span>由 <a href="https://github.com/ClawDeckX/ClawDeckX" target="_blank" rel="noopener noreferrer"><strong>ClawDeckX</strong></a> AI会议室 导出</span>
    </div>
    <div class="footer-meta">${fmtDate(Date.now())} ${fmtTime(Date.now())} · <a href="https://github.com/ClawDeckX/ClawDeckX" target="_blank" rel="noopener noreferrer">GitHub</a> · 开源 AI OpenClaw 可视化面板</div>
  </footer>
</div>

<script>
${JS_CONTENT}
</script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${room.title.replace(/[\\/:*?"<>|]/g, '_')}-${fmtDate(firstTs).replace(/\//g, '-')}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 内联 CSS（对齐 MessageBubble 真实 UI）──

const CSS_CONTENT = `
:root {
  --bg: #ffffff; --surface: #f8fafc; --surface2: #f1f5f9; --border: #e2e8f0;
  --text: #1e293b; --text2: #475569; --text3: #94a3b8;
  --accent: #8b5cf6; --accent-bg: #f5f3ff; --cyan: #06b6d4;
  --human-bg: #eff6ff; --code-bg: #0f172a; --code-text: #e2e8f0; --code-border: rgba(34,211,238,0.2);
  --success: #10b981; --warning: #f59e0b; --danger: #ef4444;
  --shadow: 0 1px 3px rgba(0,0,0,0.08);
}
.dark {
  --bg: #0f172a; --surface: #1e293b; --surface2: #334155; --border: #334155;
  --text: #f1f5f9; --text2: #94a3b8; --text3: #64748b;
  --accent: #a78bfa; --accent-bg: #1e1b4b; --cyan: #22d3ee;
  --human-bg: #172554; --code-bg: #0f172a; --code-text: #e2e8f0; --code-border: rgba(34,211,238,0.2);
  --shadow: 0 1px 3px rgba(0,0,0,0.3);
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:var(--bg); color:var(--text); line-height:1.6; }
.container { max-width:900px; margin:0 auto; padding:24px 16px; }

/* Header */
.header { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:24px; margin-bottom:12px; box-shadow:var(--shadow); }
.header-top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.header h1 { font-size:22px; font-weight:700; }
.header-actions { display:flex; gap:6px; }
.header-actions button { width:36px; height:36px; border-radius:10px; border:1px solid var(--border); background:var(--surface2); cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center; transition:all 0.15s; }
.header-actions button:hover { background:var(--accent-bg); border-color:var(--accent); }
.meta-row { display:flex; flex-wrap:wrap; gap:10px; margin-top:12px; font-size:13px; color:var(--text2); }
.room-goal { margin-top:12px; padding:10px 14px; background:var(--accent-bg); border-radius:10px; font-size:13px; }

/* Filter bar */
.filter-bar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-bottom:12px; padding:10px 14px; background:var(--surface); border:1px solid var(--border); border-radius:12px; }
.filter-label { font-size:12px; font-weight:600; color:var(--text2); margin-inline-end:4px; }
.filter-chip { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:16px; font-size:11px; font-weight:600; cursor:pointer; border:1px solid var(--border); background:var(--surface2); color:var(--text2); transition:all 0.15s; user-select:none; }
.filter-chip input { display:none; }
.filter-chip.active { background:var(--accent-bg); border-color:var(--accent); color:var(--accent); }
.filter-count { font-size:10px; opacity:0.7; font-family:monospace; }

/* Search */
.search-bar { margin-bottom:12px; display:flex; align-items:center; gap:8px; }
.search-bar input { flex:1; height:38px; padding:0 14px; border-radius:10px; border:1px solid var(--border); background:var(--surface); font-size:13px; color:var(--text); outline:none; }
.search-bar input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(139,92,246,0.1); }
#searchCount { font-size:12px; color:var(--text3); white-space:nowrap; }

/* Members */
.members-section { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 16px; margin-bottom:12px; }
.members-section summary { font-size:13px; font-weight:600; cursor:pointer; user-select:none; }
.members-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:8px; margin-top:10px; }
.member-card { display:flex; align-items:center; gap:10px; padding:8px 12px; border-radius:10px; background:var(--surface2); border:1px solid var(--border); }
.member-avatar { width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:700; flex-shrink:0; ring:1px solid rgba(0,0,0,0.05); }
.member-name { font-size:12px; font-weight:600; }
.member-role { font-size:11px; color:var(--text3); }
.member-model { font-family:monospace; font-size:10px; }

/* Messages */
.messages { display:flex; flex-direction:column; gap:2px; }
.msg { display:flex; gap:10px; padding:8px 12px; border-radius:10px; transition:background 0.15s; }
.msg:hover { background:rgba(0,0,0,0.015); }
.dark .msg:hover { background:rgba(255,255,255,0.015); }
.msg[style*="display:none"] { padding:0; margin:0; }

/* Avatar (matches MemberAvatar rounded-xl) */
.avatar { width:32px; height:32px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0; }
.avatar-xs { width:24px; height:24px; font-size:12px; border-radius:8px; }
.msg-body { flex:1; min-width:0; }

/* Message header (matches MessageBubble header layout) */
.msg-header { display:flex; flex-wrap:wrap; align-items:baseline; gap:5px; margin-bottom:3px; line-height:1.3; }
.msg-name { font-size:12px; font-weight:700; }
.msg-name-error { color:var(--danger); }
.msg-role { font-size:10px; color:var(--accent); background:var(--accent-bg); padding:1px 6px; border-radius:4px; }
.msg-model { font-size:10px; color:var(--text3); font-family:monospace; opacity:0.6; }
.msg-time { font-size:10px; color:var(--text3); font-family:monospace; opacity:0.5; margin-inline-start:auto; }
.msg-cost, .msg-tokens { font-size:10px; color:var(--text3); font-family:monospace; opacity:0.5; }

/* Bubble */
.bubble { font-size:13px; line-height:1.7; word-break:break-word; }
.msg-human .bubble { display:inline-block; padding:8px 14px; border-radius:12px; background:var(--human-bg); max-width:85%; }
.dark .msg-human .bubble { background:var(--human-bg); }
.bubble-whisper { display:inline-block; padding:8px 14px; border-radius:12px; background:rgba(168,85,247,0.05); border:1px dashed rgba(168,85,247,0.3); font-style:italic; max-width:85%; }
.bubble-error { display:inline-flex; align-items:flex-start; gap:8px; padding:8px 14px; border-radius:12px; background:rgba(239,68,68,0.05); border:1px solid rgba(239,68,68,0.2); max-width:85%; }
.error-icon { flex-shrink:0; margin-top:2px; }
.whitespace-pre-wrap { white-space:pre-wrap; }

/* Markdown content (matches MarkdownView) */
.md-content { font-size:13px; line-height:1.7; }
.md-p { margin:6px 0; }
.md-p:first-child { margin-top:0; }
.md-p:last-child { margin-bottom:0; }
.md-h { font-weight:700; margin:10px 0 4px; }
h2.md-h { font-size:16px; }
h3.md-h { font-size:15px; }
h4.md-h { font-size:14px; }
h5.md-h { font-size:13px; }
.md-ul, .md-ol { padding-inline-start:20px; margin:6px 0; }
.md-ul { list-style:disc; }
.md-ol { list-style:decimal; }
.md-li, .md-oli { line-height:1.6; margin:2px 0; }
.md-quote { margin:6px 0; padding-inline-start:12px; border-inline-start:2px solid rgba(34,211,238,0.4); color:var(--text2); font-style:italic; }
.md-hr { border:none; border-top:1px solid var(--border); margin:8px 0; }
.md-table-wrap { overflow-x:auto; margin:8px 0; }
.md-table { font-size:12px; border-collapse:collapse; }
.md-table th { padding:4px 8px; border:1px solid var(--border); background:var(--surface2); font-weight:600; text-align:start; }
.md-table td { padding:4px 8px; border:1px solid var(--border); }

/* Code blocks (dark bg, matching MarkdownView) */
.code-wrap { position:relative; margin:8px 0; }
.code-block { background:var(--code-bg); color:var(--code-text); border:1px solid var(--code-border); border-radius:8px; padding:12px; overflow-x:auto; font-size:12px; font-family:'JetBrains Mono','Fira Code',monospace; line-height:1.5; white-space:pre-wrap; word-break:break-all; margin:0; }
.code-copy { position:absolute; top:6px; right:6px; padding:2px 8px; border-radius:6px; font-size:10px; font-weight:600; background:rgba(30,41,59,0.8); color:#94a3b8; border:1px solid rgba(100,116,139,0.3); cursor:pointer; opacity:0; transition:opacity 0.15s; backdrop-filter:blur(4px); }
.code-wrap:hover .code-copy { opacity:1; }
.code-copy:hover { color:#e2e8f0; background:rgba(51,65,85,0.9); }
.code-copy.copied { color:var(--success); }
.inline-code { background:var(--surface2); border:1px solid var(--border); padding:1px 5px; border-radius:4px; font-size:0.9em; font-family:'JetBrains Mono','Fira Code',monospace; color:var(--cyan); }
.dark .inline-code { color:var(--cyan); }

/* System messages (centered divider) */
.msg-system { display:flex; align-items:center; gap:8px; padding:8px 12px; font-size:11px; color:var(--text3); }
.sys-line { flex:1; height:1px; background:var(--border); }
.sys-icon { font-size:13px; flex-shrink:0; }
.sys-text { flex-shrink:1; min-width:0; }
.sys-time { font-size:10px; font-family:monospace; opacity:0.6; flex-shrink:0; }

/* Thinking (folded by default) */
.thinking-details { margin-top:4px; }
.thinking-summary { font-size:11px; color:var(--text3); cursor:pointer; user-select:none; padding:4px 8px; border-radius:8px; background:var(--surface2); display:inline-block; }
.thinking-summary:hover { background:var(--surface); }
.thinking-content { margin-top:6px; padding:10px 12px; background:var(--surface2); border-radius:8px; font-size:13px; color:var(--text2); border-inline-start:3px solid var(--text3); max-height:400px; overflow-y:auto; }

/* Tool cards (matches ToolCallCard compact style) */
.tool-card { border-radius:8px; border:1px solid var(--border); overflow:hidden; }
.tool-card.tool-ok { border-color:rgba(16,185,129,0.25); background:rgba(16,185,129,0.03); }
.tool-card.tool-fail { border-color:rgba(239,68,68,0.25); background:rgba(239,68,68,0.03); }
.tool-card.tool-running { border-color:rgba(6,182,212,0.25); background:rgba(6,182,212,0.03); }
.tool-header { display:flex; align-items:center; gap:6px; padding:6px 10px; font-size:11px; cursor:pointer; user-select:none; }
.tool-header:hover { background:rgba(0,0,0,0.02); }
.dark .tool-header:hover { background:rgba(255,255,255,0.02); }
.tool-icon { flex-shrink:0; }
.tool-name { font-family:monospace; font-weight:700; color:var(--text); flex-shrink:0; }
.tool-author { color:var(--text3); font-size:10px; flex-shrink:0; }
.tool-time { font-size:10px; color:var(--text3); font-family:monospace; opacity:0.5; flex-shrink:0; }
.tool-preview { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text2); font-family:monospace; font-size:10px; }
.tool-body { padding:8px 10px; border-top:1px solid var(--border); }
.tool-section { margin-bottom:8px; }
.tool-section:last-child { margin-bottom:0; }
.tool-label { font-size:10px; text-transform:uppercase; letter-spacing:0.05em; color:var(--text3); margin-bottom:4px; }
.tool-result { max-height:200px; overflow-y:auto; }

/* Bidding */
.bidding-card { margin:8px 12px; padding:16px; border-radius:12px; border:1px solid rgba(245,158,11,0.3); background:linear-gradient(135deg,rgba(245,158,11,0.05),rgba(249,115,22,0.05)); }
.bidding-title { font-size:12px; font-weight:700; color:var(--warning); margin-bottom:10px; }
.bid-row { display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:8px; }
.bid-winner { background:rgba(245,158,11,0.1); }
.bid-emoji { font-size:16px; flex-shrink:0; }
.bid-name { font-size:12px; font-weight:600; flex:1; min-width:0; }
.bid-bar { flex:0 0 120px; height:6px; border-radius:3px; background:var(--surface2); overflow:hidden; }
.bid-fill { height:100%; border-radius:3px; background:linear-gradient(90deg,#94a3b8,#cbd5e1); }
.bid-fill-win { background:linear-gradient(90deg,#f59e0b,#f97316); box-shadow:0 0 8px rgba(245,158,11,0.5); }
.bid-score { font-size:11px; font-family:monospace; width:28px; text-align:end; }
.bid-trophy { font-size:14px; }

/* Badges (matching MessageBubble badge styles) */
.badge { display:inline-flex; align-items:center; gap:2px; font-size:9px; font-weight:600; padding:1px 6px; border-radius:10px; vertical-align:baseline; }
.badge-mod { background:rgba(168,85,247,0.1); color:#9333ea; }
.dark .badge-mod { background:rgba(168,85,247,0.15); color:#c084fc; }
.badge-thinking { background:var(--surface2); color:var(--text3); }
.badge-whisper { background:rgba(168,85,247,0.1); color:#9333ea; }
.dark .badge-whisper { background:rgba(168,85,247,0.15); color:#c084fc; }
.badge-error { background:rgba(239,68,68,0.1); color:#dc2626; }
.dark .badge-error { color:#f87171; }
.badge-decision { background:rgba(16,185,129,0.1); color:#059669; border:1px solid rgba(16,185,129,0.3); }
.dark .badge-decision { color:#6ee7b7; }
.badge-minutes { background:rgba(59,130,246,0.1); color:#2563eb; }
.dark .badge-minutes { color:#60a5fa; }
.badge-summary { background:rgba(99,102,241,0.1); color:#6366f1; }
.dark .badge-summary { color:#a5b4fc; }
.badge-critique { background:rgba(249,115,22,0.1); color:#ea580c; }
.dark .badge-critique { color:#fb923c; }
.badge-impersonate { background:rgba(245,158,11,0.1); color:#d97706; }
.badge-human-needed { background:rgba(245,158,11,0.15); color:#b45309; border:1px solid rgba(245,158,11,0.3); }
.dark .badge-human-needed { color:#fcd34d; }
.badge-stance { background:rgba(139,92,246,0.1); color:#7c3aed; }
.dark .badge-stance { color:#a78bfa; }
.badge-conf { border:1px solid; }
.conf-high { background:rgba(16,185,129,0.1); color:#059669; border-color:rgba(16,185,129,0.3); }
.conf-mid { background:rgba(245,158,11,0.1); color:#d97706; border-color:rgba(245,158,11,0.3); }
.conf-low { background:rgba(239,68,68,0.1); color:#dc2626; border-color:rgba(239,68,68,0.3); }
.badge-human-tag { background:#dbeafe; color:#2563eb; }
.dark .badge-human-tag { background:#1e3a5f; color:#60a5fa; }
.badge-kicked { background:#fee2e2; color:#dc2626; }

/* Attachments */
.attachments { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }
.attach-link { display:inline-block; border-radius:8px; overflow:hidden; border:1px solid var(--border); transition:border-color 0.15s; }
.attach-link:hover { border-color:var(--cyan); box-shadow:0 4px 12px rgba(0,0,0,0.12); }
.attach-img { display:block; max-width:144px; max-height:144px; object-fit:contain; }

/* Search highlight */
.highlight { background:#fef08a; color:#000; border-radius:2px; padding:0 1px; }
.dark .highlight { background:#854d0e; color:#fef3c7; }

/* Footer */
.footer { margin-top:24px; padding:20px 16px; text-align:center; font-size:12px; color:var(--text3); border-top:1px solid var(--border); }
.footer-brand { display:flex; align-items:center; justify-content:center; gap:2px; font-size:13px; margin-bottom:6px; }
.footer-meta { font-size:11px; color:var(--text3); }
.footer a { color:var(--accent); text-decoration:none; }
.footer a:hover { text-decoration:underline; }

@media (max-width:600px) {
  .container { padding:12px 8px; }
  .header { padding:16px; }
  .members-grid { grid-template-columns:1fr; }
  .msg { padding:6px 8px; }
  .filter-bar { padding:8px 10px; }
}
@media print {
  .header-actions, .search-bar, .filter-bar { display:none!important; }
  .msg:hover { background:transparent; }
}
`;

// ── 内联 JS（主题 / 筛选 / 搜索 / 代码块复制 / 全文复制）──

const JS_CONTENT = `
(function(){
  // Theme
  var dark = window.matchMedia('(prefers-color-scheme:dark)').matches;
  if(dark) document.documentElement.classList.add('dark');
  window.toggleTheme = function(){
    document.documentElement.classList.toggle('dark');
    dark = !dark;
    document.getElementById('themeBtn').textContent = dark ? '☀️' : '🌙';
  };
  document.getElementById('themeBtn').textContent = dark ? '☀️' : '🌙';

  // Filter
  var filters = { chat:true, thinking:false, tool:false, system:false, whisper:false, bidding:false, other:true };
  function applyFilters(){
    document.querySelectorAll('.msg[data-kind]').forEach(function(el){
      var k = el.getAttribute('data-kind');
      el.style.display = filters[k] ? '' : 'none';
    });
  }
  window.toggleFilter = function(kind, on){
    filters[kind] = on;
    var chip = document.querySelector('.filter-chip[data-filter="'+kind+'"]');
    if(chip) chip.classList.toggle('active', on);
    applyFilters();
  };
  // apply initial state (only chat visible by default)
  applyFilters();

  // Search
  window.toggleSearch = function(){
    var bar = document.getElementById('searchBar');
    var vis = bar.style.display === 'none';
    bar.style.display = vis ? 'flex' : 'none';
    if(vis) document.getElementById('searchInput').focus();
    else { doSearch(''); document.getElementById('searchInput').value = ''; }
  };
  window.doSearch = function(q){
    document.querySelectorAll('.highlight').forEach(function(el){ el.outerHTML = el.textContent; });
    var count = 0;
    if(!q.trim()){
      applyFilters();
      document.getElementById('searchCount').textContent='';
      return;
    }
    var re = new RegExp('(' + q.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&') + ')','gi');
    document.querySelectorAll('.msg').forEach(function(el){
      var body = el.querySelector('.bubble, .md-content, .sys-text, .thinking-content');
      if(!body){ return; }
      var text = body.textContent||'';
      if(re.test(text)){
        el.style.display='';
        body.innerHTML = body.innerHTML.replace(re,'<span class="highlight">$1</span>');
        count++;
      } else { el.style.display='none'; }
    });
    document.getElementById('searchCount').textContent = count + ' 条匹配';
  };

  // Code block copy
  window.copyCode = function(id){
    var el = document.getElementById(id);
    if(!el) return;
    var text = el.innerText||'';
    navigator.clipboard.writeText(text).then(function(){
      var btn = el.parentElement.querySelector('.code-copy');
      if(btn){ btn.textContent='已复制'; btn.classList.add('copied'); setTimeout(function(){ btn.textContent='复制'; btn.classList.remove('copied'); },1500); }
    });
  };

  // Copy all visible chat text
  window.copyAll = function(){
    var text = '';
    document.querySelectorAll('.msg:not([style*="display:none"])').forEach(function(el){
      var name = el.querySelector('.msg-name');
      var time = el.querySelector('.msg-time, .sys-time');
      var content = el.querySelector('.bubble, .sys-text');
      if(name && content){
        text += '[' + (time?time.textContent:'') + '] ' + name.textContent + ': ' + content.textContent.trim() + '\\n\\n';
      } else if(content){
        text += content.textContent.trim() + '\\n';
      }
    });
    navigator.clipboard.writeText(text).then(function(){
      alert('已复制可见消息到剪贴板');
    });
  };
})();
`;
