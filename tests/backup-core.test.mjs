// backup-core（index.html のマーカー間の純関数）の回帰テスト。
// 実行: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadCore, plain, DUMMY_KEY } from './helpers.mjs';
import { NOW, counter, makeDb, makeContact, makeTemplates, legacyGenerations } from './fixtures.mjs';

const core = loadCore();
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const parse = (v, ctx = {}) => core.parseBackup(text(v), { nowIso: NOW, newId: counter('x'), ...ctx });
const v2 = (data, extra = {}) => ({ format: 'meishi-crm-backup', version: 2, exportedAt: NOW, data, ...extra });
const okParse = (v, ctx) => { const r = parse(v, ctx); assert.equal(r.ok, true, JSON.stringify(r)); return r; };

// ---------- buildBackup（v2 書き出し） ----------
test('buildBackup: v2 の封筒の形になる', () => {
  const b = plain(core.buildBackup(makeDb(), NOW));
  assert.deepEqual(Object.keys(b), ['format', 'version', 'exportedAt', 'data']);
  assert.equal(b.format, 'meishi-crm-backup');
  assert.equal(b.version, 2);
  assert.equal(b.exportedAt, NOW);
  assert.deepEqual(Object.keys(b.data), ['contacts', 'scheduled', 'settings']);
  assert.equal('contacts' in b, false, '最上位に contacts を置かない（旧コードが旧形式と誤認するため）');
});

test('buildBackup: settings は許可リストだけ。APIキーはどこにも出ない', () => {
  const db = makeDb();
  db.settings.futureSecret = 'x'; // 将来足された項目も許可リスト外なので出ない
  const out = JSON.stringify(core.buildBackup(db, NOW));
  assert.equal(out.includes(DUMMY_KEY), false);
  assert.equal(out.includes('apiKey'), false);
  assert.equal(out.includes('futureSecret'), false);
  const s = plain(core.buildBackup(db, NOW)).data.settings;
  assert.deepEqual(Object.keys(s).sort(), ['model', 'myCards', 'myName', 'templates', 'templatesV']);
});

test('buildBackup: id（連絡先・接点・予約・立場・テンプレ）を変えずそのまま出す', () => {
  const db = makeDb();
  const d = plain(core.buildBackup(db, NOW)).data;
  assert.deepEqual(d.contacts, plain(db.contacts));
  assert.deepEqual(d.scheduled, plain(db.scheduled));
  assert.deepEqual(d.settings.myCards, plain(db.settings.myCards));
  assert.deepEqual(d.settings.templates, plain(db.settings.templates));
  assert.deepEqual(d.contacts.map((c) => c.touchpoints.map((t) => t.id)), [['t1a', 't1b'], ['t2a', 't2b']]);
});

test('buildBackup: 元の db を書き換えない', () => {
  const db = makeDb();
  const before = plain(db);
  core.buildBackup(db, NOW);
  assert.deepEqual(plain(db), before);
});

test('buildBackup: 空・欠けた db でも落ちない（全データ削除の直後は scheduled が無い）', () => {
  for (const d of [undefined, null, {}, { contacts: [], settings: {} }, { contacts: 'x', scheduled: 'y', settings: [] }]) {
    const b = plain(core.buildBackup(d, NOW));
    assert.deepEqual(b.data.contacts, []);
    assert.deepEqual(b.data.scheduled, []);
  }
  const wiped = plain(core.buildBackup(legacyGenerations().afterWipe, NOW));
  assert.deepEqual(wiped.data.scheduled, []);
});

// ---------- detectBackup（形式の判別） ----------
test('detectBackup: v2 / legacy', () => {
  assert.equal(core.detectBackup(v2({ contacts: [] })).kind, 'v2');
  assert.equal(core.detectBackup({ contacts: [], settings: {} }).kind, 'legacy');
  assert.equal(core.detectBackup({ contacts: [] }).kind, 'legacy', 'settings が無くても legacy');
});

test('detectBackup: version は 2 だけ受理（1・小数・文字列・欠落は受理しない）', () => {
  const kind = (version) => core.detectBackup({ format: 'meishi-crm-backup', version, data: { contacts: [] } }).kind;
  assert.equal(kind(2), 'v2');
  assert.equal(kind(1), 'unknown');
  assert.equal(kind(0), 'unknown');
  assert.equal(kind(2.5), 'future', '2 より大きい数値は「新しい版」');
  assert.equal(kind(3), 'future');
  assert.equal(kind('2'), 'unknown');
  assert.equal(kind('3'), 'unknown', '文字列の 3 は「新しい版」にしない');
  assert.equal(kind(undefined), 'unknown');
  assert.equal(kind(null), 'unknown');
  assert.equal(kind(-1), 'unknown');
});

test('detectBackup: format の値違い・data 欠落・不正な形は unknown', () => {
  const ks = (v) => core.detectBackup(v).kind;
  assert.equal(ks({ format: 'other', version: 2, data: { contacts: [] } }), 'unknown');
  assert.equal(ks({ format: 'meishi-crm-backup', version: 2 }), 'unknown');
  assert.equal(ks({ format: 'meishi-crm-backup', version: 2, data: [] }), 'unknown');
  assert.equal(ks({ format: 'meishi-crm-backup', version: 2, data: { contacts: 'x' } }), 'unknown');
  assert.equal(ks({ format: 'other', contacts: [] }), 'unknown', 'format があるのに値が違えば legacy にしない');
  for (const bad of [null, undefined, 1, 'x', true, [], [{ contacts: [] }], { foo: 1 }, { contacts: {} }, { contacts: 'x' }]) {
    assert.equal(ks(bad), 'unknown', JSON.stringify(bad));
  }
});

