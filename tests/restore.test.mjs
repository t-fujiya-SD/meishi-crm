// JSON 復元（doRestore）と「最初の復元前に戻す」（undoRestore）の回帰テスト。index.html 全体を DOM・localStorage スタブの vm で動かす。
// 実行: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, loadCore, plain, DUMMY_KEY, KEY } from './helpers.mjs';
import { NOW, makeDb, makeContact, makeTemplates, legacyGenerations } from './fixtures.mjs';

const core = loadCore();
const v2text = (db) => JSON.stringify(core.buildBackup(db, '2026-02-03T04:05:06.000Z'));
const other = () => { // 現在のデータと別の内容のバックアップ（連絡先 id も違う）
  const db = makeDb({ key: '' });
  db.contacts = [makeContact(7), makeContact(8), makeContact(9)];
  db.scheduled = [{ id: 'z1', contactId: 'c8', channel: 'email', subject: '別件', body: '本文', at: '2026-04-01T09:00', done: false }];
  db.settings.myName = '別の名前';
  db.settings.templates = [{ id: 'zt', channel: 'email', name: '別テンプレ', subject: '', body: '' }];
  return db;
};
const stored = (app) => JSON.parse(app.store.get(KEY));
const lastToast = (app) => app.log.toasts[app.log.toasts.length - 1];
const restore = (app, text, mtime) => app.call('doRestore', text, mtime);

// ---------- 復元が成功する場合 ----------
test('復元: 現在のメモリの設定に欠けがあっても、欠けたまま保存しない（保存前に normalizeSettings で整える）', () => {
  const app = loadApp({ seed: makeDb() });
  app.run('db.settings.templates=undefined;db.settings.templatesV=undefined;save()'); // 保存値も同じ形にする（保存せずに変えると、古い画面とみなして止まる）
  assert.equal(restore(app, JSON.stringify({ contacts: [{ id: 'a', name: 'x' }] })), 'ok');
  assert.ok(Array.isArray(stored(app).settings.templates) && stored(app).settings.templates.length > 0);
  assert.equal(stored(app).settings.templatesV, 3);
});

test('復元(v2): id・予約・テンプレ・templatesV・立場を保ち、現在のAPIキーを残す。保存値と画面の db が一致する', () => {
  const app = loadApp({ seed: makeDb() });
  const file = other();
  file.contacts[1].id = 'c8'; // 予約が指す連絡先
  assert.equal(restore(app, v2text(file)), 'ok');
  const db = plain(app.run('db'));
  assert.deepEqual(db.contacts.map((c) => c.id), ['c7', 'c8', 'c9']);
  assert.deepEqual(db.scheduled, plain(file.scheduled), '予約が戻る（contactId は連絡先 id のまま）');
  assert.deepEqual(db.settings.templates, plain(file.settings.templates));
  assert.equal(db.settings.templatesV, 3);
  assert.deepEqual(db.settings.myCards, plain(file.settings.myCards));
  assert.equal(db.settings.myName, '別の名前');
  assert.equal(db.settings.apiKey, DUMMY_KEY, '現在のキーはそのまま');
  assert.deepEqual(stored(app), db, '保存値と画面の db が一致');
  assert.equal(app.log.confirms.length, 1);
  assert.equal(lastToast(app), '復元しました（顧客3件）');
});

test('復元(旧形式): 予約が戻る。ファイルのAPIキーは読まず、現在のキーを残す', () => {
  const app = loadApp({ seed: makeDb({ key: 'CURRENT-KEY' }) });
  assert.equal(restore(app, JSON.stringify(legacyGenerations().gen4)), 'ok');
  const db = plain(app.run('db'));
  assert.equal(db.scheduled.length, 1);
  assert.equal(db.scheduled[0].contactId, 'c1');
  assert.equal(db.settings.apiKey, 'CURRENT-KEY');
  assert.equal(JSON.stringify(stored(app)).includes(DUMMY_KEY), false, 'ファイルの鍵は保存値に入らない');
  assert.match(app.log.confirms[0], /このファイルにはAPIキーが入っています。読み込みません/);
});

