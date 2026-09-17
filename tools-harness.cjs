// tools-harness.js — run the dashboard headlessly.
//
//   node tools-harness.cjs
//
// Boots the real index.html script against a stub DOM, serves it the demo
// mock's data, then clicks through the Grading tab: every pill, every subgrade,
// both Activity halves, and each other tab. Any exception prints with a stack.
//
// This exists because nine faults on the Grading tab were diagnosed one
// screenshot at a time, and several of them -- a TypeError in the render
// reported as a load failure, a note written into a hidden element, four
// correct responses discarded by a bad lookup -- would have shown up here in
// seconds. Reasoning about the code kept producing plausible wrong answers.
//
// Caveat: the stub DOM is deliberately thin. The Orders tab throws on
// `insertBefore` here because the stub's querySelector returns null for a
// panel anchor -- that is the harness, not the app. Grading, Cards, Review,
// Card Type and Recomp all run clean.

// Headless harness: run the real app script against a stub DOM and the demo
// mock's data, so the Grading tab can actually be exercised instead of reasoned
// about. Any exception surfaces here with a stack.
const fs = require('fs');
const path = require('path');
const IDX  = path.join(__dirname, 'public', 'index.html');
const DEMO = path.join(__dirname, 'public', 'demo.html');
const html = fs.readFileSync(IDX, 'utf8');
const app  = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const mock = fs.readFileSync(DEMO, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

// ---- element stub -------------------------------------------------------
const nodes = new Map();
function mkEl(id, cls) {
  const el = {
    id: id || '', className: cls || '', hidden: false, disabled: false,
    value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    _attrs: {}, children: [],
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, insertBefore() {}, cloneNode() { return mkEl(); },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null }, contains() { return false },
    focus() {}, blur() {}, click() { if (this.onclick) this.onclick({}); },
    getBoundingClientRect() { return {top:0,left:0,width:0,height:0,bottom:0,right:0}; },
    insertAdjacentHTML() {}, scrollIntoView() {},
    get firstChild() { return this.children[0] || null; },
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false } },
  };
  return el;
}
const byId = id => {
  if (!nodes.has(id)) nodes.set(id, mkEl(id));
  return nodes.get(id);
};
// classes the app queries for
const CLASS_SETS = {
  '.railhint': [mkEl('', 'railhint')],
  '[data-not-orders]': [mkEl(), mkEl(), mkEl()],
  '.filters select': [], '.csel': [], '.msel': [],
};
global.document = {
  getElementById: byId,
  querySelector: sel => (CLASS_SETS[sel] && CLASS_SETS[sel][0]) || null,
  querySelectorAll: sel => CLASS_SETS[sel] || [],
  createElement: () => mkEl(),
  createTextNode: () => mkEl(),
  addEventListener() {}, removeEventListener() {},
  body: mkEl('body'), documentElement: mkEl('html'),
  hidden: false, visibilityState: 'visible',
};
global.window = {
  location: { hostname: 'local', search: '', href: 'http://local/' },
  addEventListener() {}, removeEventListener() {}, matchMedia: () => ({matches:false, addEventListener(){}}),
  getComputedStyle: () => ({ getPropertyValue: () => '#838CC8' }),
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  console,
};
global.getComputedStyle = global.window.getComputedStyle;
global.localStorage = global.window.localStorage;
global.navigator = { userAgent: 'node', clipboard: { writeText(){} } };
global.MutationObserver = class { observe(){} disconnect(){} };
global.requestAnimationFrame = fn => setTimeout(fn, 0);
// The app installs polling intervals (shared state, rollover). Left live they
// keep the event loop alive forever and the harness never exits.
const realSetTimeout = setTimeout;
global.setInterval = () => 0;
global.clearInterval = () => {};
realSetTimeout(() => { console.log('\n[harness] hard stop'); process.exit(0); }, 15000);

// ---- data: the demo mock's ticker ---------------------------------------
const mwin = { location:{hostname:'',search:''}, addEventListener(){}, console };
(function(){
  const sandbox = { window: mwin, document: global.document, location: mwin.location,
                    navigator: global.navigator, console, setTimeout,
                    fetch: () => Promise.reject(new Error('x')) };
  const keys = Object.keys(sandbox);
  new Function(...keys, mock.replace(/\}\)\(\);?\s*$/, 'globalThis.__ticker = ticker; })();'))
    (...keys.map(k => sandbox[k]));
})();

