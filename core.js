/* Fit-Tracker – Logik ohne Oberfläche (Schlaf, Messreihen, Stress). Wird von index.html geladen. */
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

  // Block-Namen in der Datei (#Name) -> interner Name
  var BLOCKS = {
    schlaf: 'sleep', sleep: 'sleep',
    ruhepuls: 'rest', restingheartrate: 'rest',
    hrv: 'hrv', herzfrequenzvariabilitat: 'hrv',
    vo2max: 'vo2', kardiofitness: 'vo2', cardiofitness: 'vo2',
    herzfrequenz: 'hr', herfrequenz: 'hr', heartrate: 'hr',
    schritte: 'steps', steps: 'steps'
  };
  var SERIES_NAMES = ['rest', 'hrv', 'vo2', 'hr', 'steps'];

  var DATE_LIKE_RE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/;
  var DATE_RE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/;
  var NUM_RE = /^(-?\d+(?:[.,]\d+)?)(?:\s+\S.*)?$/;

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

  function normBlock(label) {
    var s = String(label).replace(/^#+/, '').trim().toLowerCase()
      .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]/g, '');
    return BLOCKS[s] || null;
  }

  function parseNumber(line) {
    var m = NUM_RE.exec(line);
    if (!m) { return null; }
    var v = parseFloat(m[1].replace(',', '.'));
    return isFinite(v) ? v : null;
  }

  function emptySeries() { return { rest: [], hrv: [], vo2: [], hr: [], steps: [] }; }

  // Liest eine Datei. Blöcke beginnen mit "#Name". Ohne Marker am Anfang gilt: Schlaf (alte Dateien).
  function parseExport(text) {
    var lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    var segs = [];
    var series = emptySeries();
    var seen = {};
    var stats = {
      records: 0, used: 0, duplicates: 0, badDates: 0, reversed: 0,
      incomplete: 0, stray: 0, ignored: {}, suspectFormat: false,
      blocks: [], unknownBlocks: [], series: {}
    };
    SERIES_NAMES.forEach(function (n) { stats.series[n] = { used: 0, duplicates: 0, incomplete: 0, stray: 0 }; });
    var block = 'sleep';
    var cur = null;       // Schlaf: aktuelle Messung
    var pending = null;   // Messreihen: gelesener Wert, wartet auf Datum

    function finishSleep() {
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

    function closeBlock() {
      if (block === 'sleep') {
        if (cur && cur.dates.length < 2) { stats.incomplete++; }
        cur = null;
      } else if (SERIES_NAMES.indexOf(block) >= 0) {
        if (pending !== null) { stats.series[block].incomplete++; }
        pending = null;
      }
    }

    function markSeen(name) { if (stats.blocks.indexOf(name) < 0) { stats.blocks.push(name); } }

    var first = true;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) { continue; }
      if (line.charAt(0) === '#') {
        closeBlock();
        var nb = normBlock(line);
        if (nb) { block = nb; markSeen(nb); }
        else { block = 'unknown'; if (stats.unknownBlocks.indexOf(line) < 0) { stats.unknownBlocks.push(line); } }
        first = false;
        continue;
      }
      if (first) { markSeen('sleep'); first = false; }
      if (block === 'unknown') { continue; }

      if (block === 'sleep') {
        var d = parseDateLine(line);
        if (d === null) {
          if (cur && cur.dates.length < 2) { stats.incomplete++; }
          cur = { label: line, dates: [] };
        } else {
          if (!cur || cur.dates.length >= 2) { stats.stray++; continue; }
          if (!d.ok) { stats.badDates++; cur.dates.push(NaN); } else { cur.dates.push(d.min); }
          if (cur.dates.length === 2) { finishSleep(); }
        }
      } else {
        var st = stats.series[block];
        var dt = parseDateLine(line);
        if (dt === null) {
          var v = parseNumber(line);
          if (v === null) { st.stray++; continue; }
          if (pending !== null) { st.incomplete++; }
          pending = v;
        } else {
          if (pending === null) { st.stray++; continue; }
          if (!dt.ok) { stats.badDates++; pending = null; continue; }
          series[block].push({ t: dt.min, v: pending });
          st.used++;
          pending = null;
        }
      }
    }
    closeBlock();

    var seriesUsed = 0;
    SERIES_NAMES.forEach(function (n) { seriesUsed += stats.series[n].used; });
    var total = stats.records + seriesUsed + stats.badDates;
    stats.suspectFormat = total > 0 && (stats.reversed + stats.badDates) / total > 0.1;
    segs.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    ['rest', 'hrv', 'vo2'].forEach(function (n) { series[n] = dedupeSeries(series[n]); });
    ['hr', 'steps'].forEach(function (n) { series[n].sort(function (a, b) { return a.t - b.t; }); });
    return { segments: segs, series: series, stats: stats };
  }

  // Selten gemessene Werte (Ruhepuls, HRV, VO2max): bei gleichem Zeitpunkt gewinnt der spätere Eintrag.
  function dedupeSeries(list) {
    var map = {};
    list.forEach(function (p) { map[p.t] = p; });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.t - b.t; });
  }

  // Seltene Messreihen zusammenführen: gleicher Zeitpunkt wird ersetzt, alles andere bleibt.
  function mergeSeries(stored, incoming) {
    var map = {};
    stored.forEach(function (p) { map[p.t] = p; });
    incoming.forEach(function (p) { map[p.t] = p; });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.t - b.t; });
  }

  // Dichte Messreihen (Puls, Schritte): Die neue Datei ist maßgeblich für den Zeitraum vom ersten bis zum letzten Eintrag.
  // Gespeicherte Einträge in diesem Zeitraum werden ersetzt, alles davor und danach bleibt.
  // Mehrere Einträge in derselben Minute bleiben erhalten (wichtig für Schritte, die je Eintrag nur ein Teil des Tages sind).
  function mergeRange(stored, incoming) {
    if (!incoming.length) { return stored.slice(); }
    var lo = Infinity, hi = -Infinity;
    incoming.forEach(function (p) { if (p.t < lo) { lo = p.t; } if (p.t > hi) { hi = p.t; } });
    var kept = stored.filter(function (p) { return p.t < lo || p.t > hi; });
    return kept.concat(incoming).sort(function (a, b) { return a.t - b.t; });
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


  /* ---------- Messreihen ---------- */

  function median(arr) {
    if (!arr.length) { return null; }
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function quantile(arr, q) {
    if (!arr.length) { return null; }
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
  }

  // Herzfrequenz aus "Gruppieren nach" kann Summen statt Pulswerten liefern (z. B. 720 = 12 Messungen à 60).
  function hrLooksLikeSums(list) {
    if (list.length < 3) { return false; }
    return median(list.map(function (p) { return p.v; })) > 220;
  }

  // Letzter Wert je Tag.
  function dailyLast(list) {
    var out = {};
    list.forEach(function (p) {
      var k = dateKey(p.t);
      if (!out[k] || p.t >= out[k].t) { out[k] = { t: p.t, v: p.v }; }
    });
    return out;
  }

  // Summe je Tag (Schritte: jeder Eintrag ist ein Teil des Tages).
  function dailySums(list) {
    var out = {};
    list.forEach(function (p) {
      var k = dateKey(p.t);
      out[k] = (out[k] || 0) + p.v;
    });
    return out;
  }

  // Mittelwert, Minimum, Maximum je Tag.
  function dailyStats(list) {
    var out = {};
    list.forEach(function (p) {
      var k = dateKey(p.t);
      var o = out[k] || (out[k] = { sum: 0, n: 0, min: Infinity, max: -Infinity, list: [] });
      o.sum += p.v; o.n++; o.list.push(p);
      if (p.v < o.min) { o.min = p.v; }
      if (p.v > o.max) { o.max = p.v; }
    });
    Object.keys(out).forEach(function (k) { out[k].v = out[k].sum / out[k].n; });
    return out;
  }

  function hourStart(t) {
    var d = new Date(t * 60000);
    d.setMinutes(0, 0, 0);
    return Math.round(d.getTime() / 60000);
  }

  // Herzfrequenz je volle Stunde: Mittel, Min, Max, Anzahl.
  function hourlyHR(hr) {
    var map = {};
    hr.forEach(function (p) {
      var h = hourStart(p.t);
      var b = map[h] || (map[h] = { t: h, sum: 0, n: 0, min: Infinity, max: -Infinity });
      b.sum += p.v; b.n++;
      if (p.v < b.min) { b.min = p.v; }
      if (p.v > b.max) { b.max = p.v; }
    });
    return Object.keys(map).map(function (k) {
      var b = map[k];
      var d = new Date(b.t * 60000);
      return { t: b.t, key: dateKey(b.t), h: d.getHours(), avg: b.sum / b.n, min: b.min, max: b.max, n: b.n };
    }).sort(function (a, b) { return a.t - b.t; });
  }

  // Verdacht auf Aktivität: Die Watch misst bei Anstrengung deutlich häufiger als in Ruhe (ca. alle 5 Minuten).
  // Ein Zeitfenster gilt als dicht, wenn darin mindestens DENSE_N Messungen innerhalb von DENSE_SPAN Minuten liegen
  // und der Puls dort deutlich (mindestens 160 %) über dem Ruhepuls liegt. Die Watch misst auch in der Erholungsphase dicht, aber dort ist der Puls niedriger.
  var DENSE_N = 5, DENSE_SPAN = 6, DENSE_JOIN = 5, DENSE_MINRATIO = 1.6;
  function activityWindows(hr, base) {
    var w = [];
    var n = hr.length;
    var j = 0;
    for (var i = 0; i < n; i++) {
      if (j < i) { j = i; }
      while (j + 1 < n && hr[j + 1].t - hr[i].t <= DENSE_SPAN) { j++; }
      if (j - i + 1 >= DENSE_N) {
        var mx = 0;
        for (var q = i; q <= j; q++) { if (hr[q].v > mx) { mx = hr[q].v; } }
        if (base === null || mx >= base * DENSE_MINRATIO) {
          w.push({ s: hr[i].t, e: hr[j].t });
        }
      }
    }
    // zusammenfassen (mit Nachlauf)
    var out = [];
    w.forEach(function (x) {
      var last = out[out.length - 1];
      if (last && x.s <= last.e + DENSE_JOIN) { if (x.e > last.e) { last.e = x.e; } }
      else { out.push({ s: x.s, e: x.e }); }
    });
    out.forEach(function (x) {
      var mx = 0, cnt = 0;
      hr.forEach(function (p) { if (p.t >= x.s && p.t <= x.e) { cnt++; if (p.v > mx) { mx = p.v; } } });
      x.max = mx; x.n = cnt;
    });
    return out;
  }

  // Stress-Stufen (offene Skala: über 100 ist möglich).
  function stressLabel(v) {
    if (v === null || v === undefined) { return ''; }
    if (v < 25) { return 'niedrig'; }
    if (v < 50) { return 'mäßig'; }
    if (v < 75) { return 'erhöht'; }
    if (v <= 100) { return 'hoch'; }
    return 'sehr hoch';
  }

  /* Stress-Indikator (eigene Schätzung, kein medizinischer Wert).
     Je volle Stunde: Herzfrequenz im Verhältnis zum Ruhepuls (0 Punkte bei ≤ 115 %, 100 Punkte bei 175 %, darüber weiter steigend).
     Liegt in der Stunde ein HRV-Wert vor, geht er zu 40 % ein (0 bei ≥ eigenem Median, 100 bei ≤ halbem Median).
     Aktivität wird nicht herausgerechnet, nur als Verdacht markiert (hour.activity). */
  function computeStress(input) {
    var res = { status: 'ok', baseHR: null, baseApprox: false, baseHRV: null, hours: [], days: [], activity: [] };
    var hr = input.hr || [];
    var hrv = input.hrv || [];
    var rest = input.rest || [];
    if (hrLooksLikeSums(hr)) { res.status = 'sums'; return res; }
    if (!hr.length) { res.status = 'nohr'; return res; }

    var base = rest.length >= 2 ? median(rest.map(function (p) { return p.v; })) : null;
    if (base === null && hr.length >= 30) { base = quantile(hr.map(function (p) { return p.v; }), 0.1); res.baseApprox = true; }
    if (base === null) { res.status = 'nobase'; return res; }
    res.baseHR = base;
    res.baseHRV = hrv.length >= 4 ? median(hrv.map(function (p) { return p.v; })) : null;

    res.activity = activityWindows(hr, base);
    function inActivity(h) {
      for (var i = 0; i < res.activity.length; i++) {
        var a = res.activity[i];
        if (a.s < h + 60 && a.e >= h) { return true; }
      }
      return false;
    }

    var hrvByHour = {};
    hrv.forEach(function (p) {
      if (res.baseHRV === null) { return; }
      var h = hourStart(p.t);
      (hrvByHour[h] || (hrvByHour[h] = [])).push(p.v);
    });

    var hours = [];
    hourlyHR(hr).forEach(function (b) {
      if (b.n < 2) { return; }
      var sHR = Math.max(0, (b.avg / base - 1.15) / (1.75 - 1.15) * 100);
      var s = sHR, usedHrv = false;
      var hv = hrvByHour[b.t];
      if (hv && hv.length) {
        var avgHv = hv.reduce(function (a, c) { return a + c; }, 0) / hv.length;
        var sHRV = clamp((res.baseHRV - avgHv) / (0.5 * res.baseHRV), 0, 1) * 100;
        s = 0.6 * sHR + 0.4 * sHRV;
        usedHrv = true;
      }
      hours.push({ t: b.t, key: b.key, h: b.h, hr: b.avg, hrMax: b.max, n: b.n, stress: Math.round(s), usedHrv: usedHrv, activity: inActivity(b.t) });
    });
    res.hours = hours;

    var byDay = {};
    hours.forEach(function (x) { (byDay[x.key] || (byDay[x.key] = [])).push(x); });
    res.days = Object.keys(byDay).sort().map(function (k) {
      var hs = byDay[k];
      var sum = 0, peak = hs[0];
      hs.forEach(function (x) { sum += x.stress; if (x.stress > peak.stress) { peak = x; } });
      return { key: k, avg: Math.round(sum / hs.length), peakHour: peak.h, peakValue: peak.stress, hours: hs.length, activityHours: hs.filter(function (x) { return x.activity; }).length };
    });
    return res;
  }

  // Alte Herzfrequenz-Rohdaten begrenzen (nur Speicherplatz).
  function pruneHR(list, nowMin, days) {
    var cut = nowMin - days * 1440;
    return list.filter(function (p) { return p.t >= cut; });
  }

  var api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    SERIES_NAMES: SERIES_NAMES,
    parseExport: parseExport,
    emptySeries: emptySeries,
    mergeSegments: mergeSegments,
    mergeSeries: mergeSeries,
    mergeRange: mergeRange,
    buildSessions: buildSessions,
    pickNights: pickNights,
    scoreNight: scoreNight,
    dateKey: dateKey,
    minuteOfDay: minuteOfDay,
    median: median,
    quantile: quantile,
    hrLooksLikeSums: hrLooksLikeSums,
    dailyLast: dailyLast,
    dailySums: dailySums,
    dailyStats: dailyStats,
    hourlyHR: hourlyHR,
    activityWindows: activityWindows,
    computeStress: computeStress,
    stressLabel: stressLabel,
    pruneHR: pruneHR
  };

  root.FitCore = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