test('detectBackup: 封筒と最上位 contacts が同居したら封筒（data）を採用する', () => {
  const r = core.detectBackup({ format: 'meishi-crm-backup', version: 2, contacts: [], data: { contacts: [{ name: 'a' }] } });
  assert.equal(r.kind, 'v2');
  assert.equal(r.data.contacts.length, 1);
});

// ---------- parseBackup（文字列の検証・整形） ----------
test('parseBackup: JSON でない・空・途中で切れた・CSV はやめる', () => {
  for (const t of ['', '   ', 'not json', '{"contacts":[', 'a,b,c\n1,2,3', undefined, null, 123]) {
    const r = core.parseBackup(t, { nowIso: NOW });
    assert.deepEqual(plain(r), { ok: false, reason: 'badjson' }, String(t));
  }
});

test('parseBackup: 先頭の BOM は無視する', () => {
  assert.equal(okParse('\uFEFF' + JSON.stringify(v2({ contacts: [makeContact(1)] }))).kind, 'v2');
  assert.equal(okParse('\uFEFF' + JSON.stringify({ contacts: [makeContact(1)] })).kind, 'legacy');
});

test('parseBackup: バックアップではない形と、新しい版は理由を分けて拒否する', () => {
  for (const v of [[], null, 'x', 5, {}, { foo: 1 }, { contacts: 'x' }, v2({ contacts: [] }, { version: 1 }), v2({ contacts: [] }, { version: '2' }), { format: 'other', version: 2, data: {} }]) {
    assert.deepEqual(plain(parse(JSON.stringify(v))), { ok: false, reason: 'notbackup' }, JSON.stringify(v));
  }
  assert.deepEqual(plain(parse(v2({ contacts: [] }, { version: 3 }))), { ok: false, reason: 'unsupported' });
});

test('parseBackup: 読み取れる顧客が 0 件（全部オブジェクトでない）なら拒否。空配列は受理', () => {
  assert.deepEqual(plain(parse({ contacts: [null, 1, 'a', [], true] })), { ok: false, reason: 'nocontacts' });
  const r = okParse({ contacts: [] });
  assert.equal(r.report.counts.contacts, 0);
  assert.equal(r.report.realContacts, 0);
});

test('parseBackup: v2 を書き出して読み戻すと同じ内容（id・予約・テンプレ・立場・名前・モデル）', () => {
  const db = makeDb();
  const r = okParse(core.buildBackup(db, NOW), { currentSettings: { apiKey: 'CUR', model: 'm0', myName: '', myCards: [], templates: [], templatesV: 3 } });
  assert.equal(r.kind, 'v2');
  assert.equal(r.report.exportedAt, NOW);
  const out = plain(r.db);
  assert.deepEqual(out.contacts, plain(db.contacts));
  assert.deepEqual(out.scheduled, plain(db.scheduled));
  assert.deepEqual(out.settings.myCards, plain(db.settings.myCards));
  assert.deepEqual(out.settings.templates, plain(db.settings.templates));
  assert.equal(out.settings.templatesV, 3);
  assert.equal(out.settings.myName, 'テスト花子');
  assert.equal(out.settings.model, 'claude-opus-4-8');
  assert.deepEqual(plain(r.report.regenerated), { contacts: 0, touchpoints: 0, scheduled: 0, personas: 0, templates: 0 });
  assert.equal(r.report.skipped.scheduled.total, 0);
});

test('parseBackup: APIキーはファイルから読まない（現在のキーを保つ。現在が空なら空のまま）', () => {
  const file = { contacts: [makeContact(1)], settings: { apiKey: DUMMY_KEY, model: 'm1' } };
  const a = okParse(file, { currentSettings: { apiKey: 'CURRENT-KEY' } });
  assert.equal(a.db.settings.apiKey, 'CURRENT-KEY');
  assert.equal(a.report.fileHadKey, true);
  const b = okParse(file, { currentSettings: { apiKey: '' } });
  assert.equal(b.db.settings.apiKey, '');
  const c = okParse(file);
  assert.equal(c.db.settings.apiKey, '', '現在の設定が無くても、ファイルのキーは入らない');
  assert.equal(JSON.stringify(c.db).includes(DUMMY_KEY), false);
  // v2 の中に手で書かれたキーも読まない
  const d = okParse(v2({ contacts: [], settings: { apiKey: DUMMY_KEY } }), { currentSettings: { apiKey: 'CUR' } });
  assert.equal(d.db.settings.apiKey, 'CUR');
  assert.equal(d.report.fileHadKey, true);
  assert.equal(okParse({ contacts: [] }).report.fileHadKey, false);
});

test('parseBackup: 旧形式の各世代と全データ削除直後を読める', () => {
  const g = legacyGenerations();
  for (const [name, file] of Object.entries(g)) {
    const r = okParse(file);
    assert.equal(r.kind, 'legacy', name);
    assert.equal(r.report.counts.contacts, file.contacts.length, name);
  }
  // 予約は連絡先 id が保たれるので戻る
  const r2 = okParse(g.gen2);
  assert.equal(r2.report.counts.scheduled, 1);
  assert.equal(plain(r2.db.scheduled)[0].contactId, 'c1');
  assert.equal(okParse(g.afterWipe).report.counts.scheduled, 0);
  assert.equal(okParse(g.gen1).report.counts.scheduled, 0);
});

