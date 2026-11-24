/* 小说带入器 · 网页版前端（不依赖任何框架） */

const LS = {
  cfg: 'xb_cfg_v1',
  log: 'xb_log_v1',
  summary: 'xb_summary_v1',
};

const $ = (id) => document.getElementById(id);
const DATA = window.XB_DATA || null;          // 单文件版内联数据；本地服务版为空
const state = { bundle: null, msgs: [], summary: '', busy: false };

/* 存储：file:// 或被嵌入的浏览器里 localStorage 可能直接抛异常，
   一律走这个壳子，坏了就退回内存，功能不中断（只是关掉页面会丢）。 */
const fallback = {};
const store = {
  get(k) {
    try { const v = localStorage.getItem(k); return v === null ? (fallback[k] ?? null) : v; }
    catch { return fallback[k] ?? null; }
  },
  set(k, v) {
    fallback[k] = v;
    try { localStorage.setItem(k, v); } catch { /* 静默降级 */ }
  },
};

function cfg() {
  try { return JSON.parse(store.get(LS.cfg) || '{}'); } catch { return {}; }
}
function saveCfg(patch) {
  const next = { ...cfg(), ...patch };
  store.set(LS.cfg, JSON.stringify(next));
  return next;
}

/* ---------- 界面 ---------- */

function push(role, text) {
  state.msgs.push({ role, content: text });
  const row = document.createElement('div');
  row.className = 'turn ' + (role === 'user' ? 'player' : role === 'system' ? 'sys' : 'narrator');
  row.innerHTML = `<div class="who">${role === 'user' ? '你' : role === 'system' ? '系统' : '旁白'}</div><div class="text"></div>`;
  row.querySelector('.text').textContent = text;
  $('log').appendChild(row);
  $('log').scrollTop = $('log').scrollHeight;
  store.set(LS.log, JSON.stringify(state.msgs));
  return row;
}

function placeholder(text) {
  const row = document.createElement('div');
  row.className = 'turn narrator pending';
  row.innerHTML = `<div class="who">旁白</div><div class="text"></div>`;
  row.querySelector('.text').textContent = text;
  $('log').appendChild(row);
  $('log').scrollTop = $('log').scrollHeight;
  return row;
}

function setBusy(v) {
  state.busy = v;
  $('btnSend').disabled = v;
  $('btnStart').disabled = v;
  $('btnSettle').disabled = v;
  $('btnSend').textContent = v ? '生成中' : '发送';
}

/* ---------- 提示词 ---------- */

const RUNTIME = `
# 本网页运行约定（优先级高于文风偏好）
1. 开局第一轮不推进剧情，先问三句：我是谁（旁人眼里算什么身份）／我这一场想先办成什么／我这一趟想得到什么。问完等玩家答。
2. 玩家答完，才写第一段场景。每次回复结尾单独一行「你要做什么？」，一次只抛一个问题。
3. 判定默认隐形。只有驳回（这世界做不到）或代价重大（伤、死、暴露、欠大情）时，才给一句人话理由和一条替代路径。
4. 每段回复最多三种块：场景（2–5 句，至少一个感官细节）、台词（用「」，单独起行）、（需要时）**世界反应**。末尾最多一行 ▸ 世界线：……
5. 不在正文出现锚点编号、偏差数字、预算余额；这些记账内容只在你内部执行，玩家问起才解释。
6. 玩家没尝试的事不替他们判成败；他们说得漂亮也不放宽世界规则。
7. 原著人物有自己的事要忙，不随叫随到，不当工具人。
`;

function buildSystem() {
  const b = state.bundle;
  if (!b) return '';
  const parts = [];
  parts.push('# 一、身份与装载顺序\n' + b.system_prompt);
  parts.push('# 二、旁白通用纪律\n' + b.framework);
  if (b.persona) parts.push('# 三、本次人设（只改语气与密度）\n' + b.persona);
  if (b.canon?.length) {
    parts.push('# 四、设定集（这本书的事实，与你的印象冲突时以此为准）\n' +
      b.canon.map((f) => `\n\n## ${f.name}\n${f.text}`).join(''));
  }
  if (b.card) parts.push('# 五、玩家角色卡（已过审）\n' + b.card);
  if (state.summary) parts.push('# 六、已结算的世界状态（沿用，不要改）\n' + state.summary);
  parts.push(RUNTIME);
  return parts.join('\n\n');
}

/* ---------- 接口 ---------- */

