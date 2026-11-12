(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Participation = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const DAY = 86400000, ANCHOR = Date.UTC(2026, 6, 6);
  function day(date) { return Date.parse(date + 'T00:00:00Z'); }
  function roundForDate(date) { return 1 + Math.floor((day(date) - ANCHOR) / (7 * DAY)); }
  function segments(person, rounds) {
    return (person.trackPauses || []).map((pause, i, all) => {
      const explicit = pause.pitStopRound ?? (i === all.length - 1 ? person.pitStopRound : null);
      const legacy = rounds.find(r => r.marks?.[person.name]?.pit && (!pause.resumedAt || r.number < roundForDate(pause.resumedAt)));
      return { start: explicit ?? legacy?.number ?? roundForDate(new Date(day(pause.pausedAt) + DAY).toISOString().slice(0, 10)),
        end: pause.resumedAt ? roundForDate(pause.resumedAt) : Infinity, legacyBridge: pause.pitStopRound == null };
    });
  }
  function roundState(person, roundNumber, rounds) {
    const mark = rounds.find(r => r.number === roundNumber)?.marks?.[person.name] || {};
    if (mark.entered || mark.finished || mark.skip || mark.startIcon) return 'track';
    if (mark.pit) return 'pit';
    for (const pause of segments(person, rounds)) {
      if (roundNumber === pause.start && roundNumber <= pause.end) return 'pit';
      if (roundNumber > pause.start && roundNumber < pause.end) return 'paused';
      const last = rounds.filter(r => r.number < pause.start && (r.marks?.[person.name]?.entered || r.marks?.[person.name]?.finished))
        .reduce((n, r) => Math.max(n, r.number), 0);
      if (pause.legacyBridge && last > 0 && roundNumber > last && roundNumber < pause.start) return 'bridge';
    }
    return 'track';
  }
  function daysOnTrack(person, today) {
    if (!person?.firstReport) return 0;
    const start = day(person.firstReport), end = day(today) + DAY;
    const total = Math.max(0, (end - start) / DAY);
    const paused = (person.trackPauses || []).reduce((n, p) => {
      const from = Math.max(start, day(p.pausedAt) + DAY);
      const to = Math.min(end, p.resumedAt ? day(p.resumedAt) : end);
      return n + Math.max(0, (to - from) / DAY);
    }, 0);
    return Math.max(0, total - paused);
  }
  return {roundForDate, roundState, daysOnTrack, segments};
});
