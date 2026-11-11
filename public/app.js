const $ = (s) => document.querySelector(s);
const thread = $('#thread'), input = $('#input'), form = $('#composer'), send = $('#send');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let conversationId = new URLSearchParams(location.search).get('c');
let busy = false;

const render = (md) => {
  const html = DOMPurify.sanitize(marked.parse(md || ''), { ADD_ATTR: ['target'] });
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('a').forEach((a) => {
    a.target = '_blank'; a.rel = 'noopener';
    if (/^\[\d+\]$/.test(a.textContent)) a.classList.add('cite');
  });
  return div.innerHTML;
};

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function addUser(text) { $('#empty')?.remove(); thread.append(el('div', 'msg user', esc(text))); }

function addAssistant() {
  const wrap = el('div', 'msg assistant');
  const activity = el('div', 'activity'), body = el('div', 'body cursor'), sources = el('div', 'sources'), meta = el('div', 'meta');
  wrap.append(activity, body, sources, meta);
  thread.append(wrap);
  return { activity, body, sources, meta };
}

function renderSources(node, list) {
  node.innerHTML = list.map((s, i) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}"><b>${i + 1}</b>${esc(host(s.url))}</a>`).join('');
}

const scrollDown = () => { if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 200) thread.scrollTop = thread.scrollHeight; };

async function loadList() {
  const list = await (await fetch('/api/conversations')).json();
  $('#conversations').innerHTML = list.map((c) =>
    `<a href="?c=${c.id}" data-id="${c.id}" class="${c.id === conversationId ? 'active' : ''}">${esc(c.title)}<small>${new Date(c.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small></a>`).join('');
}

async function loadConversation(id) {
  const res = await fetch('/api/conversations/' + id);
  if (!res.ok) { conversationId = null; return; }
  const c = await res.json();
  thread.innerHTML = '';
  for (const t of c.turns) {
    if (t.role === 'user') addUser(t.text);
    else {
      const v = addAssistant();
      v.body.classList.remove('cursor');
      v.body.innerHTML = render(t.text);
      renderSources(v.sources, t.sources || []);
      if (t.searches?.length) v.meta.textContent = `${t.searches.length} search${t.searches.length > 1 ? 'es' : ''} · ${new Date(t.ts).toLocaleString()}`;
    }
  }
  thread.scrollTop = thread.scrollHeight;
}

async function sendMessage(text) {
  busy = true; send.disabled = true;
  addUser(text);
  const v = addAssistant();
  let md = '', searches = {}, frame = 0;
  const step = (html, live) => { const s = el('div', 'step' + (live ? ' live' : ''), html); v.activity.append(s); return s; };
  const paint = () => { frame = 0; v.body.innerHTML = render(md); scrollDown(); };

  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, conversationId, timeZone }) });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith('data: ')) continue;
        const e = JSON.parse(line.slice(6));
        if (e.type === 'meta') {
          if (conversationId !== e.conversationId) { conversationId = e.conversationId; history.replaceState(null, '', '?c=' + e.conversationId); }
        } else if (e.type === 'recall') {
          for (const d of e.dates) step(`Memory: “${esc(d.phrase)}” = ${esc(d.resolved)} → ${d.matches ? d.matches + ' past exchange' + (d.matches > 1 ? 's' : '') : 'nothing on record'}`);
        } else if (e.type === 'search') {
          searches[e.id] = step(`Searching: ${esc(e.query)}`, true);
        } else if (e.type === 'results') {
          const s = searches[e.id];
          if (s) { s.classList.remove('live'); s.innerHTML += e.error ? ` — <span class="error">${esc(e.error)}</span>` : ` — ${e.count} results`; }
        } else if (e.type === 'text') {
          md += e.delta;
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (e.type === 'sources') {
          renderSources(v.sources, e.sources);
        } else if (e.type === 'done') {
          v.meta.textContent = `${(e.ms / 1000).toFixed(1)}s${e.searches ? ` · ${e.searches} search${e.searches > 1 ? 'es' : ''}` : ''}`;
        } else if (e.type === 'error') {
          v.body.append(el('p', 'error', esc(e.message)));
        }
      }
    }
  } catch (err) {
    v.body.append(el('p', 'error', esc(err.message)));
  } finally {
    if (frame) cancelAnimationFrame(frame);
    if (md) v.body.innerHTML = render(md);
    v.body.classList.remove('cursor');
    v.activity.querySelectorAll('.live').forEach((s) => s.classList.remove('live'));
    busy = false; send.disabled = false; input.focus();
    loadList();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = ''; input.style.height = '';
  sendMessage(text);
});
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
input.addEventListener('input', () => { input.style.height = ''; input.style.height = input.scrollHeight + 'px'; });
$('#new-chat').addEventListener('click', () => { conversationId = null; history.replaceState(null, '', '/'); location.reload(); });
$('#conversations').addEventListener('click', (e) => {
  const a = e.target.closest('a'); if (!a || busy) return;
  e.preventDefault();
  conversationId = a.dataset.id; history.replaceState(null, '', '?c=' + conversationId);
  loadConversation(conversationId).then(loadList);
});

if (conversationId) loadConversation(conversationId);
loadList();