test('復元: 現在のキーが空なら、ファイルにキーがあっても空のまま', () => {
  const app = loadApp({ seed: makeDb({ key: '' }) });
  assert.equal(restore(app, JSON.stringify(legacyGenerations().gen4)), 'ok');
  assert.equal(app.run('db.settings.apiKey'), '');
  assert.match(app.log.confirms[0], /復元後に設定で入力してください/);
});

test('復元: templatesV が 3 未満の旧形式は、現在のテンプレートを残し、確認文で知らせる', () => {
  for (const gen of ['gen2', 'gen3']) {
    const app = loadApp({ seed: makeDb() });
    const before = plain(app.run('db.settings.templates'));
    assert.equal(restore(app, JSON.stringify(legacyGenerations()[gen])), 'ok', gen);
    assert.deepEqual(plain(app.run('db.settings.templates')), before, gen);
    assert.match(app.log.confirms[0], /旧形式のテンプレートは復元しません/, gen);
  }
  const app = loadApp({ seed: makeDb() });
  restore(app, JSON.stringify(legacyGenerations().gen4));
  assert.equal(app.log.confirms[0].includes('旧形式のテンプレートは復元しません'), false, 'templatesV 3 なら採用する');
});

test('復元: 画面の状態（フィルタ・検索）をリセットし、モーダルを閉じる', () => {
  const app = loadApp({ seed: makeDb() });
  app.run('filterCat="x";filterPersona="y";query="z";curId="c1"');
  restore(app, v2text(other()));
  assert.deepEqual(plain(app.run('[filterCat,filterPersona,query,curId]')), ['', '', '', null]);
});

// ---------- 復元しない場合・失敗する場合 ----------
test('復元: 取り消すと何も書かない', () => {
  const app = loadApp({ seed: makeDb(), confirmAnswer: false });
  const before = [app.store.get(KEY), app.log.setCalls];
  const dbBefore = plain(app.run('db'));
  assert.equal(restore(app, v2text(other())), 'cancel');
  assert.deepEqual([app.store.get(KEY), app.log.setCalls], before);
  assert.deepEqual(plain(app.run('db')), dbBefore);
  assert.equal(lastToast(app), '復元を取りやめました');
  assert.equal(app.run('undoRaw'), null);
});

test('復元: 確認している間に別タブが保存値を書き換えたら、中止して何も書かない（古いタブ検出）', () => {
  let app;
  const changed = JSON.stringify({ ...makeDb(), contacts: [makeContact(5)] });
  app = loadApp({ seed: makeDb(), confirmAnswer: () => { app.store.set(KEY, changed); return true; } });
  const calls = app.log.setCalls, dbBefore = plain(app.run('db'));
  assert.equal(restore(app, v2text(other())), 'stale');
  assert.equal(app.store.get(KEY), changed, '別タブの内容を上書きしない');
  assert.equal(app.log.setCalls, calls);
  assert.deepEqual(plain(app.run('db')), dbBefore);
  assert.match(lastToast(app), /ほかのタブやウィンドウでデータが更新されています/);
});

test('復元: 開いた時点で別タブが保存値を更新していたら（APIキー・テンプレ）、確認も書き込みもせず中止する（古いタブ検出）', () => {
  const app = loadApp({ seed: makeDb() });
  const newer = makeDb({ key: 'NEWER-DUMMY' });
  newer.settings.templates = [{ id: 'nt', channel: 'email', name: '別タブで追加', subject: '', body: '' }];
  const changed = JSON.stringify(newer);
  app.store.set(KEY, changed); // 別タブが保存した
  const calls = app.log.setCalls, dbBefore = plain(app.run('db'));
  assert.equal(restore(app, v2text(other())), 'stale');
  assert.equal(app.log.confirms.length, 0, '古い db で作った確認文を出さない');
  assert.equal(app.store.get(KEY), changed, '別タブのキー・テンプレを古い値で戻さない');
  assert.equal(app.log.setCalls, calls);
  assert.deepEqual(plain(app.run('db')), dbBefore);
  assert.equal(app.run('undoRaw'), null);
  assert.match(lastToast(app), /ほかのタブやウィンドウでデータが更新されています/);
});