async function chat(messages) {
  const c = cfg();
  if (!c.base_url || !c.model || !c.api_key) throw new Error('先点左下角「模型接口设置」填地址、模型名和 Key');
  const payload = {
    base_url: c.base_url, api_key: c.api_key, model: c.model,
    temperature: Number(c.temperature ?? 0.8), messages,
  };

  let j;
  if (DATA) {
    // 单文件版：浏览器直连（file:// 页面 Origin 为 null，多数国产接口放行）
    try {
      const r = await fetch(String(c.base_url).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.api_key },
        body: JSON.stringify({ model: c.model, messages, temperature: payload.temperature, stream: false }),
      });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('接口返回的不是 JSON：' + text.slice(0, 200)); }
      if (!r.ok) throw new Error(`接口返回 ${r.status}：${(parsed.error?.message || text).slice(0, 300)}`);
      j = { content: parsed?.choices?.[0]?.message?.content };
    } catch (e) {
      if (e instanceof TypeError) {
        throw new Error('这家接口不允许浏览器直连（跨域被拦）。换 DeepSeek / Kimi / 硅基流动 / 通义千问，或改用带本地服务的版本。');
      }
      throw e;
    }
  } else {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    j = await r.json();
    if (j.error) throw new Error(j.detail ? `${j.error}：${String(j.detail).slice(0, 300)}` : j.error);
  }
  return (j && j.content) || '（接口没返回内容）';
}

async function loadMeta() {
  const m = DATA
    ? { worlds: DATA.worlds, characters: DATA.characters }
    : await (await fetch('/api/meta')).json();
  const w = $('world'), ch = $('character');
  w.innerHTML = m.worlds.map((x) => `<option value="${x.id}">${x.title}</option>`).join('');
  ch.innerHTML = m.characters.map((x) => `<option value="${x.id}">${x.name}</option>`).join('');
  const c = cfg();
  if (c.world) w.value = c.world;
  if (c.character) ch.value = c.character;
  w.onchange = () => { saveCfg({ world: w.value }); syncHead(); };
  ch.onchange = () => { saveCfg({ character: ch.value }); syncHead(); };
  syncHead();
}

function syncHead() {
  const c = cfg();
  const w = $('world'), ch = $('character');
  const wname = w.options[w.selectedIndex]?.text || '尚未选世界';
  const cname = ch.options[ch.selectedIndex]?.text || '尚未选角色';
  $('headTag').textContent = `旁白 · ${c.persona || '原著旁白'}`;
  if (!state.bundle) {
    $('worldTitle').textContent = wname;
    $('statusLine').textContent = `${cname} · 未开局`;
  }
  $('connDot').className = 'dot' + (c.api_key && c.base_url && c.model ? ' ok' : '');
  $('connDot').title = c.api_key ? '接口已填写' : '未设置接口';

  const ready = !!(c.base_url && c.model && c.api_key);
  const btn = $('btnSet');
  btn.classList.toggle('attention', !ready || !c.verified);
  $('cfgLabel').textContent = !ready
    ? '模型接口 · 未设置'
    : (c.verified ? '模型接口 · 已连接' : '模型接口 · 待验证');
}

async function loadBundle() {
  if (DATA) {
    const w = $('world').value, p = cfg().persona || '原著旁白';
    state.bundle = {
      system_prompt: DATA.system_prompt,
      framework: DATA.framework,
      persona: DATA.personas[p] || DATA.personas['原著旁白'] || '',
      canon: DATA.canon[w] || [],
      card: DATA.cards[$('character').value] || '',
      world: w,
      character: $('character').value,
    };
    return;
  }
  const q = new URLSearchParams({
    world: $('world').value, character: $('character').value,
    persona: cfg().persona || '原著旁白',
  });
  const j = await (await fetch('/api/bundle?' + q)).json();
  if (j.error) throw new Error(j.error);
  state.bundle = j;
}

/* ---------- 流程 ---------- */

async function start() {
  try {
    setBusy(true);
    await loadBundle();
    saveCfg({ world: $('world').value, character: $('character').value });
    state.msgs = [];
    state.summary = store.get(LS.summary) || '';
    store.set(LS.log, '[]');
    $('log').innerHTML = '';
    const wsel = $('world');
    $('worldTitle').textContent = wsel.options[wsel.selectedIndex]?.text || state.bundle.world;
    $('statusLine').textContent = `第 1 场 · ${state.bundle.canon.length} 份设定集已装载`;
    syncHead();
    $('statusLine').textContent = `第 1 场 · ${state.bundle.canon.length} 份设定集已装载`;
    push('system', `已装载：${state.bundle.canon.length} 份设定集｜角色：${state.bundle.character || '—'}｜人设：${cfg().persona || '原著旁白'}`);
    const row = placeholder('……');
    const content = await chat([
      { role: 'system', content: buildSystem() },
      { role: 'user', content: '（开局。按约定先问三问，不要写场景。）' },
    ]);
    row.remove();
    push('assistant', content);
    remember({ role: 'user', content: '（开局）' });
  } catch (e) {
    document.querySelector('.pending')?.remove();
    push('system', '失败：' + e.message);
  } finally {
    setBusy(false);
  }
}

function remember(m) { state.msgs.push({ ...m, ghost: true }); }

