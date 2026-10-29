(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PersonalLinks = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const CARD = /^p[0-9]{2,5}$/;
  function validCard(id) { return typeof id === 'string' && CARD.test(id); }
  function validRound(n) { return Number.isInteger(n) && n >= 1 && n <= 999; }
  function parse(hash) {
    if (!hash || hash === '#') return null;
    const data = new URLSearchParams(hash.replace(/^#/, ''));
    if (!data.has('card')) return null;
    if ([...data.keys()].sort().join(',') !== 'card,round') throw new Error('INVALID_CARD_LINK');
    const card = data.get('card'), rawRound = data.get('round');
    if (!validCard(card) || !/^[1-9]\d{0,2}$/.test(rawRound || '')) throw new Error('INVALID_CARD_LINK');
    return { card, round: Number(rawRound) };
  }
  function url(base, card, round, revision = '') {
    if (!validCard(card) || !validRound(round)) throw new Error('INVALID_CARD_LINK');
    const result = new URL(base);
    if (!['https:', 'http:'].includes(result.protocol) || result.username || result.password) throw new Error('INVALID_CARD_URL');
    result.hash = new URLSearchParams({ card, round: String(round) }).toString();
    if (revision) {
      if (!/^[1-9]\d{0,19}\.[1-9]\d{0,4}$/.test(revision)) throw new Error('INVALID_REVISION');
      result.searchParams.set('v', revision);
    }
    return result.href;
  }
  function resolve(board, target) {
    const people = board.members.filter(p => p.cardId === target.card);
    const rounds = board.rounds.filter(r => r.number === target.round);
    if (people.length !== 1 || rounds.length !== 1 || (people[0].joinedRound || 1) > target.round) throw new Error('CARD_NOT_FOUND');
    return { person: people[0], round: rounds[0] };
  }
  return { validCard, validRound, parse, url, resolve };
});