test('ファイル選択: 選ぶ前に別タブが保存していたら、確認を出さずに中止する', () => {
  const app = loadApp({ seed: makeDb() });
  app.store.set(KEY, JSON.stringify({ ...makeDb(), contacts: [makeContact(5)] }));
  const calls = app.log.setCalls;
  app.pickRestoreFile(v2text(other()));
  assert.equal(app.log.confirms.length, 0);
  assert.match(lastToast(app), /ほかのタブやウィンドウでデータが更新されています/);
  assert.equal(app.log.setCalls, calls);
});

test('復元: 旧形式の保存値で起動しても古いとみなさない（起動時の save() で、整えた db が保存値になる）', () => {
  const { gen1, gen3 } = legacyGenerations(); // テンプレ・予約が無い／templatesV が 2＝起動時に normalizeSettings が補う
  for (const seed of [gen1, gen3]) {
    const app = loadApp({ seed });
    assert.equal(app.store.get(KEY), JSON.stringify(app.run('db')), '前提: 起動後は画面の db と保存値が一致する');
    assert.equal(restore(app, v2text(other())), 'ok');
  }
});

test('復元: 画面の db と保存値が食い違えば、この画面の変更でも中止する（保存していない変更・別タブの書き戻し）', () => {
  const unsaved = loadApp({ seed: makeDb() });
  unsaved.run('db.settings.myName="保存していない変更"');
  assert.equal(restore(unsaved, v2text(other())), 'stale');
  assert.equal(unsaved.log.confirms.length, 0);
  const reverted = loadApp({ seed: makeDb() });
  const boot = reverted.store.get(KEY);
  reverted.run('db.settings.myName="この画面で変更";save()');
  reverted.store.set(KEY, boot); // 別タブが前の保存値を書き戻した
  assert.equal(restore(reverted, v2text(other())), 'stale');
  assert.equal(reverted.store.get(KEY), boot);
});

test('復元: 要素があるのに読み取れる立場・テンプレートが無いファイルでは、今の立場・テンプレートを残す', () => {
  const app = loadApp({ seed: makeDb() });
  const before = plain(stored(app).settings);
  const file = other();
  file.settings.templates = [null, 'x'];
  file.settings.myCards = [{ label: '' }, 5];
  assert.equal(restore(app, v2text(file)), 'ok');
  assert.deepEqual(stored(app).settings.templates, before.templates);
  assert.equal(stored(app).settings.templatesV, before.templatesV);
  assert.deepEqual(stored(app).settings.myCards, before.myCards);
  assert.match(app.log.confirms[0], /テンプレートは読み取れるものが無いため復元しません（今のテンプレートをそのまま使います）。/);
  assert.match(app.log.confirms[0], /立場は読み取れるものが無いため復元しません（今の立場をそのまま使います）。/);
  assert.match(app.log.confirms[0], /復元しないデータ：.*立場2件（名前が空・形式が読めない）、テンプレート2件（形式が読めない）/);
});

test('復元: 読めないファイルは、確認も書き込みもなしで断る', () => {
  const cases = [
    ['', 'badjson', /バックアップファイルではないか/],
    ['{"contacts":[', 'badjson', /途中で切れています/],
    ['{"foo":1}', 'notbackup', /名刺CRMのバックアップではありません/],
    [JSON.stringify({ format: 'meishi-crm-backup', version: 1, data: { contacts: [] } }), 'notbackup', /名刺CRMのバックアップではありません/],
    [JSON.stringify({ format: 'meishi-crm-backup', version: 3, data: { contacts: [] } }), 'unsupported', /新しい版のバックアップ/],
    [JSON.stringify({ contacts: [null, 1] }), 'nocontacts', /読み取れる顧客がありません/],
  ];
  for (const [text, status, re] of cases) {
    const app = loadApp({ seed: makeDb() });
    const raw = app.store.get(KEY), calls = app.log.setCalls;
    assert.equal(restore(app, text), status, text);
    assert.match(lastToast(app), re, text);
    assert.equal(app.log.confirms.length, 0, text);
    assert.equal(app.store.get(KEY), raw, text);
    assert.equal(app.log.setCalls, calls, text);
  }
});