test('parseBackup: templatesV が 3 以上のときだけテンプレートを採用。それ以外は現在のテンプレートを残す', () => {
  const cur = { templates: [{ id: 'keep', channel: 'email', name: '現在', subject: '', body: '' }], templatesV: 3, myCards: [] };
  const g = legacyGenerations();
  const adopted = okParse(g.gen4, { currentSettings: cur });
  assert.equal(adopted.report.templatesAdopted, true);
  assert.equal(adopted.report.templatesSkippedOld, false);
  assert.deepEqual(plain(adopted.db.settings.templates), plain(makeTemplates()));
  assert.equal(adopted.db.settings.templatesV, 3);
  for (const name of ['gen2', 'gen3']) { // templatesV が無い／2
    const r = okParse(g[name], { currentSettings: cur });
    assert.equal(r.report.templatesAdopted, false, name);
    assert.equal(r.report.templatesSkippedOld, true, name);
    assert.deepEqual(plain(r.db.settings.templates), plain(cur.templates), name);
    assert.equal(r.db.settings.templatesV, 3, name);
  }
  const noTpl = okParse(g.gen1, { currentSettings: cur });
  assert.equal(noTpl.report.templatesSkippedOld, false, 'テンプレートがそもそも無いファイル');
  assert.deepEqual(plain(noTpl.db.settings.templates), plain(cur.templates));
  const v4 = okParse(v2({ contacts: [], settings: { templates: makeTemplates(), templatesV: 4 } }), { currentSettings: cur });
  assert.equal(v4.report.templatesAdopted, true);
  assert.equal(v4.db.settings.templatesV, 4, '採用したときはファイルの templatesV を反映する');
  const nan = okParse({ contacts: [], settings: { templates: makeTemplates(), templatesV: '3' } }, { currentSettings: cur });
  assert.equal(nan.report.templatesSkippedOld, true, '文字列の 3 は採用しない');
});

test('parseBackup: 設定はファイルにある項目だけ上書き。無い・不正な項目は現在を保持', () => {
  const cur = { apiKey: 'K', model: 'cur-model', myName: '現在の名前', myCards: [{ id: 'q', label: '現在の屋号', prairie: '' }] };
  const none = okParse({ contacts: [] }, { currentSettings: cur });
  assert.deepEqual(plain(none.db.settings), cur);
  const bad = okParse({ contacts: [], settings: 'x' }, { currentSettings: cur });
  assert.deepEqual(plain(bad.db.settings), cur);
  const arr = okParse({ contacts: [], settings: [] }, { currentSettings: cur });
  assert.deepEqual(plain(arr.db.settings), cur);
  const part = okParse({ contacts: [], settings: { model: '', myName: 5, myCards: 'x' } }, { currentSettings: cur });
  assert.deepEqual(plain(part.db.settings), cur, '空のモデル名・数値の名前・配列でない立場は採用しない');
  const own = okParse({ contacts: [], settings: { model: 'new-model', myName: '' } }, { currentSettings: cur });
  assert.equal(own.db.settings.model, 'new-model');
  assert.equal(own.db.settings.myName, '', '空文字の名前は有効な値として採用');
});

test('parseBackup: id を連絡先・接点・予約・立場・テンプレで保持する', () => {
  const r = okParse(v2(plain(makeDb())));
  assert.deepEqual(plain(r.db.contacts).map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(plain(r.db.scheduled).map((s) => s.id), ['s1', 's2']);
  assert.deepEqual(plain(r.db.settings.myCards).map((p) => p.id), ['p1', 'p2']);
  assert.deepEqual(plain(r.db.settings.templates).map((t) => t.id), ['tp1', 'tp2']);
});

test('parseBackup: 不正・欠落・重複した id だけ付け直し、件数を数える（連絡先）', () => {
  const file = { contacts: [
    { id: 'ok1', name: 'a' }, { id: 'ok1', name: 'dup' }, { name: 'noid' }, { id: 'a b', name: 'badchars' },
    { id: 12, name: 'numeric' }, { id: 'x'.repeat(65), name: 'long' }, { id: '日本語', name: 'nonascii' },
  ] };
  const r = okParse(file);
  const ids = plain(r.db.contacts).map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'id が全部ちがう');
  assert.equal(ids[0], 'ok1', '重複の最初の 1 件は id を保つ');
  assert.notEqual(ids[1], 'ok1');
  ids.forEach((id) => assert.match(id, /^[\w-]{1,64}$/));
  assert.equal(r.report.regenerated.contacts, 6);
});

