// テスト用の架空データ（実行時に生成する。実在の人物・会社・メール・鍵を含めない）。
import { DUMMY_KEY } from './helpers.mjs';

export const NOW = '2026-01-01T00:00:00.000Z';

// 決定的な id の作り方（prefix + 連番）
export const counter = (prefix = 'n') => { let i = 0; return () => prefix + (++i); };

export function makeContact(i, extra = {}) {
  return {
    id: 'c' + i, company: '架空商事' + i, name: 'テスト太郎' + i, kana: 'てすとたろう', title: '課長',
    tel: '03-0000-000' + i, fax: '', mobile: '090-0000-000' + i, email: 'taro' + i + '@example.invalid',
    address: '', url: '', prairie: '', persona: '屋号A', category: '見込み客', referrer: '', memo: 'メモ' + i,
    metDate: '2026-01-0' + (i % 9 + 1), metReason: '', metNotes: '', metNeeds: '', metNext: '',
    tags: ['タグ' + i], createdAt: '2026-01-01T00:00:00.000Z',
    touchpoints: [
      { id: 't' + i + 'a', type: '会う', date: '2026-01-02', note: '初回', nextAction: '連絡', nextDate: '2026-02-01', done: false },
      { id: 't' + i + 'b', type: '電話', date: '2026-01-05', note: '', nextAction: '', nextDate: '', done: true },
    ],
    ...extra,
  };
}

export function makeTemplates() {
  return [
    { id: 'tp1', channel: 'email', name: 'お礼', subject: '件名{氏名}', body: '本文{氏名}' },
    { id: 'tp2', channel: 'line', name: 'LINE', subject: '', body: '短文' },
  ];
}

export function makeDb({ key = DUMMY_KEY } = {}) {
  return {
    contacts: [makeContact(1), makeContact(2)],
    scheduled: [
      { id: 's1', contactId: 'c1', channel: 'email', subject: '件名', body: '本文', at: '2026-03-01T09:00', done: false },
      { id: 's2', contactId: 'c2', channel: 'line', subject: '', body: '短文', at: '2026-03-02T10:30', done: false },
    ],
    settings: {
      apiKey: key, model: 'claude-opus-4-8', myName: 'テスト花子',
      myCards: [{ id: 'p1', label: '屋号A', prairie: 'https://example.invalid/a' }, { id: 'p2', label: '屋号B', prairie: '' }],
      templates: makeTemplates(), templatesV: 3,
    },
  };
}

// 過去の書き出しの代表形（アプリの世代ごとにキーの有無が違う）。キーはどれも架空。
export function legacyGenerations() {
  const strip = (c, keys) => { const o = { ...c }; keys.forEach((k) => delete o[k]); return o; };
  const met = ['metDate', 'metReason', 'metNotes', 'metNeeds', 'metNext'];
  const base = (n) => Array.from({ length: n }, (_, i) => strip(makeContact(i + 1), met));
  const s = { apiKey: DUMMY_KEY, model: 'claude-opus-4-8', myName: 'テスト花子', myCards: [{ id: 'p1', label: '屋号A', prairie: '' }] };
  const sch = [{ id: 's1', contactId: 'c1', channel: 'email', subject: '件名', body: '本文', at: '2026-03-01T09:00', done: false }];
  return {
    gen1: { contacts: base(2), settings: { ...s } }, // 最初の版: 予約・テンプレ・交換メモ無し
    gen2: { contacts: base(2), settings: { ...s, templates: makeTemplates() }, scheduled: sch }, // 予約とテンプレ有り・templatesV 無し
    gen3: { contacts: [makeContact(1), makeContact(2)], settings: { ...s, templates: makeTemplates(), templatesV: 2 }, scheduled: sch },
    gen4: { contacts: [makeContact(1), makeContact(2)], settings: { ...s, templates: makeTemplates(), templatesV: 3 }, scheduled: sch },
    afterWipe: { contacts: [], settings: { ...s, templates: makeTemplates(), templatesV: 3 } }, // 全データ削除の直後: scheduled キー無し
  };
}