test('復元: 保存領域を読めない環境では、確認も書き込みもせずに断る', () => {
  const app = loadApp({ seed: makeDb() });
  app.ctl.failGet = true;
  const calls = app.log.setCalls;
  assert.equal(restore(app, v2text(other())), 'nostore');
  assert.match(lastToast(app), /保存領域を読み取れないため、復元できません/);
  assert.equal(app.log.confirms.length, 0);
  assert.equal(app.log.setCalls, calls);
});

test('復元: 書き込みが例外になっても、画面の db も保存値も変わらず、復元前に戻す枠も作らない', () => {
  const app = loadApp({ seed: makeDb() });
  const raw = app.store.get(KEY), dbBefore = plain(app.run('db'));
  app.ctl.onSet = () => 'throw';
  assert.equal(restore(app, v2text(other())), 'unchanged');
  assert.equal(app.store.get(KEY), raw);
  assert.deepEqual(plain(app.run('db')), dbBefore);
  assert.deepEqual(plain(app.run('[undoRaw,afterRaw]')), [null, null]);
  assert.equal(lastToast(app), '復元できませんでした。保存に失敗したため、データは変わっていません。');
});

test('復元: 黙って保存されなかった（読み戻しが元のまま）場合も、成功と言わない', () => {
  const app = loadApp({ seed: makeDb() });
  const raw = app.store.get(KEY);
  app.ctl.onSet = () => 'drop';
  assert.equal(restore(app, v2text(other())), 'unchanged');
  assert.equal(app.store.get(KEY), raw);
  assert.equal(app.run('db.contacts.length'), 2);
});

test('復元: 読み戻しが違う値なら、元の保存値へ rollback する', () => {
  const app = loadApp({ seed: makeDb() });
  const raw = app.store.get(KEY), dbBefore = plain(app.run('db'));
  let n = 0;
  app.ctl.onSet = () => (++n === 1 ? { store: 'garbage' } : undefined); // 1 回目は別の値が保存される。rollback の書き込みは通常どおり
  assert.equal(restore(app, v2text(other())), 'rolledback');
  assert.equal(app.store.get(KEY), raw, '元の保存値に戻っている');
  assert.deepEqual(plain(app.run('db')), dbBefore);
  assert.equal(lastToast(app), '復元できませんでした。保存に失敗したため、元の状態に戻しました。');
});

test('復元: rollback も失敗したら重大エラーを出す（画面の db は元のまま）', () => {
  const app = loadApp({ seed: makeDb() });
  const dbBefore = plain(app.run('db'));
  let n = 0;
  app.ctl.onSet = () => (++n === 1 ? { store: 'garbage' } : 'throw');
  assert.equal(restore(app, v2text(other())), 'critical');
  assert.equal(app.log.alerts.length, 1);
  assert.match(app.log.alerts[0], /重大なエラー：復元の途中で保存に失敗し、元の状態への復旧にも失敗しました/);
  assert.match(app.log.alerts[0], /JSONバックアップ/);
  assert.deepEqual(plain(app.run('db')), dbBefore, '画面の db は旧データのまま＝書き出して救える');
  assert.deepEqual(plain(app.run('[undoRaw,afterRaw]')), [null, null]);
});