test('parseBackup: 新しい id が既存の id とぶつかっても重複しない。作り方が定数でも止まる', () => {
  const file = { contacts: [{ name: 'a' }, { id: 'x1', name: 'b' }, { name: 'c' }] };
  const r = okParse(file, { newId: counter('x') }); // 最初に x1 を作るが、後ろの連絡先が x1 を使っている
  const ids = plain(r.db.contacts).map((c) => c.id);
  assert.equal(new Set(ids).size, 3);
  const stuck = okParse({ contacts: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, { newId: () => 'same' });
  const sids = plain(stuck.db.contacts).map((c) => c.id);
  assert.equal(new Set(sids).size, 3, '同じ値しか返さない作り方でも、重複せず終わる');
});

test('parseBackup: 接点の id は連絡先の中で重複しないようにする', () => {
  const file = { contacts: [{ id: 'c1', touchpoints: [{ id: 't', type: '会う' }, { id: 't', type: '電話' }, { type: 'メール' }, null, 5] }, { id: 'c2', touchpoints: [{ id: 't', type: '会う' }] }] };
  const r = okParse(file);
  const [a, b] = plain(r.db.contacts);
  assert.equal(new Set(a.touchpoints.map((t) => t.id)).size, 3);
  assert.equal(a.touchpoints[0].id, 't');
  assert.equal(b.touchpoints[0].id, 't', '別の連絡先なら同じ接点 id でもよい');
  assert.equal(r.report.skipped.touchpoints, 2, 'オブジェクトでない接点は除外して数える');
  assert.equal(r.report.regenerated.touchpoints, 2);
});

test('parseBackup: 連絡先 id を付け直したら、予約の contactId も旧→新で付いてくる', () => {
  const file = { contacts: [{ id: 'a b', name: 'badchars' }, { id: 'ok', name: 'fine' }],
    scheduled: [{ id: 's1', contactId: 'a b', at: '2026-03-01T09:00', body: 'b1' }, { id: 's2', contactId: 'ok', at: '2026-03-01T09:00', body: 'b2' }] };
  const r = okParse(file);
  const d = plain(r.db);
  assert.notEqual(d.contacts[0].id, 'a b');
  assert.equal(d.scheduled[0].contactId, d.contacts[0].id, '不正な形で付け直した連絡先にも追従');
  assert.equal(d.scheduled[1].contactId, 'ok');
  assert.equal(r.report.skipped.scheduled.total, 0);
});

test('parseBackup: 旧 id が重複していて宛先を決められない予約は、黙って落とさず理由つきで数える', () => {
  const file = { contacts: [{ id: 'dup', name: 'one' }, { id: 'dup', name: 'two' }, { id: 'ok', name: 'three' }],
    scheduled: [
      { id: 's1', contactId: 'dup', at: '2026-03-01T09:00' },
      { id: 's2', contactId: 'ok', at: '2026-03-01T09:00' },
      { id: 's3', contactId: 'gone', at: '2026-03-01T09:00' },
      { id: 's4', contactId: 'ok', at: '2026-03-01 09:00' },
      { id: 's5', contactId: 'ok', at: '2026-03-01T09:00:00' },
      { id: 's6', contactId: 12, at: '2026-03-01T09:00' },
      { id: 's7', at: '2026-03-01T09:00' },
      'string', null,
    ] };
  const r = okParse(file);
  assert.deepEqual(plain(r.db.scheduled).map((s) => s.id), ['s2']);
  assert.deepEqual(plain(r.report.skipped.scheduled), { malformed: 4, ambiguous: 1, orphan: 1, badAt: 2, total: 8 });
});

test('parseBackup: 予約の項目を整える（channel・done・文字列）', () => {
  const r = okParse({ contacts: [{ id: 'c' }], scheduled: [{ id: 's', contactId: 'c', channel: 'sms', subject: 5, body: { a: 1 }, at: '2026-03-01T09:00', done: 'yes' }] });
  assert.deepEqual(plain(r.db.scheduled[0]), { id: 's', contactId: 'c', channel: 'email', subject: '5', body: '', at: '2026-03-01T09:00', done: false });
  const notArray = okParse({ contacts: [{ id: 'c' }], scheduled: 'x' });
  assert.deepEqual(plain(notArray.db.scheduled), []);
});

test('parseBackup: category・createdAt は「キーが無いとき」だけ既定値。空文字は保つ', () => {
  const r = okParse({ contacts: [{ id: 'a', category: '', createdAt: '' }, { id: 'b' }, { id: 'c', category: null, createdAt: 5 }] });
  const [a, b, c] = plain(r.db.contacts);
  assert.equal(a.category, '');
  assert.equal(a.createdAt, '', '「未接点」の連絡先が現在時刻に化けない');
  assert.equal(b.category, '見込み客');
  assert.equal(b.createdAt, NOW);
  assert.equal(c.category, '');
  assert.equal(c.createdAt, '5');
});

test('parseBackup: 型違いの値を整える（オブジェクト・配列は空文字。"[object Object]" にしない）', () => {
  const r = okParse({ contacts: [{ id: 'a', name: { x: 1 }, company: ['a', 'b'], memo: 5, email: true, tel: null, tags: ['a', 5, {}, null, ''], touchpoints: 'x' }] });
  const c = plain(r.db.contacts)[0];
  assert.equal(c.name, '');
  assert.equal(c.company, '');
  assert.equal(c.memo, '5');
  assert.equal(c.email, 'true');
  assert.equal(c.tel, '');
  assert.deepEqual(c.tags, ['a', '5']);
  assert.deepEqual(c.touchpoints, []);
  assert.equal(JSON.stringify(r.db).includes('[object Object]'), false);
});

test('parseBackup: 接点の done は true のときだけ true', () => {
  const r = okParse({ contacts: [{ id: 'a', touchpoints: [{ done: true }, { done: 'yes' }, { done: 1 }, { done: false }, {}] }] });
  assert.deepEqual(plain(r.db.contacts)[0].touchpoints.map((t) => t.done), [true, false, false, false, false]);
});

test('parseBackup: 未知の項目は捨てる', () => {
  const r = okParse({ contacts: [{ id: 'a', name: 'x', photo: 'p', custom: { a: 1 } }] });
  assert.equal('photo' in plain(r.db.contacts)[0], false);
  assert.equal('custom' in plain(r.db.contacts)[0], false);
});

test('parseBackup: オブジェクトでない顧客・立場・テンプレを除外して数える', () => {
  const file = v2({ contacts: [{ id: 'a' }, null, 1, 'x', []], settings: {
    myCards: [{ id: 'p', label: '屋号' }, { id: 'q', label: '' }, null, 'x', { label: 5, prairie: 'u' }],
    templates: [{ id: 't', name: 'n' }, null, 'x', { channel: 'line' }], templatesV: 3 } });
  const r = okParse(file);
  assert.equal(r.report.skipped.contacts, 4);
  assert.equal(r.report.counts.contacts, 1);
  assert.deepEqual(plain(r.db.settings.myCards).map((p) => p.label), ['屋号', '5']);
  assert.equal(r.report.skipped.personas, 3);
  assert.equal(r.report.skipped.templates, 2);
  assert.deepEqual(plain(r.db.settings.templates).map((t) => [t.channel, t.name]), [['email', 'n'], ['line', '（無題）']]);
});

test('parseBackup: 中身のある顧客の数を数える（空の顧客だけのファイルを見分ける）', () => {
  assert.equal(okParse({ contacts: [{}, { id: 'b' }, { name: '' }] }).report.realContacts, 0);
  assert.equal(okParse({ contacts: [{}, { name: 'a' }, { company: 'b' }, { email: 'c' }, { tel: 'd' }, { mobile: 'e' }] }).report.realContacts, 5);
});

test('parseBackup: exportedAt は ISO 形式のときだけ報告に出す', () => {
  assert.equal(okParse(v2({ contacts: [] }, { exportedAt: '2026-10-21T01:23:45.678Z' })).report.exportedAt, '2026-10-21T01:23:45.678Z');
  assert.equal(okParse(v2({ contacts: [] }, { exportedAt: '2026-10-21\n\n偽の文' })).report.exportedAt, '');
  assert.equal(okParse(v2({ contacts: [] }, { exportedAt: 5 })).report.exportedAt, '');
  assert.equal(okParse({ contacts: [] }).report.exportedAt, '', '旧形式には書き出し日時が無い');
});

test('parseBackup: 暦として成り立たない exportedAt は報告に出さない', () => {
  assert.equal(okParse(v2({ contacts: [] }, { exportedAt: '2026-13-45T99:99:99Z' })).report.exportedAt, '');
});

test('parseBackup: モデル名は英数字と ._- の 1〜64 文字だけ採用する（それ以外は現在のモデルを残す）', () => {
  const m = (model) => okParse({ contacts: [], settings: { model } }, { currentSettings: { model: 'cur' } }).db.settings.model;
  assert.equal(m('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(m('claude-haiku-4-5'), 'claude-haiku-4-5');
  assert.equal(m('a.b_c-d'), 'a.b_c-d');
  for (const bad of ['', 'MARKER<img src=x>', 'a b', 'x'.repeat(65), 'モデル', 'a\nb', 5, null]) assert.equal(m(bad), 'cur', String(bad));
});

test('parseBackup: 入力の現在設定を書き換えない', () => {
  const cur = { apiKey: 'K', myCards: [{ id: 'a', label: 'x', prairie: '' }], templates: makeTemplates(), templatesV: 3 };
  const before = plain(cur);
  okParse(v2(plain(makeDb())), { currentSettings: cur });
  assert.deepEqual(plain(cur), before);
});

test('parseBackup: __proto__ / constructor を含む入力でも Object.prototype を汚さない', () => {
  const proto = '{"polluted":"yes"}';
  const bodies = [
    `{"__proto__":${proto},"contacts":[{"id":"a","__proto__":${proto},"constructor":{"prototype":${proto}},"touchpoints":[{"__proto__":${proto}}]}],"settings":{"__proto__":${proto},"myCards":[{"label":"x","__proto__":${proto}}]},"scheduled":[{"__proto__":${proto}}]}`,
    `{"format":"meishi-crm-backup","version":2,"data":{"__proto__":${proto},"contacts":[{"id":"__proto__","name":"constructor"},{"id":"constructor"},{"id":"toString"},{"id":"hasOwnProperty"}],"scheduled":[{"contactId":"__proto__","at":"2026-03-01T09:00"}],"settings":{"constructor":{"prototype":${proto}}}}}`,
  ];
  for (const b of bodies) {
    const r = core.parseBackup(b, { nowIso: NOW, newId: counter('x') });
    assert.equal(r.ok, true);
    assert.equal(({}).polluted, undefined);
    assert.equal(vm.runInContext('({}).polluted', core), undefined);
    assert.equal(vm.runInContext('Object.prototype.polluted', core), undefined);
    assert.equal(JSON.stringify(r.db).includes('polluted'), false);
  }
  const r = okParse('{"contacts":[{"id":"constructor"},{"id":"toString"},{"id":"__proto__"}]}');
  assert.deepEqual(plain(r.db.contacts).map((c) => c.id), ['constructor', 'toString', '__proto__'], 'Object のメンバー名と同じ id も、そのまま保持される');
});

test('parseBackup: 深い入れ子や巨大な文字列でも落ちない', () => {
  const deep = '['.repeat(20000) + ']'.repeat(20000);
  const r = parse(`{"contacts":[{"id":"a","name":${deep},"tags":[${deep}],"memo":"ok"}]}`);
  assert.equal(r.ok, true);
  assert.equal(plain(r.db.contacts)[0].name, '');
  const big = 'あ'.repeat(1024 * 1024);
  const r2 = parse(JSON.stringify({ contacts: [{ id: 'a', name: big }] }));
  assert.equal(plain(r2.db.contacts)[0].name.length, big.length);
});

test('parseBackup: 大きめの入力（顧客 5000 件・接点 3 件ずつ）が現実的な時間で通る', () => {
  const contacts = Array.from({ length: 5000 }, (_, i) => makeContact(i + 1, { id: 'big' + i, touchpoints: [0, 1, 2].map((k) => ({ id: 'bt' + i + '_' + k, type: '会う', date: '2026-01-01', note: 'n', nextAction: '', nextDate: '', done: false })) }));
  const t0 = Date.now();
  const r = okParse(core.buildBackup({ contacts, scheduled: [], settings: {} }, NOW));
  assert.ok(Date.now() - t0 < 10000, '10 秒以内');
  assert.equal(r.report.counts.contacts, 5000);
  assert.equal(r.report.counts.touchpoints, 15000);
  assert.equal(r.report.regenerated.contacts, 0);
});

test('parseBackup: 純関数。同じ入力・同じ ctx なら同じ結果', () => {
  const t = JSON.stringify({ contacts: [{ name: 'a' }, { name: 'b' }], scheduled: [] });
  const a = plain(core.parseBackup(t, { nowIso: NOW, newId: counter('x') }));
  const b = plain(core.parseBackup(t, { nowIso: NOW, newId: counter('x') }));
  assert.deepEqual(a, b);
});

test('parseBackup: 予約・立場・テンプレの id を付け直した件数を数える', () => {
  const r = okParse(v2({ contacts: [{ id: 'c' }], scheduled: [{ id: 'a b', contactId: 'c', at: '2026-03-01T09:00' }, { contactId: 'c', at: '2026-03-01T09:00' }],
    settings: { myCards: [{ id: 'p', label: 'x' }, { id: 'p', label: 'y' }], templates: [{ id: 't' }, { id: 't' }, {}], templatesV: 3 } }));
  assert.deepEqual(plain(r.report.regenerated), { contacts: 0, touchpoints: 0, scheduled: 2, personas: 1, templates: 2 });
  assert.equal(new Set(plain(r.db.scheduled).map((s) => s.id)).size, 2);
});

test('parseBackup: id に末尾の改行・全角・NUL・空白を含むものは付け直す（$ が改行に一致する罠）', () => {
  const r = okParse({ contacts: ['abc\n', '全角', 'a\u0000b', 'a b', ' '].map((id) => ({ id })) });
  assert.equal(r.report.regenerated.contacts, 5);
  plain(r.db.contacts).forEach((c) => assert.match(c.id, /^[\w-]{1,64}$/));
});

test('parseBackup: 復元しなかった予約の理由別の件数の合計が、元の件数と残った件数の差に一致する', () => {
  const sched = [
    { id: 'a', contactId: 'ok', at: '2026-03-01T09:00' }, { id: 'b', contactId: 'dup', at: '2026-03-01T09:00' }, { id: 'c', contactId: 'none', at: '2026-03-01T09:00' },
    { id: 'd', contactId: 'ok', at: 'x' }, { id: 'e', contactId: 5 }, null,
  ];
  const r = okParse({ contacts: [{ id: 'ok' }, { id: 'dup' }, { id: 'dup' }], scheduled: sched });
  assert.equal(r.report.counts.scheduled + r.report.skipped.scheduled.total, sched.length);
});

test('parseBackup: 読み込んだ結果を書き出して読み直しても同じ（再生成も除外も 0 件）', () => {
  const messy = { contacts: [{ name: 'a' }, { id: 'a b', name: 'b', touchpoints: [{ type: '会う' }] }], scheduled: [{ contactId: 'a b', at: '2026-03-01T09:00' }], settings: { myCards: [{ label: 'x' }], templates: [{ name: 'n' }], templatesV: 3 } };
  const first = okParse(messy, { currentSettings: { apiKey: '' } });
  const second = parse(core.buildBackup(plain(first.db), NOW), { newId: () => { throw new Error('2 回目は新しい id を作らない'); }, currentSettings: { apiKey: '' } });
  assert.equal(second.ok, true);
  assert.deepEqual(plain(second.db), plain(first.db));
  assert.deepEqual(plain(second.report.regenerated), { contacts: 0, touchpoints: 0, scheduled: 0, personas: 0, templates: 0 });
  assert.equal(second.report.skipped.scheduled.total, 0);
});

// templates / myCards: 空配列＝明示的な空として採用／要素があるのに有効なものが 0 件＝現在の値を残す／混在＝有効なものだけ採用し、除外した件数を報告に出す
test('parseBackup: 要素があるのに有効なものが 0 件の templates / myCards は、現在の値を残す（templatesV も現在のまま）', () => {
  const cur = { templates: makeTemplates(), templatesV: 3, myCards: [{ id: 'q', label: '現在の屋号', prairie: '' }] };
  const r = okParse(v2({ contacts: [], settings: { templates: [null, 'x'], templatesV: 4, myCards: [null, { label: '' }] } }), { currentSettings: cur });
  assert.deepEqual(plain(r.db.settings.templates), plain(cur.templates));
  assert.equal(r.db.settings.templatesV, 3);
  assert.deepEqual(plain(r.db.settings.myCards), plain(cur.myCards));
  assert.equal(r.report.skipped.templates, 2);
  assert.equal(r.report.skipped.personas, 2);
  assert.equal(r.report.templatesAdopted, false);
  assert.equal(r.report.templatesUnreadable, true);
  assert.equal(r.report.personasUnreadable, true);
  assert.deepEqual(plain(r.report.counts), { contacts: 0, touchpoints: 0, scheduled: 0, templates: 2, personas: 1 });
});

test('parseBackup: 空配列の templates / myCards は、明示的な空として採用する', () => {
  const cur = { templates: makeTemplates(), templatesV: 3, myCards: [{ id: 'q', label: '現在の屋号', prairie: '' }] };
  const r = okParse(v2({ contacts: [], settings: { templates: [], templatesV: 4, myCards: [] } }), { currentSettings: cur });
  assert.deepEqual(plain(r.db.settings.templates), []);
  assert.equal(r.db.settings.templatesV, 4);
  assert.deepEqual(plain(r.db.settings.myCards), []);
  assert.equal(r.report.templatesAdopted, true);
  assert.equal(r.report.templatesUnreadable, false);
  assert.equal(r.report.personasUnreadable, false);
});

test('parseBackup: 有効と無効が混在する templates / myCards は、有効なものだけ採用し、除外した件数を報告に出す', () => {
  const cur = { templates: [{ id: 'keep', channel: 'email', name: '現在', subject: '', body: '' }], templatesV: 3, myCards: [{ id: 'q', label: '現在の屋号', prairie: '' }] };
  const r = okParse(v2({ contacts: [], settings: { templates: [null, { id: 't', name: 'n' }], templatesV: 3, myCards: [{ label: '' }, { id: 'p', label: '屋号' }] } }), { currentSettings: cur });
  assert.deepEqual(plain(r.db.settings.templates).map((t) => t.id), ['t']);
  assert.deepEqual(plain(r.db.settings.myCards).map((p) => p.label), ['屋号']);
  assert.equal(r.report.skipped.templates, 1);
  assert.equal(r.report.skipped.personas, 1);
  assert.equal(r.report.templatesUnreadable, false);
  assert.equal(r.report.personasUnreadable, false);
});

test('parseBackup: 旧形式（templatesV が 3 未満）のテンプレートは、中身が読めなくても「旧形式」として扱う（読めないとは報告しない）', () => {
  const r = okParse({ contacts: [], settings: { templates: [null], templatesV: 2 } }, { currentSettings: { templates: makeTemplates(), templatesV: 3 } });
  assert.equal(r.report.templatesSkippedOld, true);
  assert.equal(r.report.templatesUnreadable, false);
  assert.equal(r.report.skipped.templates, 0);
});

// ---------- commitRaw（書込→読み戻し→rollback） ----------
const mem = (init = {}) => { // 保存先の代用品。act(n, k, v) で失敗を作る
  const m = new Map(Object.entries(init)); let n = 0;
  const s = { m, act: null, failGet: false,
    getItem: (k) => { if (s.failGet) throw new Error('read'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { n++; const a = s.act && s.act(n, k, v); if (a === 'throw') throw new Error('quota'); if (a === 'drop') return; if (a === 'storeThrow') { m.set(k, String(v)); throw new Error('quota'); } m.set(k, a && a.store !== undefined ? a.store : String(v)); },
    removeItem: (k) => { m.delete(k); } };
  return s;
};

test('commitRaw: 書けて読み戻せれば ok', () => {
  const s = mem({ k: 'old' });
  assert.equal(core.commitRaw(s, 'k', 'new', 'old'), 'ok');
  assert.equal(s.m.get('k'), 'new');
  assert.equal(core.commitRaw(mem({ k: 'same' }), 'k', 'same', 'same'), 'ok', '同じ内容でも ok');
});

test('commitRaw: 書き込みが例外・黙って保存されないとき、保存値が元のままなら unchanged', () => {
  for (const act of ['throw', 'drop']) {
    const s = mem({ k: 'old' }); s.act = () => act;
    assert.equal(core.commitRaw(s, 'k', 'new', 'old'), 'unchanged', act);
    assert.equal(s.m.get('k'), 'old', act);
  }
});

test('commitRaw: 読み戻しが違う値なら、元の値に rollback する（rolledback）', () => {
  const s = mem({ k: 'old' }); s.act = (n) => (n === 1 ? { store: 'garbage' } : undefined);
  assert.equal(core.commitRaw(s, 'k', 'new', 'old'), 'rolledback');
  assert.equal(s.m.get('k'), 'old');
});

test('commitRaw: 書き込みが例外なら、読み戻しが next と同じでも ok にせず、元の値へ戻す（保守的）', () => {
  const s = mem({ k: 'old' }); s.act = (n) => (n === 1 ? 'storeThrow' : undefined);
  assert.equal(core.commitRaw(s, 'k', 'new', 'old'), 'rolledback');
  assert.equal(s.m.get('k'), 'old');
});

test('commitRaw: 元の値が無かった（null）場合の rollback は removeItem', () => {
  const s = mem(); s.act = () => ({ store: 'garbage' });
  assert.equal(core.commitRaw(s, 'k', 'new', null), 'rolledback');
  assert.equal(s.m.has('k'), false);
  const t = mem(); t.act = () => 'throw';
  assert.equal(core.commitRaw(t, 'k', 'new', null), 'unchanged');
});

test('commitRaw: rollback も失敗したら critical（保存値が元のままだとは保証しない）', () => {
  const s = mem({ k: 'old' }); s.act = (n) => (n === 1 ? { store: 'garbage' } : 'throw');
  assert.equal(core.commitRaw(s, 'k', 'new', 'old'), 'critical');
  assert.equal(s.m.get('k'), 'garbage');
  const r = mem({ k: 'old' }); r.act = () => ({ store: 'garbage' }); // rollback も別の値になる
  assert.equal(core.commitRaw(r, 'k', 'new', 'old'), 'critical');
  const g = mem({ k: 'old' }); g.failGet = true; // 読み戻しができない
  assert.equal(core.commitRaw(g, 'k', 'new', 'old'), 'critical');
});

// ---------- restoreMessage（確認文） ----------
const msg = (file, cur, o = {}, ctx = {}) => {
  const r = okParse(file, ctx);
  return core.restoreMessage(r.report, plain(core.summarizeDb(cur)), { dateLine: '', unexported: false, hasUndo: false, canUndo: true, currentKey: true, ...o });
};

test('restoreMessage: 置き換え・件数・APIキー・戻し方を必ず含む', () => {
  const m = msg(v2(plain(makeDb())), makeDb());
  for (const s of ['現在のデータを、バックアップの内容に置き換えます。', '顧客：2件 → 2件', '接点：4件 → 4件', '送信予約：2件 → 2件', 'APIキーはバックアップに含まれません。今のキーをそのまま使います。', '「最初の復元前に戻す」で戻せます', '「OK」を押すと復元します。']) {
    assert.ok(m.includes(s), s);
  }
  for (const s of ['復元しないデータ', '【警告】', 'IDを付け直した', '旧形式のテンプレート', '読み取れるものが無い', 'おすすめします', '前回の']) assert.equal(m.includes(s), false, s);
});

test('restoreMessage: 要素があるのに読み取れる立場・テンプレートが無いときは、今のものを使うと知らせる。空配列・混在では出さない', () => {
  const T = 'テンプレートは読み取れるものが無いため復元しません（今のテンプレートをそのまま使います）。';
  const P = '立場は読み取れるものが無いため復元しません（今の立場をそのまま使います）。';
  const bad = msg(v2({ contacts: [], settings: { templates: [null], templatesV: 3, myCards: [{ label: '' }] } }), makeDb());
  assert.ok(bad.includes(T)); assert.ok(bad.includes(P));
  assert.ok(bad.includes('復元しないデータ：立場1件（名前が空・形式が読めない）、テンプレート1件（形式が読めない）'));
  for (const s of [{ templates: [], templatesV: 3, myCards: [] }, { templates: [null, { name: 'n' }], templatesV: 3, myCards: [{ label: '' }, { label: 'x' }] }]) {
    const m = msg(v2({ contacts: [], settings: s }), makeDb());
    assert.equal(m.includes(T), false); assert.equal(m.includes(P), false);
  }
});

test('restoreMessage: 各行は、そうなるときだけ出る', () => {
  const sched = [{ id: 's', contactId: 'gone', at: '2026-03-01T09:00' }];
  const m = msg({ contacts: [{ name: 'a' }, null], scheduled: sched, settings: { apiKey: 'x', templates: [], templatesV: 1 } }, makeDb(), { dateLine: 'ファイルの更新日：2026/1/1', unexported: true, hasUndo: true, currentKey: false });
  for (const s of ['ファイルの更新日：2026/1/1', '復元しないデータ：顧客1件（形式が読めない）、送信予約1件（宛先の顧客がいない1件）', 'IDを付け直したデータ：1件', '復元後に設定で入力してください', 'このファイルにはAPIキーが入っています。読み込みません', '旧形式のテンプレートは復元しません', '先に設定の「JSONバックアップ」で書き出しておくことをおすすめします', '前回の「最初の復元前に戻す」はそのまま残ります']) {
    assert.ok(m.includes(s), s);
  }
  assert.equal(m.includes('今のキーをそのまま使います'), false);
});

test('restoreMessage: 戻せない復元（今、保存データが無い）では、戻せるとは案内せず、戻せないと書く', () => {
  const m = msg({ contacts: [{ name: 'a' }] }, { contacts: [], settings: {} }, { canUndo: false });
  assert.equal(m.includes('最初の復元前に戻す'), false);
  assert.ok(m.includes('この復元は元に戻せません（今、保存されているデータが無いため）。'));
  assert.ok(m.endsWith('「OK」を押すと復元します。'));
});

test('restoreMessage: 中身のある顧客が 0 件で現在のデータがあるとき、先頭に警告。現在が空なら出さない', () => {
  assert.ok(msg({ contacts: [{}] }, makeDb()).startsWith('【警告】このファイルには中身のある顧客が1件もありません。復元すると現在の顧客2件がすべて置き換わります。\n\n現在のデータを'));
  assert.equal(msg({ contacts: [] }, { contacts: [], settings: {} }).includes('【警告】'), false);
});

test('restoreMessage: 復元しない予約の理由を、種類ごとの件数で出す', () => {
  const c = [{ id: 'ok' }, { id: 'dup' }, { id: 'dup' }];
  const sch = [{ id: 'a', contactId: 'none', at: '2026-03-01T09:00' }, { id: 'b', contactId: 'dup', at: '2026-03-01T09:00' }, { id: 'c', contactId: 'ok', at: 'bad' }, { id: 'd' }, { id: 'e', contactId: 'ok', at: '2026-03-01T09:00' }];
  const m = msg({ contacts: c, scheduled: sch }, makeDb());
  assert.ok(m.includes('送信予約4件（宛先の顧客がいない1件／顧客IDが重複していて宛先を特定できない1件／日時が読めない1件／形式が読めない1件）'));
  assert.ok(m.includes('送信予約：2件 → 1件'));
});

// ---------- 小さな補助関数 ----------
test('keepId / textOf / isObj / summarizeDb', () => {
  const used = new Set();
  assert.equal(core.keepId('abc', used, counter('n')), 'abc');
  assert.equal(core.keepId('abc', used, counter('n')), 'n1', '重複は付け直す');
  assert.equal(core.textOf('a'), 'a');
  assert.equal(core.textOf(0), '0');
  assert.equal(core.textOf(false), 'false');
  for (const v of [null, undefined, {}, [], () => 1]) assert.equal(core.textOf(v), '');
  assert.equal(core.isObj({}), true);
  for (const v of [null, [], 'x', 1, undefined]) assert.equal(core.isObj(v), false);
  assert.deepEqual(plain(core.summarizeDb(makeDb())), { contacts: 2, touchpoints: 4, scheduled: 2, templates: 2, personas: 2 });
  assert.deepEqual(plain(core.summarizeDb(null)), { contacts: 0, touchpoints: 0, scheduled: 0, templates: 0, personas: 0 });
});
