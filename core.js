/* Fit-Tracker – Schlaf-Logik (ohne Oberfläche). Wird von index.html geladen. */
(function (root) {
  'use strict';

  var PHASE_BY_LABEL = {
    kern: 'K', core: 'K',
    tief: 'T', deep: 'T',
    rem: 'R',
    wach: 'W', awake: 'W'
  };

  // Alle Zeiten in Minuten. Diese Werte sind die Startwerte, in der App änderbar.
  var DEFAULT_CONFIG = {
    durFullMin: 510,        // 8,5 h = volle Punkte
    durZeroMin: 300,        // 5 h = 0 Punkte
    deepFullMin: 90,
    deepZeroMin: 30,
    remFullMin: 100,
    remZeroMin: 30,
    onsetFrom: 21 * 60,     // Einschlaf-Fenster ab 21:00
    onsetTo: 23 * 60,       // bis 23:00
    minSleepForScore: 180,  // unter 3 h Schlaf: "unvollständig", kein Score
    sessionGapMin: 90       // mehr als 90 Min Lücke trennt zwei Schlafphasen
  };

  var DATE_LIKE_RE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/;
  var DATE_RE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Gibt null zurück, wenn die Zeile kein Datum ist; {ok:false} bei kaputtem Datum.
  function parseDateLine(line) {
    if (!DATE_LIKE_RE.test(line)) { return null; }
    var m = DATE_RE.exec(line);
    if (!m) { return { ok: false }; }
    var d = +m[1], mo = +m[2], y = +m[3], h = +m[4], mi = +m[5];
    var ap = m[6] ? m[6].toLowerCase() : null;
    if (ap) {
      if (h < 1 || h > 12) { return { ok: false }; }
      if (ap === 'pm' && h < 12) { h += 12; }
      if (ap === 'am' && h === 12) { h = 0; }
    }
    var dt = new Date(y, mo - 1, d, h, mi, 0, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d ||
        dt.getHours() !== h || dt.getMinutes() !== mi) {
      return { ok: false };
    }
    return { ok: true, min: Math.round(dt.getTime() / 60000) };
  }

  // Liest den Text aus schlaf.txt: je Messung "Phase", "Start", "Ende".
  function parseExport(text) {
    var lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    var segs = [];
    var seen = {};
    var stats = {
      records: 0, used: 0, duplicates: 0, badDates: 0, reversed: 0,
      incomplete: 0, stray: 0, ignored: {}, suspectFormat: false
    };
    var cur = null;

    function finish() {
      stats.records++;
      var s = cur.dates[0], e = cur.dates[1];
      if (isNaN(s) || isNaN(e)) { return; }
      var p = PHASE_BY_LABEL[cur.label.toLowerCase()];
      if (!p) { stats.ignored[cur.label] = (stats.ignored[cur.label] || 0) + 1; return; }
      if (e < s) { stats.reversed++; return; }
      var key = p + '|' + s + '|' + e;
      if (seen[key]) { stats.duplicates++; return; }
      seen[key] = true;
      segs.push({ s: s, e: e, p: p });
      stats.used++;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { continue; }
      var d = parseDateLine(line);
      if (d === null) {
        if (cur && cur.dates.length < 2) { stats.incomplete++; }
        cur = { label: line, dates: [] };
      } else {
        if (!cur || cur.dates.length >= 2) { stats.stray++; continue; }
        if (!d.ok) { stats.badDates++; cur.dates.push(NaN); } else { cur.dates.push(d.min); }
        if (cur.dates.length === 2) { finish(); }
      }
    }
    if (cur && cur.dates.length < 2) { stats.incomplete++; }

    stats.suspectFormat = stats.records > 0 && (stats.reversed + stats.badDates) / stats.records > 0.1;
    segs.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    return { segments: segs, stats: stats };
  }

  // Eine Datei ist maßgeblich für den Zeitraum, den sie abdeckt (frühester Start bis spätestes Ende).
  // Gespeicherte Abschnitte in diesem Zeitraum werden ersetzt, alles davor und danach bleibt.
  // Immer nur eine Datei auf einmal zusammenführen.
  function mergeSegments(stored, incoming) {
    if (!incoming.length) { return stored.slice(); }
    var smin = Infinity, emax = -Infinity;
    incoming.forEach(function (x) {
      if (x.s < smin) { smin = x.s; }
      if (x.e > emax) { emax = x.e; }
    });
    var kept = stored.filter(function (x) {
      return x.e < smin || (x.e === smin && x.s < x.e) ||
             x.s > emax || (x.s === emax && x.e > x.s);
    });
    return kept.concat(incoming).sort(function (a, b) { return a.s - b.s || a.e - b.e; });
  }

  function dateKey(epochMin) {
    var d = new Date(epochMin * 60000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function minuteOfDay(epochMin) {
    var d = new Date(epochMin * 60000);
    return d.getHours() * 60 + d.getMinutes();
  }

  // Fasst Abschnitte zu zusammenhängenden Schlafphasen zusammen.
  function buildSessions(segments, cfg) {
    var sorted = segments.slice().sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    var clean = [];
    var prevEnd = -Infinity;
    sorted.forEach(function (x) {
      var s = Math.max(x.s, prevEnd);
      if (x.e < s) { return; }
      if (x.e === s && x.s !== x.e) { return; }
      clean.push({ s: s, e: x.e, p: x.p });
      if (x.e > prevEnd) { prevEnd = x.e; }
    });

    var groups = [];
    var cur = null;
    clean.forEach(function (x) {
      if (!cur || x.s - cur.lastEnd > cfg.sessionGapMin) {
        cur = { segs: [], lastEnd: x.e };
        groups.push(cur);
      }
      cur.segs.push(x);
      if (x.e > cur.lastEnd) { cur.lastEnd = x.e; }
    });

    var out = [];
    groups.forEach(function (g) {
      var a = g.segs.slice();
      while (a.length && a[0].p === 'W') { a.shift(); }
      while (a.length && a[a.length - 1].p === 'W') { a.pop(); }
      if (!a.length) { return; }
      var m = { K: 0, T: 0, R: 0, W: 0 };
      var awakenings = 0;
      a.forEach(function (x) {
        m[x.p] += x.e - x.s;
        if (x.p === 'W') { awakenings++; }
      });
      var start = a[0].s;
      var end = a[a.length - 1].e;
      out.push({
        segs: a, start: start, end: end, minutes: m,
        sleepMin: m.K + m.T + m.R, awakenings: awakenings,
        dateKey: dateKey(end)
      });
    });
    return out;
  }

  // Pro Aufwach-Datum zählt die längste Schlafphase als "Nacht".
  function pickNights(sessions) {
    var byDate = {};
    sessions.forEach(function (s) {
      var b = byDate[s.dateKey];
      if (!b) { byDate[s.dateKey] = { dateKey: s.dateKey, session: s, others: [] }; return; }
      if (s.sleepMin > b.session.sleepMin) { b.others.push(b.session); b.session = s; }
      else { b.others.push(s); }
    });
    return Object.keys(byDate).sort().map(function (k) {
      var b = byDate[k];
      var napMin = 0;
      b.others.forEach(function (o) { napMin += o.sleepMin; });
      return { dateKey: k, session: b.session, napCount: b.others.length, napMin: napMin };
    });
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lin(v, zero, full) { return clamp((v - zero) / (full - zero), 0, 1); }
  function round1(v) { return Math.round(v * 10) / 10; }

  // Einschlafzeit: Fenster 21–23 Uhr = 10 Punkte, danach -1 Punkt je 10 Minuten Abweichung.
  function onsetPoints(startEpochMin, cfg) {
    var t = minuteOfDay(startEpochMin);
    if (t < 12 * 60) { t += 24 * 60; }   // nach Mitternacht = spät
    var dev = 0;
    if (t < cfg.onsetFrom) { dev = cfg.onsetFrom - t; }
    else if (t > cfg.onsetTo) { dev = t - cfg.onsetTo; }
    return { points: round1(clamp(10 - dev / 10, 0, 10)), deviationMin: dev };
  }

  function scoreNight(session, cfg) {
    var m = session.minutes;
    var dur = 30 * lin(session.sleepMin, cfg.durZeroMin, cfg.durFullMin);
    var deep = 30 * lin(m.T, cfg.deepZeroMin, cfg.deepFullMin);
    var rem = 30 * lin(m.R, cfg.remZeroMin, cfg.remFullMin);
    var on = onsetPoints(session.start, cfg);
    var incomplete = session.sleepMin < cfg.minSleepForScore;
    var parts = { dur: round1(dur), deep: round1(deep), rem: round1(rem), onset: on.points };
    return {
      incomplete: incomplete,
      parts: parts,
      onsetDeviationMin: on.deviationMin,
      total: incomplete ? null : Math.round(dur + deep + rem + on.points)
    };
  }

  var api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    parseExport: parseExport,
    mergeSegments: mergeSegments,
    buildSessions: buildSessions,
    pickNights: pickNights,
    scoreNight: scoreNight,
    dateKey: dateKey,
    minuteOfDay: minuteOfDay
  };

  root.FitCore = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