// ---------- 確認文（内容プレビュー） ----------
test('確認文: 置き換えること・件数・復元しない件数と理由・APIキーを表示する', () => {
  const app = loadApp({ seed: makeDb() });
  const file = { contacts: [{ id: 'a', name: 'x' }, { id: 'dup' }, { id: 'dup' }, null], scheduled: [
    { id: 's1', contactId: 'a', at: '2026-03-01T09:00' }, { id: 's2', contactId: 'dup', at: '2026-03-01T09:00' }, { id: 's3', contactId: 'none', at: '2026-03-01T09:00' }, { id: 's4', contactId: 'a', at: 'x' }] };
  restore(app, JSON.stringify(file), Date.parse('2026-05-06T00:00:00Z'));
  const m = app.log.confirms[0];
  assert.match(m, /現在のデータを、バックアップの内容に置き換えます。/);
  assert.match(m, /顧客：2件 → 3件/);
  assert.match(m, /接点：4件 → 0件/);
  assert.match(m, /送信予約：2件 → 1件/);
  assert.match(m, /復元しないデータ：顧客1件（形式が読めない）、送信予約3件（宛先の顧客がいない1件／顧客IDが重複していて宛先を特定できない1件／日時が読めない1件）/);
  assert.match(m, /APIキーはバックアップに含まれません。今のキーをそのまま使います。/);
  assert.match(m, /ファイルの更新日：/);
});

test('確認文: 中身のある顧客が 0 件のファイルで現在のデータがあるときは、先頭に警告を出す', () => {
  for (const file of [{ contacts: [] }, { contacts: [{}, { id: 'b' }] }]) {
    const app = loadApp({ seed: makeDb() });
    restore(app, JSON.stringify(file));
    assert.match(app.log.confirms[0], /^【警告】このファイルには中身のある顧客が1件もありません。復元すると現在の顧客2件がすべて置き換わります。/);
  }
  const empty = loadApp({ seed: { contacts: [], settings: {} } });
  restore(empty, JSON.stringify({ contacts: [] }));
  assert.equal(empty.log.confirms[0].includes('【警告】'), false, '現在も空なら警告しない');
});

test('確認文: v2 は書き出し日時、旧形式はファイルの更新日を出す', () => {
  const app = loadApp({ seed: makeDb() });
  restore(app, v2text(other()), 1);
  assert.match(app.log.confirms[0], /書き出し日時：/);
  assert.equal(app.log.confirms[0].includes('ファイルの更新日'), false);
});

test('確認文: 現在のデータを書き出していない（または書き出し後に変更した）ときだけ、書き出しをすすめる', () => {
  const sure = (m) => m.includes('先に設定の「JSONバックアップ」で書き出しておくことをおすすめします');
  const app = loadApp({ seed: makeDb(), confirmAnswer: false });
  restore(app, v2text(other()));
  assert.equal(sure(app.log.confirms[0]), true, '一度も書き出していない');
  app.run('exportJSON()');
  assert.equal(app.run('exportedRaw'), app.store.get(KEY), '書き出した時点の保存値を記録する（保存が完了した証拠ではなく、書き出し操作をしたという目印）');
  restore(app, v2text(other()));
  assert.equal(sure(app.log.confirms[1]), false, '書き出した直後');
  app.run('db.contacts[0].memo="変更";save()');
  restore(app, v2text(other()));
  assert.equal(sure(app.log.confirms[2]), true, '書き出し後に変更した');
});

test('確認文: 画面にバックアップ済み・安全といった断定をしない', () => {
  const app = loadApp({ seed: makeDb(), confirmAnswer: false });
  restore(app, v2text(other()));
  for (const w of ['バックアップ済み', '安全に', '保存されています']) assert.equal(app.log.confirms[0].includes(w), false, w);
});

// ---------- 復元前に戻す ----------
const restored = (confirmAnswer = true) => {
  const app = loadApp({ seed: makeDb(), confirmAnswer });
  const original = app.store.get(KEY);
  assert.equal(restore(app, v2text(other())), 'ok');
  return { app, original };
};

