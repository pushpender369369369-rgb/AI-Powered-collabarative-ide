import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
import QRCode from 'qrcode';

self.MonacoEnvironment = { getWorker: (_, l) => (l === 'typescript' || l === 'javascript' ? new tsWorker() : new editorWorker()) };
const $ = id => document.getElementById(id);
const LANGS = { js: 'javascript', ts: 'typescript', py: 'python', json: 'json', html: 'html', css: 'css', md: 'markdown' };
const ext = f => f.split('.').pop();
const langOf = f => LANGS[ext(f)] || 'plaintext';
const TOKEN = decodeURIComponent(location.pathname.slice(3)), ROLE = TOKEN.split('.')[1];
const post = (url, o) => fetch(url, { method: 'POST', headers: { 'x-token': TOKEN }, body: JSON.stringify(o) });
if (ROLE === 'view') document.body.classList.add('ro');

const ydoc = new Y.Doc();
const provider = new WebsocketProvider(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/yjs`, TOKEN, ydoc);
const files = ydoc.getArray('files'), ailog = ydoc.getArray('ailog');
provider.once('sync', () => { if (ROLE !== 'view' && !files.length) files.push(['main.js']); });

// ---- presence
const me = { name: prompt('Your name?') || 'anon', color: `hsl(${Math.random() * 360 | 0} 70% 60%)` };
provider.awareness.setLocalStateField('user', me);
const style = document.head.appendChild(document.createElement('style'));
provider.awareness.on('change', () => {
  const st = [...provider.awareness.getStates()];
  style.textContent = st.map(([id, s]) => s.user ? `.yRemoteSelection-${id}{background:${s.user.color}55}.yRemoteSelectionHead-${id}{border-color:${s.user.color}}` : '').join('');
  $('peers').replaceChildren(...st.filter(([, s]) => s.user).map(([, s]) => Object.assign(document.createElement('span'), { className: 'peer', textContent: s.user.name, style: `background:${CSS.escape ? s.user.color.replace(/[^\w(),.% ]/g, '') : ''}` })));
});

// ---- editor + files
const editor = monaco.editor.create($('editor'), { theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 14, inlineSuggest: { enabled: ROLE !== 'view' }, readOnly: ROLE === 'view' });
let current = null, binding = null, model = null;
function open(name) {
  binding?.destroy(); model?.dispose(); current = name;
  model = monaco.editor.createModel('', langOf(name));
  editor.setModel(model);
  binding = new MonacoBinding(ydoc.getText(name), model, new Set([editor]), provider.awareness);
  renderTabs();
}
const renderTabs = () => { $('tabs').replaceChildren(...files.toArray().map(f => Object.assign(document.createElement('div'), { className: 'tab' + (f === current ? ' on' : ''), textContent: f, onclick: () => open(f) }))); };
files.observe(() => (!current && files.length ? open(files.get(0)) : renderTabs()));
$('new').onclick = () => { const n = prompt('File name (e.g. app.py)'); if (n && !files.toArray().includes(n)) { files.push([n]); open(n); } };

// ---- project context: other files, truncated
const projectContext = () => files.toArray().filter(f => f !== current).slice(0, 6).map(f => `// ${f}\n${ydoc.getText(f).toString().slice(0, 2000)}`).join('\n\n');

// ---- ghost-text completions (debounced, cancels stale requests)
let timer, prev;
monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
  provideInlineCompletions: (m, pos, _c, token) => new Promise(resolve => {
    prev?.({ items: [] }); prev = resolve; clearTimeout(timer);
    timer = setTimeout(async () => {
      if (token.isCancellationRequested) return resolve({ items: [] });
      try {
        const end = m.getFullModelRange().getEndPosition();
        const prefix = m.getValueInRange(new monaco.Range(1, 1, pos.lineNumber, pos.column)).slice(-3000);
        const suffix = m.getValueInRange(new monaco.Range(pos.lineNumber, pos.column, end.lineNumber, end.column)).slice(0, 1000);
        const { text } = await (await post('/api/complete', { prefix, suffix, language: m.getLanguageId() })).json();
        resolve({ items: text && !token.isCancellationRequested ? [{ insertText: text, range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column) }] : [] });
      } catch { resolve({ items: [] }); }
    }, 450);
  }),
  freeInlineCompletions() {},
});

