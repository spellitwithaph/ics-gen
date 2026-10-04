/*!
 * ICS Generator v1.0.0
 *
 * A tiny, dependency-free iCalendar (.ics) generator that runs entirely in the
 * browser (or Node), which means it can be hosted on any static site — no
 * server, no build step, no API keys.
 *
 * Generates RFC 5545 compliant output: CRLF line endings, text escaping,
 * 75-octet line folding, UTC or TZID timestamps, all-day events (with the RFC's
 * exclusive DTEND), recurrence rules, attendees, and VALARM reminders.
 *
 * Security: TEXT values are escaped per RFC 5545, and every single-line value
 * (URLs, emails, rules, time zones, status/role/action tokens, triggers)
 * rejects control characters, so untrusted input cannot inject extra lines
 * into the generated .ics file. URLs are restricted to absolute http(s) links.
 *
 * Usage:
 *   <script src="ics.js"></script>
 *   const cal = new IcsGenerator.Calendar({ name: 'My Events' });
 *   cal.addEvent({ title: 'Standup', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
 *   IcsGenerator.download('events.ics', cal.toString());
 *
 * Works as a Node module too: const IcsGenerator = require('./ics.js');
 */
(function () {
  'use strict';

  var PRODID = '-//ICS Generator//EN';
  var CRLF = '\r\n';

  function pad2(n) {
    n = Number(n);
    return (n < 10 ? '0' : '') + n;
  }

  /* RFC 5545 §3.3.11 — escape special characters in TEXT values. */
  function escapeText(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n')
      /* C0 controls other than TAB/CR/LF (handled above) and DEL are not
       * allowed in TEXT values — drop them defensively. */
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  /* RFC 5545 §3.2 — escape special characters in parameter values. */
  function escapeParam(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/:/g, '\\:')
      .replace(/,/g, '\\,');
  }

  /*
   * Reject raw control characters in single-line values (URLs, emails, rules,
   * status/role/action tokens, trigger strings). Allowing CR/LF here would let
   * untrusted input inject arbitrary lines into the generated .ics document.
   */
  function rejectControlChars(value, label) {
    if (/[\u0000-\u001F\u007F]/.test(String(value))) {
      throw new Error('ICS Generator: ' + label + ' must not contain control characters.');
    }
  }

  /*
   * Loose but effective mailto check: exactly one non-empty local part and a
   * dotted domain, and no whitespace/control characters (which also blocks
   * CR/LF line injection through the mailto: value).
   */
  function assertEmail(email, label) {
    email = String(email == null ? '' : email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('ICS Generator: invalid ' + label + ' email address.');
    }
    return email;
  }

  /*
   * Only absolute http(s) links may be embedded as URL; javascript:, data: and
   * friends are rejected to avoid scheme-injection and phishing-style values.
   */
  function sanitizeUrl(url) {
    var s = String(url == null ? '' : url).trim();
    rejectControlChars(s, 'event "url"');
    var m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
    var scheme = m ? m[1].toLowerCase() : '';
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error('ICS Generator: event "url" must be an absolute http(s) URL.');
    }
    return s;
  }

  /*
   * RFC 5545 §3.1 — no content line may exceed 75 octets; longer lines are
   * folded at 75-octet boundaries and each continuation line is prefixed with
   * a single space. Folding is UTF-8-octet aware and never splits a multi-byte
   * code point (emoji, accents).
   */
  function utf8ByteLen(cp) {
    if (cp < 0x80) return 1;
    if (cp < 0x800) return 2;
    if (cp < 0x10000) return 3;
    return 4;
  }

  function foldLines(text) {
    var out = [];
    var lines = String(text).split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var cps = Array.from(lines[i]);
      var line = '';
      var octets = 0;
      for (var j = 0; j < cps.length; j++) {
        var b = utf8ByteLen(cps[j].codePointAt(0));
        if (line && octets + b > 75) {
          out.push(line);
          line = ' ' + cps[j];
          octets = 1 + b;
        } else {
          line += cps[j];
          octets += b;
        }
      }
      out.push(line);
    }
    return out.join(CRLF);
  }

  /* '2026-01-05T10:30:00Z' → '20260105T103000Z' */
  function formatDateTimeUTC(date) {
    return (
      date.getUTCFullYear() +
      pad2(date.getUTCMonth() + 1) +
      pad2(date.getUTCDate()) +
      'T' +
      pad2(date.getUTCHours()) +
      pad2(date.getUTCMinutes()) +
      pad2(date.getUTCSeconds()) +
      'Z'
    );
  }

  /* Accepts a Date (formatted from its UTC fields) or { year, month, day } (used as-is). */
  function formatDateUTC(value) {
    if (isDateParts(value)) {
      return value.year + pad2(value.month) + pad2(value.day);
    }
    var d = value instanceof Date ? value : new Date(value);
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  }

  /* Building an Intl.DateTimeFormat is expensive and offset sampling calls
   * zoneParts thousands of times per render, so one formatter is cached per
   * zone for the lifetime of the page. */
  var zoneFormatterCache = Object.create(null);

  function zoneFormatter(timeZone) {
    var formatter = zoneFormatterCache[timeZone];
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      zoneFormatterCache[timeZone] = formatter;
    }
    return formatter;
  }

  /* Wall-clock components a Date shows in an IANA zone, as numbers. */
  function zoneParts(date, timeZone) {
    var parts = {};
    zoneFormatter(timeZone)
      .formatToParts(date)
      .forEach(function (p) {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
      });
    return parts;
  }

  /* Wall-clock time in an IANA time zone, e.g. '20260115T120000' for America/New_York. */
  function formatDateTimeInZone(date, timeZone) {
    var p = zoneParts(date, timeZone);
    return p.year + pad2(p.month) + pad2(p.day) + 'T' + pad2(p.hour) + pad2(p.minute) + pad2(p.second);
  }

  /*
   * Interpret year-month-day h:mi[:ss] as wall-clock time in `timeZone` and
   * return the matching Date. Iterates because the first guess can land on the
   * far side of a DST transition.
   */
  function zonedTimeToDate(year, month, day, hour, minute, timeZone, second) {
    var target = Date.UTC(year, month - 1, day, hour, minute, second || 0);
    var ts = target;
    for (var i = 0; i < 3; i++) {
      var p = zoneParts(new Date(ts), timeZone);
      var asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      var delta = target - asUTC;
      if (delta === 0) break;
      ts += delta;
    }
    return new Date(ts);
  }

  /* ---------- VTIMEZONE (best-effort) ---------- */

  var MS_PER_DAY = 86400000;

  /*
   * UTC offset (minutes east of UTC) a zone shows at the given instant. A
   * long-offset formatter reports the offset directly and its format() is
   * several times faster than reconstructing wall-clock parts; transition
   * sampling issues thousands of these probes per render, so the formatter is
   * cached per zone and the offset text is parsed rather than derived.
   */
  var zoneOffsetFormatterCache = Object.create(null);

  function zoneOffsetFormatter(timeZone) {
    var formatter = zoneOffsetFormatterCache[timeZone];
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: timeZone, timeZoneName: 'longOffset' });
      zoneOffsetFormatterCache[timeZone] = formatter;
    }
    return formatter;
  }

  function zoneOffsetMinutes(ts, timeZone) {
    var m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(
      zoneOffsetFormatter(timeZone).format(new Date(ts))
    );
    if (!m) return 0; /* a bare 'GMT' means UTC */
    var mins = Number(m[2]) * 60 + Number(m[3] || 0);
    return m[1] === '-' ? -mins : mins;
  }

  /* Signed ±HHMM offset token used by TZOFFSETFROM/TZOFFSETTO. */
  function formatOffsetMinutes(mins) {
    var sign = mins < 0 ? '-' : '+';
    var abs = Math.abs(Math.round(mins));
    return sign + pad2(Math.floor(abs / 60)) + pad2(abs % 60);
  }

  /* Intl's short zone name (e.g. EST/EDT) — optional, omitted when unavailable. */
  var zoneNameFormatterCache = Object.create(null);

  function zoneNameFormatter(timeZone) {
    var formatter = zoneNameFormatterCache[timeZone];
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: timeZone, timeZoneName: 'short' });
      zoneNameFormatterCache[timeZone] = formatter;
    }
    return formatter;
  }

  function zoneShortName(ts, timeZone) {
    try {
      var parts = zoneNameFormatter(timeZone).formatToParts(new Date(ts));
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') return parts[i].value;
      }
    } catch (e) { /* zone names are best-effort only */ }
    return null;
  }

  /*
   * Best-effort approximation: instead of shipping a tzdata table, sample the
   * zone's UTC offset at ~15-day steps across the requested year, then bisect
   * each detected change down to second precision. Onset instants are therefore
   * second-accurate (whole-second tzdata transitions land exactly), and exotic
   * zones with many offsets are reduced to the two longest-lived ones — enough
   * for a strict/offline client to resolve the TZID, not a byte-exact tzdata
   * dump. Results are cached per zone+year because a zone's rules for a given
   * year never change within a page session; without this, every render that
   * rebuilds the preview would re-sample every zone from scratch.
   */
  var zoneTransitionsCache = Object.create(null);

  function zoneTransitions(timeZone, year) {
    var cacheKey = timeZone + '|' + year;
    var cached = zoneTransitionsCache[cacheKey];
    if (cached) return cached;
    var start = Date.UTC(year, 0, 1);
    var end = Date.UTC(year + 1, 0, 1);
    var step = 15 * MS_PER_DAY;
    var transitions = [];
    var prevT = start;
    var prevOff = zoneOffsetMinutes(start, timeZone);
    var t = start;
    while (t < end) {
      t = Math.min(t + step, end);
      var off = zoneOffsetMinutes(t, timeZone);
      if (off !== prevOff) {
        var lo = prevT;
        var hi = t;
        while (hi - lo > 1000) {
          var mid = Math.floor((lo + hi) / 2 / 1000) * 1000;
          if (zoneOffsetMinutes(mid, timeZone) === prevOff) lo = mid;
          else hi = mid;
        }
        transitions.push({ at: hi, from: prevOff, to: off });
        prevOff = off;
      }
      prevT = t;
    }
    zoneTransitionsCache[cacheKey] = transitions;
    return transitions;
  }

  /* One VTIMEZONE block for `timeZone`. Every distinct year that actually has
   * an event in this zone is mandatory — dropping one silently mis-resolves
   * that year's events, so no contiguous-range sampling is used. One
   * recurrence-margin year past the latest event is added only when it still
   * fits the budget, so near-term recurrences keep resolving.
   *
   * MAX_VTIMEZONE_YEARS bounds the block size. A pathological calendar with
   * more distinct event years than the budget keeps the first 39 years
   * chronologically plus the LAST one, so the newest events stay correct. */
  var MAX_VTIMEZONE_YEARS = 40;

  function vtimezoneLines(timeZone, years) {
    var tzid = assertTimeZone(timeZone);
    var candidates = (Array.isArray(years) ? years : [years]).filter(function (y) {
      return typeof y === 'number' && isFinite(y);
    });
    if (!candidates.length) candidates = [new Date().getUTCFullYear()];

    /* Distinct event years, in chronological order. */
    var eventYears = [];
    candidates.forEach(function (y) {
      var year = Math.floor(y);
      if (eventYears.indexOf(year) === -1) eventYears.push(year);
    });
    eventYears.sort(function (a, b) { return a - b; });

    var sampled;
    if (eventYears.length > MAX_VTIMEZONE_YEARS) {
      /* Pathological: over budget, so keep the earliest 39 years plus the
       * newest one — the latest events matter most and must stay correct. */
      sampled = eventYears.slice(0, MAX_VTIMEZONE_YEARS - 1)
        .concat(eventYears[eventYears.length - 1]);
    } else {
      sampled = eventYears.slice();
      if (sampled.length < MAX_VTIMEZONE_YEARS) sampled.push(sampled[sampled.length - 1] + 1);
    }

    var transitions = [];
    var byYear = {};
    sampled.forEach(function (year) {
      var yearTransitions = zoneTransitions(tzid, year);
      byYear[year] = yearTransitions;
      transitions = transitions.concat(yearTransitions);
    });

    var lines = ['BEGIN:VTIMEZONE', 'TZID:' + escapeText(tzid)];

    if (!transitions.length) {
      /* A fixed-offset zone: one STANDARD component with equal offsets. */
      var onlyStart = Date.UTC(sampled[0], 0, 1);
      var onlyOffset = zoneOffsetMinutes(onlyStart, tzid);
      lines.push('BEGIN:STANDARD');
      lines.push('DTSTART:19700101T000000');
      lines.push('TZOFFSETFROM:' + formatOffsetMinutes(onlyOffset));
      lines.push('TZOFFSETTO:' + formatOffsetMinutes(onlyOffset));
      var onlyName = zoneShortName(onlyStart, tzid);
      if (onlyName) lines.push('TZNAME:' + escapeText(onlyName));
      lines.push('END:STANDARD');
      lines.push('END:VTIMEZONE');
      return lines;
    }

    /* Rank distinct offsets by how long the zone spends in them across the
     * sampled window, keep the two longest-lived ones, and label the LOWER
     * offset STANDARD and the higher one DAYLIGHT — correct in both hemispheres
     * (Sydney, Dublin) as well as for northern zones. */
    var windowStart = Date.UTC(sampled[0], 0, 1);
    var windowEnd = Date.UTC(sampled[sampled.length - 1] + 1, 0, 1);
    var durations = {};
    var cursor = windowStart;
    var cursorOffset = zoneOffsetMinutes(windowStart, tzid);
    transitions.forEach(function (tr) {
      durations[cursorOffset] = (durations[cursorOffset] || 0) + (tr.at - cursor);
      cursor = tr.at;
      cursorOffset = tr.to;
    });
    durations[cursorOffset] = (durations[cursorOffset] || 0) + (windowEnd - cursor);

    var ranked = Object.keys(durations).map(Number).sort(function (a, b) {
      return durations[b] - durations[a];
    }).slice(0, 2);
    var standardOffset = Math.min.apply(null, ranked);
    var daylightOffset = ranked.length > 1 ? Math.max.apply(null, ranked) : null;

    function transitionInto(offset, yearTransitions) {
      for (var j = 0; j < yearTransitions.length; j++) {
        if (yearTransitions[j].to === offset) return yearTransitions[j];
      }
      return null;
    }

    function emit(type, transition, toOffset) {
      lines.push('BEGIN:' + type);
      /* DTSTART is the wall-clock of the onset in the TZOFFSETFROM frame
       * (tzdata convention) and is a local time, so it carries no trailing Z. */
      lines.push('DTSTART:' + formatDateTimeUTC(
        new Date(transition.at + transition.from * 60000)
      ).slice(0, -1));
      lines.push('TZOFFSETFROM:' + formatOffsetMinutes(transition.from));
      lines.push('TZOFFSETTO:' + formatOffsetMinutes(toOffset));
      var name = zoneShortName(transition.at, tzid);
      if (name) lines.push('TZNAME:' + escapeText(name));
      lines.push('END:' + type);
    }

    /* One STANDARD/DAYLIGHT pair per sampled year that has a transition into
     * that offset, ordered chronologically within the year; multiple pairs are
     * valid and resolved last-onset-wins. */
    sampled.forEach(function (year) {
      var yearTransitions = byYear[year] || [];
      var picks = [];
      if (daylightOffset != null) {
        var daylightTr = transitionInto(daylightOffset, yearTransitions);
        if (daylightTr) picks.push({ type: 'DAYLIGHT', tr: daylightTr, to: daylightOffset });
      }
      var standardTr = transitionInto(standardOffset, yearTransitions);
      if (standardTr) picks.push({ type: 'STANDARD', tr: standardTr, to: standardOffset });
      picks.sort(function (a, b) { return a.tr.at - b.tr.at; });
      picks.forEach(function (pick) { emit(pick.type, pick.tr, pick.to); });
    });

    lines.push('END:VTIMEZONE');
    return lines;
  }

  function isDateParts(v) {
    return (
      v && typeof v === 'object' &&
      typeof v.year === 'number' && typeof v.month === 'number' && typeof v.day === 'number'
    );
  }

  function toDatePartsUTC(d) {
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  function makeUid() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID() + '@ics-generator';
      }
    } catch (e) { /* fall through to the non-crypto fallback */ }
    return (
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      }) + '@ics-generator'
    );
  }

  /* Number of minutes (e.g. 15 → '-PT15M') or an ISO 8601 duration string (e.g. '-PT30M'). */
  function normalizeTrigger(trigger) {
    if (typeof trigger === 'number') {
      return (trigger <= 0 ? '-PT' : 'PT') + Math.abs(trigger) + 'M';
    }
    var s = String(trigger == null ? '-PT15M' : trigger);
    rejectControlChars(s, 'alarm trigger');
    return s;
  }

  function computeEnd(options, allDay) {
    var end = options.end;
    if (end == null) {
      if (allDay) {
        /* DTEND is exclusive, so a single-day event ends the next day. */
        if (isDateParts(options.start)) {
          var d = new Date(Date.UTC(options.start.year, options.start.month - 1, options.start.day + 1));
          return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        }
        return new Date(options.start.getTime() + 86400000);
      }
      if (options.durationMinutes) {
        return new Date(options.start.getTime() + options.durationMinutes * 60000);
      }
      return null; /* punctual event — DTEND omitted */
    }
    if (isDateParts(end)) {
      return allDay ? end : new Date(Date.UTC(end.year, end.month - 1, end.day));
    }
    if (!(end instanceof Date) || isNaN(end.getTime())) {
      throw new Error('ICS Generator: event "end" must be a Date or { year, month, day }.');
    }
    return end;
  }

  function organizerLine(org) {
    org = org || {};
    if (org.name) rejectControlChars(org.name, 'organizer name');
    return 'ORGANIZER' + (org.name ? ';CN=' + escapeParam(org.name) : '') + ':mailto:' + assertEmail(org.email, 'organizer');
  }

  function attendeeLine(a) {
    a = a || {};
    var params = [];
    if (a.name) {
      rejectControlChars(a.name, 'attendee name');
      params.push('CN=' + escapeParam(a.name));
    }
    if (a.role) {
      rejectControlChars(String(a.role), 'attendee role');
      params.push('ROLE=' + String(a.role).toUpperCase());
    }
    if (a.status) {
      rejectControlChars(String(a.status), 'attendee status');
      params.push('PARTSTAT=' + String(a.status).toUpperCase());
    }
    if (a.rsvp) params.push('RSVP=TRUE');
    return 'ATTENDEE' + (params.length ? ';' + params.join(';') : '') + ':mailto:' + assertEmail(a.email, 'attendee');
  }

  function alarmLines(alarm, eventOptions) {
    var action = String(alarm.action || 'DISPLAY').toUpperCase();
    rejectControlChars(action, 'alarm action');
    var trigger = normalizeTrigger(alarm.trigger);
    var description = alarm.description || eventOptions.title || 'Reminder';
    return [
      'BEGIN:VALARM',
      'ACTION:' + action,
      'DESCRIPTION:' + escapeText(description),
      'TRIGGER:' + trigger,
      'END:VALARM'
    ];
  }

  /*
   * Probe an IANA time zone once. A zone Intl cannot resolve would throw from
   * zoneParts() while rendering or describing the event, and a bad zone loaded
   * from storage could brick the page on every load; rejecting it here surfaces
   * a normal validation Error at the library boundary and keeps those
   * render/describe paths safe.
   */
  function assertTimeZone(timezone) {
    var s = String(timezone);
    rejectControlChars(s, 'event "timezone"');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s });
    } catch (e) {
      throw new Error('ICS Generator: unknown time zone "' + s + '".');
    }
    return s;
  }

  /*
   * Eager validation: every single-line field is checked when the event is
   * constructed, so an invalid event can never enter the calendar and break a
   * later render(). The same checks run again during serialization (toLines)
   * as defense in depth in case options are mutated after construction.
   */
  function validateEventOptions(options) {
    if (options.url) sanitizeUrl(options.url);
    if (options.timezone) assertTimeZone(options.timezone);
    if (options.rrule) rejectControlChars(String(options.rrule), 'event "rrule"');
    if (options.status) rejectControlChars(String(options.status), 'event "status"');
    if (options.transp !== undefined && options.transp !== 'OPAQUE' && options.transp !== 'TRANSPARENT') {
      throw new Error('ICS Generator: event "transp" must be OPAQUE or TRANSPARENT.');
    }
    if (options.priority !== undefined && (!Number.isInteger(options.priority) || options.priority < 0 || options.priority > 9)) {
      throw new Error('ICS Generator: event "priority" must be an integer from 0 to 9.');
    }
    (options.alarms || []).forEach(function (alarm) {
      if (!alarm) return;
      if (alarm.action) rejectControlChars(String(alarm.action), 'alarm action');
      if (alarm.trigger != null) normalizeTrigger(alarm.trigger);
    });
    if (options.organizer && options.organizer.email) {
      if (options.organizer.name) rejectControlChars(options.organizer.name, 'organizer name');
      assertEmail(options.organizer.email, 'organizer');
    }
    (options.attendees || []).forEach(function (a) {
      if (!a) return;
      if (a.email) assertEmail(a.email, 'attendee');
      if (a.name) rejectControlChars(a.name, 'attendee name');
      if (a.role) rejectControlChars(String(a.role), 'attendee role');
      if (a.status) rejectControlChars(String(a.status), 'attendee status');
    });
  }

  /*
   * VEvent
   * options: see README "Event options" — title (required), start (required),
   * end, durationMinutes, allDay, timezone, uid, description, location, url,
   * status, categories, rrule, alarms, attendees, organizer,
   * transp (OPAQUE/busy by default, or TRANSPARENT/free; omitted unless set),
   * priority (integer 0..9; 0/undefined omitted, 1 highest and 9 lowest).
   */
  function VEvent(options) {
    options = options || {};
    if (!options.title || !String(options.title).trim()) {
      throw new Error('ICS Generator: event "title" is required.');
    }
    if (isDateParts(options.start)) {
      options.allDay = true; /* { year, month, day } implies an all-day event */
    } else if (!(options.start instanceof Date) || isNaN(options.start.getTime())) {
      throw new Error('ICS Generator: event "start" must be a Date or { year, month, day }.');
    }
    validateEventOptions(options);

    this.options = options;
    this.uid = options.uid ? escapeText(options.uid) : makeUid();
    this.allDay = !!options.allDay;
    this.start = options.start;
    this.end = computeEnd(options, this.allDay);
  }

  VEvent.prototype.toLines = function () {
    var o = this.options;
    validateEventOptions(o);
    var tz = o.timezone;
    if (tz) rejectControlChars(tz, 'event "timezone"');
    var lines = ['BEGIN:VEVENT'];

    lines.push('UID:' + this.uid);
    lines.push('DTSTAMP:' + formatDateTimeUTC(new Date()));

    if (this.allDay) {
      lines.push('DTSTART;VALUE=DATE:' + formatDateUTC(isDateParts(this.start) ? this.start : toDatePartsUTC(this.start)));
      if (this.end) {
        lines.push('DTEND;VALUE=DATE:' + formatDateUTC(isDateParts(this.end) ? this.end : toDatePartsUTC(this.end)));
      }
    } else if (tz) {
      lines.push('DTSTART;TZID=' + escapeParam(tz) + ':' + formatDateTimeInZone(this.start, tz));
      if (this.end) lines.push('DTEND;TZID=' + escapeParam(tz) + ':' + formatDateTimeInZone(this.end, tz));
    } else {
      lines.push('DTSTART:' + formatDateTimeUTC(this.start));
      if (this.end) lines.push('DTEND:' + formatDateTimeUTC(this.end));
    }

    lines.push('SUMMARY:' + escapeText(o.title));
    if (o.description) lines.push('DESCRIPTION:' + escapeText(o.description));
    if (o.location) lines.push('LOCATION:' + escapeText(o.location));
    if (o.url) lines.push('URL:' + sanitizeUrl(o.url)); /* URI value — http(s) only */
    if (o.status) {
      rejectControlChars(String(o.status), 'event "status"');
      lines.push('STATUS:' + String(o.status).toUpperCase());
    }
    if (o.transp !== undefined) lines.push('TRANSP:' + o.transp);
    if (o.priority >= 1) lines.push('PRIORITY:' + o.priority);
    if (Array.isArray(o.categories) && o.categories.length) {
      lines.push('CATEGORIES:' + o.categories.map(escapeText).join(','));
    }
    if (o.rrule) {
      rejectControlChars(String(o.rrule), 'event "rrule"');
      lines.push('RRULE:' + String(o.rrule).trim());
    }
    if (o.organizer && o.organizer.email) lines.push(organizerLine(o.organizer));
    (o.attendees || []).forEach(function (a) {
      if (a && a.email) lines.push(attendeeLine(a));
    });
    (o.alarms || []).forEach(function (alarm) {
      lines.push.apply(lines, alarmLines(alarm, o));
    });

    lines.push('END:VEVENT');
    return lines;
  };

  VEvent.prototype.toString = function () {
    return foldLines(this.toLines().join(CRLF)) + CRLF;
  };

  /*
   * Calendar — holds any number of events and renders one .ics document.
   * options: { name } sets X-WR-CALNAME (the calendar title Google/Apple show).
   * includeVtimezone (default false) emits a best-effort VTIMEZONE block for
   * every unique event TZID before the VEVENTs, which strict/offline clients
   * need to resolve a TZID without consulting their own tzdata.
   */
  function Calendar(options) {
    this.options = options || {};
    this.events = [];
    this.includeVtimezone = !!this.options.includeVtimezone;
  }

  Calendar.prototype.addEvent = function (options) {
    var event = new VEvent(options);
    this.events.push(event);
    return event;
  };

  Calendar.prototype.removeEvent = function (eventOrIndex) {
    var idx = typeof eventOrIndex === 'number' ? eventOrIndex : this.events.indexOf(eventOrIndex);
    if (idx >= 0) this.events.splice(idx, 1);
    return idx >= 0;
  };

  /*
   * Replace the event at `eventOrIndex` (a numeric index or an existing VEvent)
   * with a new one built from `options`. The new VEvent takes the same slot, so
   * list position is preserved; when `options.uid` is omitted the previous
   * event's uid is carried over to keep identity stable across regenerations.
   *
   * Validation runs through the same VEvent constructor as addEvent, and the
   * candidate is built before the array is touched, so invalid options throw
   * without changing the calendar. Returns the new VEvent, or false when the
   * target does not exist.
   */
  Calendar.prototype.updateEvent = function (eventOrIndex, options) {
    var idx = typeof eventOrIndex === 'number' ? eventOrIndex : this.events.indexOf(eventOrIndex);
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= this.events.length) return false;

    var previous = this.events[idx];
    var event = new VEvent(options || {});
    if (!(options && options.uid)) event.uid = previous.uid;

    this.events[idx] = event;
    return event;
  };

  Calendar.prototype.clear = function () {
    this.events = [];
  };

  Calendar.prototype.toString = function () {
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:' + PRODID,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];
    if (this.options.name) lines.push('X-WR-CALNAME:' + escapeText(this.options.name));
    if (this.options.desc) lines.push('X-WR-CALDESC:' + escapeText(this.options.desc));
    if (this.includeVtimezone) {
      /* One VTIMEZONE per unique TZID, spanning every year its events touch. */
      var zoneYears = {};
      var zoneOrder = [];
      for (var v = 0; v < this.events.length; v++) {
        var zoneEvent = this.events[v];
        if (zoneEvent.allDay) continue;
        var zone = zoneEvent.options && zoneEvent.options.timezone;
        if (!zone || String(zone) === 'UTC') continue;
        zone = String(zone);
        if (!zoneYears[zone]) { zoneYears[zone] = []; zoneOrder.push(zone); }
        zoneYears[zone].push(zoneEvent.start instanceof Date
          ? zoneEvent.start.getUTCFullYear()
          : new Date().getUTCFullYear());
      }
      for (var zi = 0; zi < zoneOrder.length; zi++) {
        lines.push.apply(lines, vtimezoneLines(zoneOrder[zi], zoneYears[zoneOrder[zi]]));
      }
    }
    for (var i = 0; i < this.events.length; i++) {
      lines.push.apply(lines, this.events[i].toLines());
    }
    lines.push('END:VCALENDAR');
    return foldLines(lines.join(CRLF)) + CRLF;
  };

  /*
   * Trigger a download of the given text as an .ics file. Pure client-side:
   * builds a Blob and clicks a temporary <a download>. Falls back to a
   * data: URI for very old browsers.
   */
  function download(filename, text) {
    filename = filename || 'calendar.ics';
    if (typeof document === 'undefined') {
      throw new Error('ICS Generator: download() is browser-only.');
    }
    var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 0);
    } else {
      location.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(text);
    }
  }

  var api = {
    VERSION: '1.0.0',
    PRODID: PRODID,
    Calendar: Calendar,
    VEvent: VEvent,
    download: download,
    escapeText: escapeText,
    foldLines: foldLines,
    formatDateTimeUTC: formatDateTimeUTC,
    formatDateUTC: formatDateUTC,
    zoneParts: zoneParts,
    zonedTimeToDate: zonedTimeToDate
  };

  if (typeof window !== 'undefined') window.IcsGenerator = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();