test('復元前に戻す: 復元の直後なら、復元前の保存値に戻る（現在のキーを使う）', () => {
  const { app, original } = restored();
  assert.equal(app.run('undoRaw'), original, '復元前の保存値の生文字列をメモリに保持');
  assert.equal(app.run('afterRaw'), app.store.get(KEY), '復元直後の保存値も保持');
  assert.match(app.els.get('undoBox').innerHTML, /最初の復元前に戻す/);
  assert.equal(app.call('undoRestore'), 'ok');
  assert.deepEqual(stored(app), JSON.parse(original));
  assert.deepEqual(plain(app.run('db')), JSON.parse(original));
  assert.deepEqual(plain(app.run('[undoRaw,afterRaw]')), [null, null]);
  assert.equal(app.els.get('undoBox').innerHTML, '');
  assert.equal(lastToast(app), '復元前の状態に戻しました');
});

test('復元前に戻す: 復元後にデータを変更していたら、書き込まずに中止する', () => {
  const { app } = restored();
  app.run('db.contacts[0].memo="復元後の変更";save()');
  const raw = app.store.get(KEY), calls = app.log.setCalls, confirms = app.log.confirms.length;
  assert.equal(app.call('undoRestore'), 'changed');
  assert.equal(lastToast(app), '復元後にデータが変更されています。現在の変更を失うため、復元前には戻せません。');
  assert.equal(app.store.get(KEY), raw);
  assert.equal(app.log.setCalls, calls);
  assert.equal(app.log.confirms.length, confirms, '確認を出す前に断る');
  assert.equal(app.run('db.contacts[0].memo'), '復元後の変更');
});

test('復元前に戻す: 確認している間に別タブが書き換えたら、中止する', () => {
  const { app } = restored();
  const calls = app.log.setCalls;
  app.ctl.confirm = () => { app.store.set(KEY, '{"contacts":[]}'); return true; }; // 確認中に別タブが保存した状況
  assert.equal(app.call('undoRestore'), 'changed');
  assert.equal(app.store.get(KEY), '{"contacts":[]}', '別タブの内容を上書きしない');
  assert.equal(app.log.setCalls, calls);
  assert.equal(lastToast(app), '復元後にデータが変更されています。現在の変更を失うため、復元前には戻せません。');
});

test('復元前に戻す: 連続して復元しても、戻す先は最初の復元の前', () => {
  const { app, original } = restored();
  const afterFirst = app.run('afterRaw');
  const second = other();
  second.contacts = [makeContact(20)];
  assert.equal(restore(app, v2text(second)), 'ok');
  assert.equal(app.run('undoRaw'), original, '最初の復元前を保持（上書きしない）');
  assert.notEqual(app.run('afterRaw'), afterFirst, '復元直後の保存値は最新に更新');
  assert.match(app.log.confirms[1], /前回の「最初の復元前に戻す」はそのまま残ります/);
  assert.equal(app.call('undoRestore'), 'ok');
  assert.deepEqual(stored(app), JSON.parse(original));
});

test('復元前に戻す: 復元の前に保存値が無かった（初回）なら、戻す枠は作らず、確認文でも戻せるとは言わない', () => {
  const app = loadApp({});
  assert.equal(app.store.has(KEY), true, '起動時に保存される');
  app.store.delete(KEY); // 保存値が無い状態を作る
  assert.equal(restore(app, v2text(other())), 'ok');
  assert.match(app.log.confirms[0], /この復元は元に戻せません/);
  assert.equal(app.log.confirms[0].includes('「最初の復元前に戻す」で戻せます'), false, '戻せないのに戻せると案内しない');
  assert.equal(app.run('undoRaw'), null);
  assert.notEqual(app.run('afterRaw'), null);
  assert.equal(app.call('undoRestore'), 'none');
});

