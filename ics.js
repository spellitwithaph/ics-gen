/*!
 * ics-gen v1.0.0
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

  var PRODID = '-//ics-gen//JavaScript ICS Generator//EN';
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
      throw new Error('ics-gen: ' + label + ' must not contain control characters.');
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
      throw new Error('ics-gen: invalid ' + label + ' email address.');
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
      throw new Error('ics-gen: event "url" must be an absolute http(s) URL.');
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

  /* Wall-clock time in an IANA time zone, e.g. '20260115T120000' for America/New_York. */
  function formatDateTimeInZone(date, timeZone) {
    var parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(date)
      .forEach(function (p) {
        if (p.type !== 'literal') parts[p.type] = p.value;
      });
    return (
      parts.year + parts.month + parts.day + 'T' + parts.hour + parts.minute + parts.second
    );
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
        return crypto.randomUUID() + '@ics-gen';
      }
    } catch (e) { /* fall through to the non-crypto fallback */ }
    return (
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      }) + '@ics-gen'
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
      throw new Error('ics-gen: event "end" must be a Date or { year, month, day }.');
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
   * Eager validation: every single-line field is checked when the event is
   * constructed, so an invalid event can never enter the calendar and break a
   * later render(). The same checks run again during serialization (toLines)
   * as defense in depth in case options are mutated after construction.
   */
  function validateEventOptions(options) {
    if (options.url) sanitizeUrl(options.url);
    if (options.timezone) rejectControlChars(String(options.timezone), 'event "timezone"');
    if (options.rrule) rejectControlChars(String(options.rrule), 'event "rrule"');
    if (options.status) rejectControlChars(String(options.status), 'event "status"');
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
   * status, categories, rrule, alarms, attendees, organizer.
   */
  function VEvent(options) {
    options = options || {};
    if (!options.title || !String(options.title).trim()) {
      throw new Error('ics-gen: event "title" is required.');
    }
    if (isDateParts(options.start)) {
      options.allDay = true; /* { year, month, day } implies an all-day event */
    } else if (!(options.start instanceof Date) || isNaN(options.start.getTime())) {
      throw new Error('ics-gen: event "start" must be a Date or { year, month, day }.');
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
   */
  function Calendar(options) {
    this.options = options || {};
    this.events = [];
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
      throw new Error('ics-gen: download() is browser-only.');
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
    formatDateUTC: formatDateUTC
  };

  if (typeof window !== 'undefined') window.IcsGenerator = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();