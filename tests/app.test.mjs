// index.html 全体を DOM・localStorage スタブの vm で実行して確かめる回帰テスト。
// 実行: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadApp, loadCore, readIndex, coreSource, plain, DUMMY_KEY, KEY } from './helpers.mjs';
import { NOW, counter, makeDb, legacyGenerations } from './fixtures.mjs';

const lastToast = (app) => app.log.toasts[app.log.toasts.length - 1];
const exported = (app) => { app.run('exportJSON()'); const d = app.log.downloads; return { file: d[d.length - 1], json: JSON.parse(d[d.length - 1].text) }; };

// ---------- 書き出し（S1） ----------
test('exportJSON: v2 の封筒で書き出し、APIキーは含まない', () => {
  const app = loadApp({ seed: makeDb() });
  assert.equal(app.run('db.settings.apiKey'), DUMMY_KEY, 'アプリ自身は従来どおりキーを持つ');
  assert.ok(app.store.get(KEY).includes(DUMMY_KEY), '保存値の仕様は従来どおり（S1 では変えない）');
  const t0 = Date.now();
  const { file, json } = exported(app);
  const t1 = Date.now();
  assert.match(file.name, /^meishi-crm_\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(json.format, 'meishi-crm-backup');
  assert.equal(json.version, 2);
  assert.match(json.exportedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const at = Date.parse(json.exportedAt);
  assert.ok(at >= t0 - 1 && at <= t1 + 1, 'exportedAt は書き出した時刻');
  assert.deepEqual(Object.keys(json.data), ['contacts', 'scheduled', 'settings']);
  assert.equal(file.text.includes(DUMMY_KEY), false);
  assert.equal(file.text.includes('apiKey'), false);
});

test('exportJSON: id を変えない（連絡先・接点・予約・立場・テンプレ）', () => {
  const db = makeDb();
  const app = loadApp({ seed: db });
  const { json } = exported(app);
  assert.deepEqual(json.data.contacts, plain(db.contacts));
  assert.deepEqual(json.data.scheduled, plain(db.scheduled));
  assert.deepEqual(json.data.settings.myCards, plain(db.settings.myCards));
  assert.deepEqual(json.data.settings.templates, plain(db.settings.templates));
  assert.equal(json.data.settings.templatesV, 3);
});

test('exportJSON: ヘッダの書き出しボタンも同じ関数。書き出しトーストは完了や安全を断定しない文言に固定', () => {
  const app = loadApp({ seed: makeDb() });
  const btn = app.els.get('btnBackup');
  assert.equal(typeof btn.onclick, 'function');
  btn.onclick();
  assert.equal(app.log.downloads.length, 1);
  // 文言は完全一致で固定する（「バックアップ済み」「安全に保存されています」などと断定する言い換えを防ぐ）。変えるときは意図して更新する。
  assert.equal(lastToast(app), '書き出しました（顧客情報を含みます）');
});

test('exportJSON: 許可リスト外の設定項目（将来足された秘密など）は出ない', () => {
  const db = makeDb();
  db.settings.futureSecret = 'zzz';
  const app = loadApp({ seed: db });
  const { file } = exported(app);
  assert.equal(file.text.includes('futureSecret'), false);
  assert.equal(file.text.includes('zzz'), false);
});

test('exportJSON: 全データ削除の直後の形（scheduled が無い）でも書き出せる', () => {
  const app = loadApp({ seed: legacyGenerations().afterWipe });
  const { json } = exported(app);
  assert.deepEqual(json.data.contacts, []);
  assert.deepEqual(json.data.scheduled, []);
});

test('exportJSON: 書き出した内容を parseBackup で読み戻すと元に戻る（APIキー以外）', () => {
  const db = makeDb();
  const app = loadApp({ seed: db });
  const { file } = exported(app);
  const core = loadCore();
  const r = core.parseBackup(file.text, { nowIso: NOW, newId: counter('x'), currentSettings: { apiKey: 'CUR' } });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'v2');
  assert.deepEqual(plain(r.db.contacts), plain(db.contacts));
  assert.deepEqual(plain(r.db.scheduled), plain(db.scheduled));
  assert.equal(r.db.settings.apiKey, 'CUR');
  assert.equal(r.report.skipped.scheduled.total, 0);
});

// ---------- S1 では復元の実動作を変えない ----------
// 以下の2件は S1 時点の既存挙動の固定。S2 で復元を作り直すときに、意図した変更として更新する。
test('S1: 既存の JSON 復元は、v2 の封筒を読み込めないものとして断る（保存値は変わらない）', () => {
  const app = loadApp({ seed: makeDb() });
  const { file } = exported(app);
  const before = plain(app.run('db'));
  const sets = app.log.sets;
  app.pickRestoreFile(file.text);
  assert.match(lastToast(app), /読み込めませんでした/);
  assert.deepEqual(plain(app.run('db')), before);
  assert.equal(app.log.sets, sets, '保存値を書き換えない');
  assert.equal(app.log.confirms.length, 0);
});

test('S1: 既存の JSON 復元は旧形式をこれまでどおり読む', () => {
  const app = loadApp({ seed: makeDb() });
  const sets = app.log.sets;
  app.pickRestoreFile(JSON.stringify(legacyGenerations().gen4));
  assert.equal(app.log.confirms.length, 1);
  assert.match(lastToast(app), /復元しました/);
  assert.equal(app.run('db.contacts.length'), 2);
  assert.equal(app.log.sets, sets + 1, '復元は保存値を1回書く');
  const stored = JSON.parse(app.store.get(KEY));
  assert.equal(stored.contacts.length, 2);
  assert.equal(stored.settings.apiKey, DUMMY_KEY, '既存の復元はファイルのキーを書き戻す（S2 で「現在のキーを保つ」に変える）');
  assert.equal(stored.settings.myCards[0].label, '屋号A');
  assert.equal(stored.settings.model, 'claude-opus-4-8');
});

// ---------- 静的な確認 ----------
const count = (src, re) => (src.match(re) || []).length;

test('静的: 外部通信・CSP・localStorage の使い方が増えていない', () => {
  const src = readIndex();
  assert.equal(count(src, /\bfetch\(/g), 1, 'fetch は callClaude の 1 か所だけ');
  // S2 で復元の書込み・読み戻し・exportedRaw などで localStorage を読み書きするときは、この個数を意図して更新する。
  assert.equal(count(src, /localStorage\.getItem\(/g), 1);
  assert.equal(count(src, /localStorage\.setItem\(/g), 1);
  assert.equal(count(src, /localStorage\s*[.\[]/g), 2, 'localStorage に触るのは load() と save() だけ（getItem と setItem）');
  assert.equal(count(src, /sessionStorage|indexedDB|document\.cookie|location\.(href|assign|replace)|\bimport\(/g), 0);
  assert.equal(count(src, /window\.open\(/g), 1, 'LINE 共有の 1 か所だけ');
  assert.equal(count(src, /XMLHttpRequest|WebSocket|sendBeacon|importScripts|<iframe|<img[^>]+src=["']https?:/g), 0);
  assert.equal(count(src, /new Image\(/g), 1, 'new Image は名刺画像の縮小（resizeImage）の 1 か所だけ');
  assert.ok(src.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src https://api.anthropic.com; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`), 'CSP を変えていない');
});

test('静的: S1 は load() / save() を変えていない（S3 で意図して変えるときはこのテストを更新する）', () => {
  const src = readIndex();
  assert.ok(src.includes('function load(){\n  try{const r=JSON.parse(localStorage.getItem(KEY)); if(r&&r.contacts) return r;}catch(e){}\n  return {contacts:[], settings:{apiKey:"",model:"claude-opus-4-8"}};\n}'));
  assert.ok(src.includes('function save(){try{localStorage.setItem(KEY, JSON.stringify(db));return true;}catch(e){toast("保存できませんでした（容量オーバー等）");return false;}}'));
});

test('静的: backup-core は DOM・localStorage・通信・乱数・現在時刻に直接触れない', () => {
  const core = coreSource();
  for (const re of [/localStorage/, /\bdocument\b/, /\bwindow\b/, /\bfetch\b/, /Math\.random/, /Date\.now/, /https?:\/\//, /\bconsole\./, /\beval\b/, /new Function/]) {
    assert.equal(re.test(core), false, String(re));
  }
  // S2 で commitRaw、S3 で classifyStored を足すときは、この上限を意図して見直す。
  assert.ok(core.split('\n').length < 250, '小さな純関数ブロックに保つ');
});

test('静的: 注意書き2か所に、このバージョンの書き出しの範囲を限った言い方でキーの扱いを書いている', () => {
  const src = readIndex();
  assert.ok(src.includes('このバージョンで書き出すJSONにはキーを含みません（以前に書き出したファイルには入っていることがあります）'));
  assert.ok(src.includes('このバージョンの書き出しにAPIキーは含みませんが、顧客情報が入るため保管にご注意ください'));
});

test('テスト自身: 絶対パス・鍵の形の文字列・実在らしい連絡先を含めない', () => {
  const dir = fileURLToPath(new URL('./', import.meta.url));
  const banned = [['/Us', 'ers/'], ['/pri', 'vate/'], ['/ho', 'me/'], ['C:', '\\'], ['sk', '-ant-'], ['@gmail', '.com'], ['@yahoo', '.co.jp']].map((p) => p.join(''));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const body = fs.readFileSync(dir + f, 'utf8');
    for (const b of banned) assert.equal(body.includes(b), false, f + ' に ' + b);
  }
});