// ---- streaming AI
async function streamAI(body, onText) {
  const r = await post('/api/ai', body);
  if (!r.ok) throw new Error((await r.json()).error);
  const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '', full = '';
  for (;;) {
    const { done, value } = await rd.read(); if (done) return full;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const p of parts) { const d = p.slice(6); if (d === '[DONE]') return full; full += JSON.parse(d); onText(full); }
  }
}

// ---- diff review before AI edits land
let pending = null;
function showDiff(range, original, modified) {
  $('diffwrap').hidden = false;
  const d = monaco.editor.createDiffEditor($('diff'), { theme: 'vs-dark', automaticLayout: true });
  const o = monaco.editor.createModel(original, langOf(current)), m = monaco.editor.createModel(modified, langOf(current));
  d.setModel({ original: o, modified: m });
  pending = { range, d, o, m };
}
function closeDiff() { $('diffwrap').hidden = true; pending.d.dispose(); pending.o.dispose(); pending.m.dispose(); pending = null; }
$('reject').onclick = closeDiff;
$('accept').onclick = () => { editor.executeEdits('ai', [{ range: pending.range, text: pending.m.getValue() }]); closeDiff(); }; // Yjs binding syncs it

async function runAI(mode) {
  const sel = editor.getSelection(), empty = sel.isEmpty();
  const range = empty ? model.getFullModelRange() : sel, selection = model.getValueInRange(range);
  $('out').textContent = 'Thinking...';
  try {
    const text = await streamAI({ mode, instruction: $('ins').value, selection, file: model.getValue(), language: langOf(current), context: projectContext() }, t => { $('out').textContent = t; $('out').scrollTop = 1e9; });
    ailog.push([{ who: me.name, mode, text: text.slice(0, 3000) }]);
    if (mode !== 'explain') showDiff(range, selection, text.replace(/^```\w*\n?|\n?```\s*$/g, ''));
  } catch (e) { $('out').textContent = 'Error: ' + e.message; }
}
document.querySelectorAll('[data-m]').forEach(b => (b.onclick = () => runAI(b.dataset.m)));
const renderLog = () => {
  $('log').replaceChildren(...ailog.toArray().slice(-8).reverse().map(e => {
    const el = Object.assign(document.createElement('div'), { className: 'entry' });
    const b = Object.assign(document.createElement('b'), { textContent: e.who }); // textContent: names are untrusted
    el.append(b, ` · ${e.mode}\n${e.text}`);
    return el;
  }));
};
ailog.observe(renderLog); provider.once('sync', renderLog);

// ---- share: signed edit / view-only links + QR
$('share').onclick = async () => {
  const t = await (await fetch('/api/share', { headers: { 'x-token': TOKEN } })).json();
  const cards = await Promise.all([['Can edit', t.edit], ['View only', t.view]].map(async ([label, tok]) => {
    const url = `${location.origin}/p/${tok}`, el = Object.assign(document.createElement('div'), { className: 'card' });
    const img = Object.assign(new Image(160, 160), { src: await QRCode.toDataURL(url, { margin: 1, width: 320 }) });
    const input = Object.assign(document.createElement('input'), { value: url, readOnly: true });
    const copy = Object.assign(document.createElement('button'), { textContent: 'Copy link', onclick: () => navigator.clipboard.writeText(url) });
    el.append(Object.assign(document.createElement('b'), { textContent: label }), img, input, copy);
    return el;
  }));
  $('cards').replaceChildren(...cards); $('sharewrap').hidden = false;
};
$('closeshare').onclick = () => ($('sharewrap').hidden = true);