test('復元前に戻す: 保存に失敗したら、データも「戻す枠」も変わらない', () => {
  const { app, original } = restored();
  const raw = app.store.get(KEY), dbBefore = plain(app.run('db'));
  app.ctl.onSet = () => 'throw';
  assert.equal(app.call('undoRestore'), 'unchanged');
  assert.equal(app.store.get(KEY), raw);
  assert.deepEqual(plain(app.run('db')), dbBefore);
  assert.equal(app.run('undoRaw'), original, 'やり直せる');
  assert.equal(lastToast(app), '復元前に戻せませんでした。保存に失敗したため、データは変わっていません。');
});

test('復元前に戻す: 戻すときも、今メモリにあるキーを使う', () => {
  const { app } = restored();
  app.run('db.settings.apiKey="MEMORY-KEY"'); // 保存はしない（保存値は復元直後のまま＝戻せる）
  assert.equal(app.call('undoRestore'), 'ok');
  assert.equal(app.run('db.settings.apiKey'), 'MEMORY-KEY');
  assert.equal(stored(app).settings.apiKey, 'MEMORY-KEY');
});

test('復元前に戻す: 取り消すと何も書かない', () => {
  const { app } = restored();
  app.ctl.confirm = () => false;
  const raw = app.store.get(KEY), calls = app.log.setCalls;
  assert.equal(app.call('undoRestore'), 'cancel');
  assert.equal(app.store.get(KEY), raw);
  assert.equal(app.log.setCalls, calls);
  assert.notEqual(app.run('undoRaw'), null);
});

test('全データ削除: 復元前に戻す枠を捨てる（削除したデータを復活させない）', () => {
  const { app } = restored();
  assert.notEqual(app.run('undoRaw'), null);
  app.els.get('btnWipe').onclick();
  assert.deepEqual(plain(app.run('[undoRaw,afterRaw]')), [null, null]);
  assert.equal(app.els.get('undoBox').innerHTML, '');
  assert.equal(app.run('db.contacts.length'), 0);
  assert.equal(app.call('undoRestore'), 'none');
});

// ---------- 復元前に戻す（連鎖・失敗・正規化） ----------
test('復元前に戻す: 復元のあとに編集して、もう一度復元したら、戻す先は編集後の状態（古い状態に戻して編集を消さない）', () => {
  const { app, original } = restored();
  app.run('db.contacts[0].memo="復元後の編集";save()'); // 前回の「戻す」はここで使えなくなる
  const edited = app.store.get(KEY);
  const second = other(); second.contacts = [makeContact(20)];
  assert.equal(restore(app, v2text(second)), 'ok');
  assert.equal(app.log.confirms[1].includes('前回の「最初の復元前に戻す」はそのまま残ります'), false, '使えなくなった枠を「残ります」と案内しない');
  assert.equal(app.run('undoRaw'), edited, '新しく始める（編集後の保存値）');
  assert.notEqual(app.run('undoRaw'), original);
  assert.equal(app.call('undoRestore'), 'ok');
  assert.equal(stored(app).contacts[0].memo, '復元後の編集', '編集が消えない');
});

test('復元前に戻す: あとから失敗した復元・取り消した復元・古いタブで止まった復元は、戻す枠を変えない', () => {
  const { app } = restored();
  const keep = plain(app.run('[undoRaw,afterRaw]'));
  const second = v2text({ ...other(), contacts: [makeContact(30)], scheduled: [] });
  app.ctl.onSet = () => 'throw';
  assert.equal(restore(app, second), 'unchanged');
  app.ctl.onSet = null;
  app.ctl.confirm = () => false;
  assert.equal(restore(app, second), 'cancel');
  app.ctl.confirm = () => { app.store.set(KEY + '_x', '1'); app.store.set(KEY, app.store.get(KEY) + ' '); return true; };
  assert.equal(restore(app, second), 'stale');
  assert.deepEqual(plain(app.run('[undoRaw,afterRaw]')), keep);
});

test('全データ削除: 保存に失敗したときは、復元前に戻す枠を捨てない', () => {
  const { app } = restored();
  app.ctl.onSet = () => 'throw';
  app.els.get('btnWipe').onclick();
  assert.notEqual(app.run('undoRaw'), null);
  assert.notEqual(app.run('afterRaw'), null);
});

