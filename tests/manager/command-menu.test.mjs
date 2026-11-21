import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreItem, rankItems, createCommandMenu } from '../../plugins/bindery/manager/ui/command-menu.js';

const item = (label, extra = {}) => ({ id: label, group: 'Skills', label, run() {}, ...extra });

describe('scoreItem ordering', () => {
  test('exact > prefix > word-start > substring > subsequence', () => {
    const exact = scoreItem('git', item('Git'));
    const prefix = scoreItem('git', item('Git status'));
    const word = scoreItem('status', item('Git status'));
    const substring = scoreItem('it s', item('Git status'));
    const subsequence = scoreItem('gss', item('Git status'));
    for (const s of [exact, prefix, word, substring, subsequence]) assert.notEqual(s, null);
    assert.ok(exact > prefix, 'exact beats prefix');
    assert.ok(prefix > word, 'prefix beats word-start');
    assert.ok(word > substring, 'word-start beats substring');
    assert.ok(substring > subsequence, 'substring beats subsequence');
    assert.ok(subsequence > 0, 'subsequence still scores');
  });

  test('word-start beats a mid-word substring', () => {
    assert.ok(scoreItem('st', item('Git status')) > scoreItem('st', item('Restart')));
  });

  test('every listed separator counts as a word start', () => {
    for (const sep of [' ', '-', '_', '/', '.']) {
      const wordStart = scoreItem('xy', item(`a${sep}xy`));
      const midWord = scoreItem('xy', item('aqxy'));
      assert.ok(wordStart > midWord, `separator "${sep}" should give a word-start match`);
    }
  });

  test('shorter labels win ties within a tier', () => {
    assert.ok(scoreItem('ab', item('ab cd')) > scoreItem('ab', item('ab cdefgh')));
  });

  test('matching is case-insensitive', () => {
    assert.equal(scoreItem('GIT', item('git')), scoreItem('git', item('Git')));
    assert.equal(scoreItem('git', item('Git Status')) !== null, true);
  });

  test('non-subsequence returns null', () => {
    assert.equal(scoreItem('zz', item('Git status')), null);
    assert.equal(scoreItem('tig', item('Git status')), null);
  });

  test('keywords match when the label does not', () => {
    const shipIt = item('Ship it', { keywords: ['deploy', 'release'] });
    assert.notEqual(scoreItem('deploy', shipIt), null);
    assert.notEqual(scoreItem('rel', shipIt), null);
    assert.equal(scoreItem('deploy', item('Ship it')), null);
  });

  test('a label match outranks the same match in keywords', () => {
    const labelHit = item('Deploy');
    const keywordHit = item('Ship it', { keywords: ['deploy'] });
    assert.ok(scoreItem('deploy', labelHit) > scoreItem('deploy', keywordHit));
  });

  test('empty or blank query scores every item 0', () => {
    assert.equal(scoreItem('', item('Anything')), 0);
    assert.equal(scoreItem('   ', item('Anything')), 0);
  });
});

describe('rankItems', () => {
  test('sorts by score, best first', () => {
    const subsequence = item('gaxit');
    const substring = item('digit');
    const word = item('my git');
    const prefix = item('git status');
    const exact = item('git');
    const ranked = rankItems('git', [subsequence, substring, word, prefix, exact]);
    assert.deepEqual(ranked.map((i) => i.label), ['git', 'git status', 'my git', 'digit', 'gaxit']);
  });

  test('drops non-matches', () => {
    assert.deepEqual(rankItems('zz', [item('Git')]), []);
  });

  test('empty query keeps the given order and groups', () => {
    const items = [item('b', { group: 'Actions' }), item('a', { group: 'Skills' }), item('c', { group: 'Actions' })];
    assert.deepEqual(rankItems('', items).map((i) => i.label), ['b', 'a', 'c']);
  });

  test('ties keep the given order', () => {
    const ranked = rankItems('x', [item('ax'), item('bx'), item('cx')]);
    assert.deepEqual(ranked.map((i) => i.label), ['ax', 'bx', 'cx']);
  });

  test('limit is respected, with 50 by default', () => {
    const many = Array.from({ length: 60 }, (_, i) => item(`skill ${i}`));
    assert.equal(rankItems('', many).length, 50);
    assert.equal(rankItems('', many, 7).length, 7);
    assert.equal(rankItems('', many, 0).length, 0);
  });
});

describe('module import', () => {
  test('createCommandMenu works without a DOM until it is opened', () => {
    const menu = createCommandMenu({ getItems: () => [item('Git')] });
    assert.equal(menu.isOpen(), false);
    assert.equal(typeof menu.open, 'function');
    assert.equal(typeof menu.close, 'function');
    menu.close(); // a no-op while nothing is open
    assert.equal(menu.isOpen(), false);
  });
});
