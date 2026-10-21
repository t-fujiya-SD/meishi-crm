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

// ---------- S2 の小さな変更 ----------
test('toast: 長い文は表示時間を延ばす（15字以下は 2 秒・上限 8 秒）', () => {
  const app = loadApp({ seed: makeDb() });
  const delay = (m) => { app.log.delays.length = 0; app.call('toast', m); return app.log.delays[0]; };
  assert.equal(delay('保存しました'), 2000);
  assert.equal(delay('あ'.repeat(15)), 2000);
  assert.equal(delay('あ'.repeat(20)), 3000);
  assert.equal(delay('あ'.repeat(40)), 6000);
  assert.equal(delay('あ'.repeat(100)), 8000);
  assert.equal(delay('あ'), 2000);
  app.log.delays.length = 0; app.call('toast', 'あ', 500);
  assert.equal(app.log.delays[0], 500, 'ms を渡せばそのとおり');
});

test('.ics: CR・CRLF・LF はどれも \\n にエスケープされ、行が増えない。通常の本文は従来どおり', () => {
  const app = loadApp({ seed: makeDb() });
  const ics = (title, desc) => { app.call('downloadICS', title, '2026-03-01T09:00', desc); const d = app.log.downloads; return d[d.length - 1].text; };
  const text = ics('名前\rATTENDEE:mailto:x@example.invalid', '本文\rBEGIN:VALARM\r\nACTION:EMAIL\nURL:x');
  const lines = text.split('\r\n');
  lines.forEach((l) => assert.equal(/[\r\n]/.test(l), false, '行の中に改行が残らない'));
  assert.equal(lines.length, 16, '通常の .ics と同じ行数');
  assert.ok(lines.includes('SUMMARY:名前\\nATTENDEE:mailto:x@example.invalid'));
  assert.ok(lines.includes('DESCRIPTION:本文\\nBEGIN:VALARM\\nACTION:EMAIL\\nURL:x'));
  const plainText = ics('タイトル', '一行目\n二行目;三,四\\');
  assert.ok(plainText.split('\r\n').includes('DESCRIPTION:一行目\\n二行目\\;三\\,四\\\\'), '既存のエスケープは不変');
});

test('normalizeSettings(d): 引数のオブジェクトを整える。引数なしは従来どおり db を整える', () => {
  const app = loadApp({ seed: makeDb() });
  const d = { contacts: [] };
  app.call('normalizeSettings', d);
  assert.equal(d.settings.model, 'claude-opus-4-8');
  assert.deepEqual(plain(d.scheduled), []);
  assert.ok(Array.isArray(d.settings.myCards) && Array.isArray(d.settings.templates));
  assert.equal(d.settings.templatesV, 3);
  app.run('db.scheduled=undefined;db.settings.myName=null');
  app.call('normalizeSettings');
  assert.deepEqual(plain(app.run('db.scheduled')), []);
  assert.equal(app.run('db.settings.myName'), '');
});

test('S2: sanitizeContact は削除した。str は変更しない（呼び出しが無くなっても残す）', () => {
  const app = loadApp({ seed: makeDb() });
  assert.equal(app.run('typeof sanitizeContact'), 'undefined');
  assert.equal(app.run('typeof str'), 'function');
  assert.equal(app.run('str(5)'), '5');
  assert.equal(app.run('str(null)'), '');
});

test('exportJSON: 書き出した時点の保存値を exportedRaw に記録する（書き出し操作をしたという目印。保存完了の証拠ではない）', () => {
  const app = loadApp({ seed: makeDb() });
  assert.equal(app.run('exportedRaw'), null);
  app.run('exportJSON()');
  assert.equal(app.run('exportedRaw'), app.store.get(KEY));
});

// ---------- 静的な確認 ----------
const count = (src, re) => (src.match(re) || []).length;

test('静的: 外部通信・CSP・localStorage の使い方が増えていない', () => {
  const src = readIndex();
  assert.equal(count(src, /\bfetch\(/g), 1, 'fetch は callClaude の 1 か所だけ');
  // 読むのは load() と readRaw()（復元・exportedRaw・戻すが使う）、書くのは save() だけ。復元の書き込みは commitRaw（storage を引数で受ける）経由。
  // S3 で load()/save() を作り直すときは、この個数を意図して更新する。
  assert.equal(count(src, /localStorage\.getItem\(/g), 2);
  assert.equal(count(src, /localStorage\.setItem\(/g), 1);
  assert.equal(count(src, /localStorage\s*[.\[]/g), 3, 'localStorage を直接触るのは load()・readRaw()・save() だけ');
  assert.equal(count(src, /commitRaw\(localStorage,KEY,/g), 2, '復元と戻す操作の書き込みだけが commitRaw を使う');
  assert.equal(count(src, /sessionStorage|indexedDB|document\.cookie|location\.(href|assign|replace)|\bimport\(/g), 0);
  assert.equal(count(src, /window\.open\(/g), 1, 'LINE 共有の 1 か所だけ');
  assert.equal(count(src, /XMLHttpRequest|WebSocket|sendBeacon|importScripts|<iframe|<img[^>]+src=["']https?:/g), 0);
  assert.equal(count(src, /new Image\(/g), 1, 'new Image は名刺画像の縮小（resizeImage）の 1 か所だけ');
  assert.ok(src.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src https://api.anthropic.com; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`), 'CSP を変えていない');
});

test('静的: load() / save() を変えていない（S3 で意図して変えるときはこのテストを更新する）', () => {
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
