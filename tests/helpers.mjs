// 回帰テストの補助（Node 標準機能だけ: node:fs / node:vm / node:url）。
// index.html を直接読んで検証する。実データ・実APIキー・絶対パス・外部通信は使わない（fetch は常に例外）。
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../index.html', import.meta.url));
export const readIndex = () => fs.readFileSync(INDEX, 'utf8');

// 架空のキー（文字列を連結で作り、リポのどこにも鍵の形の文字列を書かない）
export const DUMMY_KEY = ['sk', 'ant', 'DUMMY', 'NOT', 'REAL'].join('-');
export const KEY = 'meishi_crm_v1';

// vm の中で作られたオブジェクトは Object.prototype が別物なので、比較の前に素の JSON に直す
export const plain = (v) => JSON.parse(JSON.stringify(v));

const CORE_RE = /\/\* ===== backup-core ===== \*\/([\s\S]*?)\/\* ===== \/backup-core ===== \*\//;

export function coreSource() {
  const m = readIndex().match(CORE_RE);
  if (!m) throw new Error('backup-core のマーカーが index.html に見つかりません');
  return m[1];
}

// 純関数ブロックだけを、DOM も localStorage も無い空の vm で評価する。
// uid() だけは index.html 側の関数なので、決定的な代用品を渡す。
export function loadCore() {
  let n = 0;
  const ctx = vm.createContext({ uid: () => 'g' + (++n) });
  vm.runInContext('"use strict";\n' + coreSource(), ctx);
  return ctx;
}

// index.html の <script> 全体を、DOM・localStorage のスタブつき vm で実行する。
// seed: 起動前に localStorage[KEY] へ入れる値（オブジェクトなら JSON 化、文字列ならそのまま）
// confirmAnswer: true／false／関数（確認文を受け取って true/false を返す。確認中に別タブが書き換える状況を作れる）
export function loadApp({ seed, confirmAnswer = true } = {}) {
  const store = new Map();
  if (seed !== undefined) store.set(KEY, typeof seed === 'string' ? seed : JSON.stringify(seed));
  // log.sets: 実際に保存された書き込みの回数。log.setCalls: 書き込みを試みた回数。log.delays: setTimeout に渡した待ち時間。
  const log = { toasts: [], downloads: [], confirms: [], alerts: [], sets: 0, setCalls: 0, delays: [] };
  // ctl.onSet(key, value, n): 保存の失敗を作る。'throw'＝例外／'drop'＝黙って保存しない／{store:値}＝別の値を黙って保存／未返却＝通常。ctl.failGet: 読み取りが例外になる環境
  const ctl = { onSet: null, failGet: false, confirm: null, deferRead: false, readError: false };
  const pendingReads = []; // ctl.confirm(確認文): 実行中に確認の返答を差し替える
  const blobs = new Map();
  const els = new Map();

  class Blob {
    constructor(parts) { this.text = parts.join(''); }
  }
  class El {
    constructor(id, tag) {
      this.id = id; this.tag = tag; this.style = {}; this.dataset = {}; this.value = '';
      this.innerHTML = ''; this.hidden = false; this.files = []; this._h = {}; this._text = '';
      this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    }
    set textContent(v) { this._text = String(v); if (this.id === 'toast') log.toasts.push(this._text); }
    get textContent() { return this._text; }
    addEventListener(type, fn) { (this._h[type] ||= []).push(fn); }
    click() { if (this.tag === 'a' && this.download) log.downloads.push({ name: this.download, text: blobs.get(this.href) }); }
    appendChild() {} remove() {} setAttribute() {}
    closest() { return null; }
    querySelector() { return new El('', 'div'); }
    querySelectorAll() { return []; }
  }
  const document = {
    body: new El('body', 'body'),
    getElementById(id) { if (!els.has(id)) els.set(id, new El(id, 'div')); return els.get(id); },
    createElement(tag) { return new El('', tag); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const localStorage = {
    getItem: (k) => { if (ctl.failGet) throw new Error('SecurityError'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => {
      log.setCalls++;
      const act = ctl.onSet ? ctl.onSet(k, String(v), log.setCalls) : undefined;
      if (act === 'throw') throw new Error('QuotaExceededError');
      if (act === 'drop') return;
      if (act && typeof act === 'object') { store.set(k, act.store); return; }
      log.sets++; store.set(k, String(v));
    },
    removeItem: (k) => { store.delete(k); },
  };
  // 既定は同期で読み込み完了。ctl.deferRead＝flushReads() まで読み込み完了を遅らせる／ctl.readError＝読み込みに失敗する
  class FileReader {
    readAsText(f) {
      if (ctl.readError) { if (this.onerror) this.onerror(); return; }
      const done = () => { this.result = f.text; if (this.onload) this.onload(); };
      if (ctl.deferRead) pendingReads.push(done); else done();
    }
  }
  const URL = {
    createObjectURL(b) { const u = 'blob:' + blobs.size; blobs.set(u, b.text); return u; },
    revokeObjectURL() {},
  };
  const ctx = vm.createContext({
    document, localStorage, Blob, URL, FileReader, console,
    window: { scrollTo() {}, open() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    confirm: (m) => { log.confirms.push(String(m)); if (ctl.confirm) return ctl.confirm(String(m)); return typeof confirmAnswer === 'function' ? confirmAnswer(String(m)) : confirmAnswer; },
    alert: (m) => { log.alerts.push(String(m)); },
    fetch: () => { throw new Error('network is disabled in tests'); },
    setTimeout: (fn, ms) => { log.delays.push(ms); return 0; }, clearTimeout() {},
  });
  const html = readIndex();
  if ((html.match(/<script/g) || []).length !== 1) throw new Error('<script> が 1 つではありません。helpers.mjs の取り出し方を見直してください');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInContext(script, ctx);
  return {
    run: (code) => vm.runInContext(code, ctx),
    call: (name, ...args) => ctx[name](...args), // index.html の関数宣言（トップレベル）を直接呼ぶ
    log, ctl, store, els,
    // JSON 復元の <input type=file> の change を、ファイルの中身（文字列）で起こす
    pickRestoreFile(text, lastModified) {
      const target = { files: [{ text, lastModified }], value: 'x' };
      els.get('impJson')._h.change[0]({ target });
      return target; // 同じファイルをもう一度選べるように value が空に戻ったかを見るため
    },
    flushReads() { while (pendingReads.length) pendingReads.shift()(); },
  };
}