test('復元前に戻す: 全データ削除のあとに復元して戻しても、scheduled が欠けない（normalizeSettings で整える）', () => {
  const app = loadApp({ seed: makeDb() });
  app.els.get('btnWipe').onclick(); // 保存値から scheduled キーが消える（既存の挙動）
  assert.equal('scheduled' in stored(app), false);
  assert.equal(restore(app, v2text(other())), 'ok');
  assert.equal(app.call('undoRestore'), 'ok');
  assert.deepEqual(plain(app.run('db.scheduled')), []);
  assert.deepEqual(stored(app).scheduled, []);
});

// ---------- ファイル選択の経路・画面の再描画 ----------
test('ファイル選択: 選んだ時点の保存値を基準にする（読み込み完了までに別タブが保存したら中止）。同じファイルを選び直せる', () => {
  const app = loadApp({ seed: makeDb() });
  app.ctl.deferRead = true;
  const target = app.pickRestoreFile(v2text(other()));
  assert.equal(target.value, '', 'input の値を空に戻す（同じファイルをもう一度選べる）');
  app.store.set(KEY, JSON.stringify({ ...makeDb(), contacts: [makeContact(5)] })); // 別タブが保存
  const calls = app.log.setCalls;
  app.flushReads();
  assert.equal(app.log.confirms.length, 1, '確認までは進む');
  assert.match(lastToast(app), /ほかのタブやウィンドウでデータが更新されています/);
  assert.equal(app.log.setCalls, calls);
  assert.equal(app.run('db.contacts.length'), 2);
});

test('ファイル選択: 読み込みに失敗したら通知して、何も書かない', () => {
  const app = loadApp({ seed: makeDb() });
  app.ctl.readError = true;
  const calls = app.log.setCalls;
  app.pickRestoreFile(v2text(other()));
  assert.equal(lastToast(app), 'ファイルを読み込めませんでした');
  assert.equal(app.log.confirms.length, 0);
  assert.equal(app.log.setCalls, calls);
});

test('ファイル選択: ふつうの経路でも復元できる（更新日つき）', () => {
  const app = loadApp({ seed: makeDb() });
  app.pickRestoreFile(JSON.stringify(legacyGenerations().gen4), Date.parse('2026-05-06T00:00:00Z'));
  assert.equal(lastToast(app), '復元しました（顧客2件）');
  assert.match(app.log.confirms[0], /ファイルの更新日：/);
});

test('復元後の画面: 設定欄・今日・一覧・検索欄が復元後の内容に更新される（古い欄で保存し直して上書きしない）', () => {
  const app = loadApp({ seed: makeDb() });
  app.run('document.getElementById("q").value="検索語"');
  const file = other(); file.contacts[1].id = 'c8';
  assert.equal(restore(app, v2text(file)), 'ok');
  const e = (id) => app.els.get(id);
  assert.match(e('personaList').innerHTML, /屋号A/);
  assert.match(e('tplList').innerHTML, /別テンプレ/);
  assert.equal(e('myName').value, '別の名前');
  assert.equal(e('apiKey').value, DUMMY_KEY);
  assert.match(e('listWrap').innerHTML, /テスト太郎7/);
  assert.match(e('sendQueue').innerHTML, /data-schsend="z1"/, '復元した予約が今日の画面に出る');
  assert.equal(e('q').value, '');
});

test('復元後に画面の更新で例外が出ても、復元の結果は変えず、その旨を知らせる', () => {
  const app = loadApp({ seed: makeDb() });
  app.run('renderList=function(){throw new Error("render")}');
  assert.equal(restore(app, v2text(other())), 'ok');
  assert.match(lastToast(app), /^復元しました（顧客3件）。画面を更新できませんでした。再読み込みしてください$/);
  assert.equal(stored(app).contacts.length, 3);
  assert.equal(app.run('db.contacts.length'), 3);
});