async function send() {
  const text = $('input').value.trim();
  if (!text || state.busy) return;
  if (!state.bundle) { await start(); }
  $('input').value = '';
  push('user', text);
  const row = placeholder('……');
  try {
    const msgs = [
      { role: 'system', content: buildSystem() },
      ...state.msgs.filter((m) => !m.ghost && m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    ];
    const content = await chat(msgs);
    row.remove();
    push('assistant', content);
    $('input').focus();
  } catch (e) {
    row.remove();
    push('system', '失败：' + e.message);
  } finally {
    setBusy(false);
  }
}

async function settle() {
  if (!state.msgs.length) return;
  try {
    setBusy(true);
    const row = placeholder('结算中……');
    const msgs = [
      { role: 'system', content: buildSystem() },
      ...state.msgs.filter((m) => !m.ghost && m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: '（结算本场。不要文学描写，只按四件事给摘要：1 角色档变了什么；2 行动线（最多两条，含“如果不做会怎样”）；3 预期板：原著本来要发生的事现在是未到/提前/挡住/改形/照旧；4 一句世界线。用短条目。）' },
    ];
    const content = await chat(msgs);
    row.remove();
    state.summary = (state.summary ? state.summary + '\n\n---\n\n' : '') + content;
    store.set(LS.summary, state.summary);
    push('system', '【结算】\n' + content);
  } catch (e) {
    document.querySelector('.pending')?.remove();
    push('system', '失败：' + e.message);
  } finally {
    setBusy(false);
  }
}

function exportMd() {
  const b = state.bundle;
  const head = `# 小说带入器 · 对话记录\n\n世界：${b ? b.world : '—'}　角色：${b ? b.character : '—'}　时间：${new Date().toLocaleString('zh-CN')}\n\n---\n\n`;
  const body = state.msgs.map((m) => `**${m.role === 'user' ? '你' : m.role === 'assistant' ? '旁白' : '系统'}**\n\n${m.content}\n`).join('\n');
  const blob = new Blob([head + body], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `带入记录-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 设置 ---------- */

function openDrawer(show = true) {
  const c = cfg();
  $('base').value = c.base_url || '';
  $('model').value = c.model || '';
  $('key').value = c.api_key || '';
  $('temp').value = c.temperature ?? 0.8;
  $('tval').textContent = c.temperature ?? 0.8;
  $('persona').value = c.persona || '原著旁白';
  $('testinfo').textContent = '';
  $('drawer').hidden = !show;
}

async function saveAndTest() {
  const patch = {
    base_url: $('base').value.trim().replace(/\/+$/, ''),
    model: $('model').value.trim(),
    api_key: $('key').value.trim(),
    temperature: Number($('temp').value),
    persona: $('persona').value,
  };
  try {
    store.set(LS.cfg, JSON.stringify({ ...cfg(), ...patch, verified: false }));
    syncHead();
  } catch (e) {
    $('testinfo').textContent = '保存失败：' + e.message;
    return;
  }
  if (!patch.base_url || !patch.model || !patch.api_key) {
    $('testinfo').textContent = '三项还没填全（地址、模型名、Key）。';
    return;
  }
  $('testinfo').textContent = '测试中……';
  try {
    const content = await chat([{ role: 'user', content: '只回两个字：可用' }]);
    store.set(LS.cfg, JSON.stringify({ ...cfg(), verified: true }));
    $('testinfo').textContent = '接口通了：' + content.slice(0, 40);
    $('connDot').className = 'dot ok';
    syncHead();
    setTimeout(() => { $('drawer').setAttribute('hidden', ''); }, 700);
  } catch (e) {
    $('testinfo').textContent = '不通：' + e.message;
  }
}

/* ---------- 绑定 ---------- */

window.addEventListener('error', (e) => {
  const t = document.getElementById('hint');
  if (t) { t.style.color = '#c4594a'; t.textContent = '页面出错：' + (e.message || e.type); }
});

window.addEventListener('DOMContentLoaded', async () => {
  $('btnSend').onclick = send;
  $('btnStart').onclick = start;
  $('btnSettle').onclick = settle;
  $('btnExport').onclick = exportMd;
  $('btnSet').onclick = () => openDrawer(true);
  $('btnClose').onclick = () => openDrawer(false);
  $('btnSave').onclick = saveAndTest;
  $('temp').oninput = () => { $('tval').textContent = $('temp').value; };
  $('preset').onchange = () => {
    const v = $('preset').value;
    if (!v) return;
    const [b, m] = v.split('|');
    $('base').value = b; $('model').value = m;
  };
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('input').addEventListener('input', () => {
    const el = $('input'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  });

  await loadMeta();
  const c = cfg();
  const ready = !!(c.base_url && c.model && c.api_key);
  if (!ready) {
    openDrawer(true);
  } else if (!c.verified) {
    openDrawer(true);
    $('testinfo').textContent = '上次保存后没验证通过，点「保存并测试」确认一次。';
  }
  $('input').focus();
});