let CALLS = [];
global.fetch = (url) => {
  CALLS.push(url);
  const qs = new URLSearchParams(String(url).split('?')[1] || '');
  let rows = [];
  try { rows = globalThis.__ticker(qs) || []; } catch (e) { rows = []; }
  return Promise.resolve({
    ok: true, status: 200,
    headers: { get: (h) => ({
      'X-Metabase-Card-Id': '39638', 'X-Metabase-Transport': 'query/json',
      'X-Metabase-Params': 'start_date=2026-09-16,end_date=2026-09-16,grain=day',
      'X-Metabase-Rows': String(rows.length),
    }[h] ?? null) },
    json: () => Promise.resolve(rows),
    text: () => Promise.resolve(JSON.stringify(rows)),
  });
};

// ---- run ----------------------------------------------------------------
const exported = app.replace(/\}\)\(\);?\s*$/,
  'globalThis.__app = {setTab:setTab, setGradingPill:setGradingPill, ' +
  'setGradingAct:setGradingAct, setGradingSubgrade:setGradingSubgrade, ' +
  'loadGradingActivity:loadGradingActivity, renderGrading:renderGrading, ' +
  'state:function(){return {gPill:gPill, gAct:gAct, gActSel:gActSel, ' +
  'gActState:gActState, gActErr:gActErr, gActLists:gActLists, grows:grows};}}; })();');

try { new Function(exported)(); console.log('app booted OK'); }
catch (e) { console.log('BOOT THREW:', e.message); console.log(e.stack.split('\n').slice(0,4).join('\n')); process.exit(1); }

(async () => {
  const app_ = globalThis.__app;
  byId('start_date').value = '2026-09-16';
  byId('end_date').value   = '2026-09-16';
  byId('grain').value      = 'day';

  console.log('\n--- setTab("grading") ---');
  try { app_.setTab('grading'); } catch (e) {
    console.log('setTab THREW:', e.message);
    console.log(e.stack.split('\n').slice(0,5).join('\n'));
  }
  await new Promise(r => setTimeout(r, 60));

  const s = app_.state();
  console.log('gPill:', s.gPill, '| gAct:', s.gAct, '| gActState:', s.gActState);
  if (s.gActErr) console.log('gActErr:', s.gActErr);
  console.log('subgrade row counts:',
    Object.fromEntries(Object.entries(s.gActLists).map(([k,v]) => [k, v.length])));
  console.log('grows (merged):', s.grows.length);
  console.log('g-tot:', byId('g-tot').textContent, byId('g-tot-l').textContent);
  console.log('g-note:', String(byId('g-note').textContent).slice(0, 220));
  console.log('subpills html len:', byId('g-subpills').innerHTML.length);
  console.log('requests made:', CALLS.length);

  const show = (label) => {
    const st = app_.state();
    console.log(label.padEnd(26)
      + 'state=' + st.gActState
      + ' | tot=' + byId('g-tot').textContent
      + ' | grows=' + st.grows.length
      + (st.gActErr ? '  ERR: ' + st.gActErr : ''));
  };

  console.log('\n--- subgrade pills ---');
  for (const k of ['corner','edge','surface','centering','']) {
    try { app_.setGradingSubgrade(k); } catch (e) {
      console.log((k||'all').padEnd(26) + 'THREW: ' + e.message); continue;
    }
    show(k || 'all');
  }

  console.log('\n--- Grading verify sub-pill ---');
  try { app_.setGradingAct('verify'); } catch (e) { console.log('THREW:', e.message); }
  await new Promise(r => setTimeout(r, 60));
  show('graded -> verify');
  try { app_.setGradingAct('graded'); } catch (e) { console.log('THREW:', e.message); }
  await new Promise(r => setTimeout(r, 60));
  show('back to graded');

  console.log('\n--- snapshot pills ---');
  for (const p of ['queued','verify','activity']) {
    try { app_.setGradingPill(p); } catch (e) {
      console.log(p.padEnd(26) + 'THREW: ' + e.message);
      console.log(e.stack.split('\n').slice(0,3).join('\n')); continue;
    }
    await new Promise(r => setTimeout(r, 60));
    const st = app_.state();
    console.log(p.padEnd(26) + 'tot=' + byId('g-tot').textContent
      + ' ' + byId('g-tot-l').textContent
      + ' | note=' + String(byId('g-note').textContent).slice(0,60));
  }

  console.log('\n--- other tabs still fine ---');
  for (const t of ['cards','review','cardtype','recomp','orders']) {
    try { app_.setTab(t); await new Promise(r => setTimeout(r, 30));
      console.log('  ' + t.padEnd(10) + 'ok');
    } catch (e) { console.log('  ' + t.padEnd(10) + 'THREW: ' + e.message); }
  }
  console.log('\nTOTAL REQUESTS:', CALLS.length);
})();
