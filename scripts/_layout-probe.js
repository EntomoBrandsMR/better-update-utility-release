// _layout-probe.js — attach over raw CDP (Node's built-in fetch + WebSocket, no deps)
// and MEASURE the layout instead of reading CSS and guessing.
'use strict';
(async () => {
  const list = await (await fetch('http://localhost:9222/json/list')).json();
  const t = list.find(x => (x.url || '').includes('index.html') && x.type === 'page');
  if (!t) { console.log('no index.html target. targets: ' + list.map(x => x.type + ':' + x.url).join(' | ')); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const expr = `(() => {
    const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; };
    const out = { viewport: window.innerWidth };
    const shell = document.querySelector('.shell');
    out.shellRect = shell ? R(shell) : null;
    out.shellDisplay = shell ? getComputedStyle(shell).display : null;
    out.shellChildren = shell ? [...shell.children].map(el => {
      const cs = getComputedStyle(el);
      return { tag: el.tagName, id: el.id || null, cls: String(el.className).slice(0,40) || null,
               rect: R(el), display: cs.display, flex: cs.flex, width: cs.width, position: cs.position };
    }) : [];
    const c = document.getElementById('mainContent');
    if (c) {
      const cs = getComputedStyle(c);
      out.content = { rect: R(c), display: cs.display, flex: cs.flex, flexDirection: cs.flexDirection,
                      alignItems: cs.alignItems, justifyContent: cs.justifyContent, direction: cs.direction, textAlign: cs.textAlign };
      out.contentChildren = [...c.children].map(el => {
        const s = getComputedStyle(el);
        return { id: el.id || null, cls: String(el.className).slice(0,30), rect: R(el), display: s.display,
                 marginLeft: s.marginLeft, float: s.float, position: s.position, width: s.width };
      });
    }
    const act = document.querySelector('.panel.active');
    if (act) {
      const s = getComputedStyle(act);
      out.activePanel = { id: act.id, rect: R(act), display: s.display, marginLeft: s.marginLeft,
                          maxWidth: s.maxWidth, float: s.float, position: s.position, left: s.left, transform: s.transform };
    }
    return JSON.stringify(out);
  })()`;
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 1) {
      const v = m.result && m.result.result && m.result.result.value;
      if (!v) { console.log('EVAL ERR: ' + JSON.stringify(m).slice(0, 600)); process.exit(1); }
      console.log(JSON.stringify(JSON.parse(v), null, 2));
      ws.close(); process.exit(0);
    }
  };
  ws.onerror = (e) => { console.log('WS ERR: ' + (e.message || e)); process.exit(1); };
  setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);
})().catch(e => { console.log('PROBE FAILED: ' + e.message); process.exit(1); });
