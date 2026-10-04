/*!
 * ics-parse.js — a small, dependency-free iCalendar (.ics) reader for ICS Generator.
 *
 * Turns RFC 5545 text into plain JavaScript objects that map onto
 * IcsGenerator's `addEvent` options, so an imported file can be re-generated,
 * previewed, or edited without a server and without any third-party code.
 *
 * Read-only and side-effect free: it never touches the network or the DOM.
 * Input is treated as untrusted data — this module only ever produces strings,
 * numbers, dates, and arrays; callers must keep rendering them with
 * textContent / the generator's escaping, never as raw HTML.
 *
 * Loaded after ics.js, it extends the same global:
 *   IcsGenerator.parse(text)       → { calendar, events, warnings, counts }
 *   IcsGenerator.parseEvents(text) → array of event objects
 *
 * Also `require()`-able in Node (alongside ics.js) for tooling and tests.
 */
(function (root, factory) {
  'use strict';
  var core = null;
  if (typeof module !== 'undefined' && module.exports) {
    try { core = require('./ics.js'); } catch (e) { core = null; }
  } else if (root) {
    core = root.IcsGenerator;
  }
  var api = factory(core || {});
  if (typeof module !== 'undefined' && module.exports) {
    if (core) {
      core.parse = api.parse;
      core.parseEvents = api.parseEvents;
      module.exports = core;
    } else {
      module.exports = api;
    }
  }
  if (root && root.IcsGenerator) {
    root.IcsGenerator.parse = api.parse;
    root.IcsGenerator.parseEvents = api.parseEvents;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (core) {
  'use strict';

  /* Caps keep a hostile or broken file from freezing the tab. */
  var MAX_LINES = 20000;
  var MAX_DEPTH = 12;

  /*
   * Common Windows/Outlook zone display names → IANA. Outlook writes TZID as a
   * Windows registry name (e.g. "Eastern Standard Time"), which Intl cannot
   * resolve; this table bridges the common ones. Unknown names fall back to a
   * VTIMEZONE offset or floating time (with a warning).
   */
  var WINDOWS_ZONES = {
    'dateline standard time': 'Etc/GMT+12',
    'aleutian standard time': 'America/Adak',
    'hawaiian standard time': 'Pacific/Honolulu',
    'alaskan standard time': 'America/Anchorage',
    'pacific standard time': 'America/Los_Angeles',
    'us mountain standard time': 'America/Phoenix',
    'mountain standard time': 'America/Denver',
    'central america standard time': 'America/Guatemala',
    'central standard time': 'America/Chicago',
    'central standard time (mexico)': 'America/Mexico_City',
    'canada central standard time': 'America/Regina',
    'sa pacific standard time': 'America/Bogota',
    'eastern standard time': 'America/New_York',
    'us eastern standard time': 'America/Indiana/Indianapolis',
    'cuba standard time': 'America/Havana',
    'atlantic standard time': 'America/Halifax',
    'venezuela standard time': 'America/Caracas',
    'pacific sa standard time': 'America/Santiago',
    'newfoundland standard time': 'America/St_Johns',
    'e. south america standard time': 'America/Sao_Paulo',
    'argentina standard time': 'America/Argentina/Buenos_Aires',
    'sa western standard time': 'America/La_Paz',
    'montevideo standard time': 'America/Montevideo',
    'azores standard time': 'Atlantic/Azores',
    'cape verde standard time': 'Atlantic/Cape_Verde',
    'gmt standard time': 'Europe/London',
    'morocco standard time': 'Africa/Casablanca',
    'w. europe standard time': 'Europe/Berlin',
    'central europe standard time': 'Europe/Budapest',
    'romance standard time': 'Europe/Paris',
    'central european standard time': 'Europe/Warsaw',
    'w. central africa standard time': 'Africa/Lagos',
    'south africa standard time': 'Africa/Johannesburg',
    'fle standard time': 'Europe/Kyiv',
    'gtb standard time': 'Europe/Bucharest',
    'middle east standard time': 'Asia/Beirut',
    'egypt standard time': 'Africa/Cairo',
    'israel standard time': 'Asia/Jerusalem',
    'turkey standard time': 'Europe/Istanbul',
    'arabic standard time': 'Asia/Baghdad',
    'arabian standard time': 'Asia/Dubai',
    'russian standard time': 'Europe/Moscow',
    'georgian standard time': 'Asia/Tbilisi',
    'caucasus standard time': 'Asia/Yerevan',
    'afghanistan standard time': 'Asia/Kabul',
    'west asia standard time': 'Asia/Tashkent',
    'ekaterinburg standard time': 'Asia/Yekaterinburg',
    'pakistan standard time': 'Asia/Karachi',
    'india standard time': 'Asia/Kolkata',
    'sri lanka standard time': 'Asia/Colombo',
    'nepal standard time': 'Asia/Kathmandu',
    'central asia standard time': 'Asia/Almaty',
    'bangladesh standard time': 'Asia/Dhaka',
    'myanmar standard time': 'Asia/Yangon',
    'se asia standard time': 'Asia/Bangkok',
    'china standard time': 'Asia/Shanghai',
    'singapore standard time': 'Asia/Singapore',
    'w. australia standard time': 'Australia/Perth',
    'taipei standard time': 'Asia/Taipei',
    'tokyo standard time': 'Asia/Tokyo',
    'korea standard time': 'Asia/Seoul',
    'cen. australia standard time': 'Australia/Adelaide',
    'aus central standard time': 'Australia/Darwin',
    'e. australia standard time': 'Australia/Brisbane',
    'aus eastern standard time': 'Australia/Sydney',
    'tasmania standard time': 'Australia/Hobart',
    'new zealand standard time': 'Pacific/Auckland',
    'fiji standard time': 'Pacific/Fiji',
    'samoa standard time': 'Pacific/Apia',
    'tonga standard time': 'Pacific/Tongatapu'
  };

  /* ---------- text helpers ---------- */

  function upper(s) { return String(s == null ? '' : s).trim().toUpperCase(); }

  /* RFC 5545 §3.3.11 TEXT unescaping (inverse of ics.js escapeText). */
  function unescapeText(value) {
    return String(value == null ? '' : value).replace(/\\(.)/g, function (m, c) {
      return c === 'n' || c === 'N' ? '\n' : c;
    });
  }

  /* Split on `sep`, ignoring separators inside double quotes. */
  function splitUnquoted(str, sep) {
    var out = [];
    var cur = '';
    var quoted = false;
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      if (c === '"') { quoted = !quoted; cur += c; }
      else if (c === sep && !quoted) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  /* Split a TEXT value on unescaped `sep`, keeping escapes for unescapeText. */
  function splitEscaped(value, sep) {
    var out = [];
    var cur = '';
    for (var i = 0; i < value.length; i++) {
      var c = value.charAt(i);
      if (c === '\\' && i + 1 < value.length) { cur += c + value.charAt(++i); continue; }
      if (c === sep) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  function unquote(v) {
    v = String(v == null ? '' : v);
    if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1);
    return v;
  }

  /* RFC 5545 §3.1: unfold continuation lines, tolerate LF/CR/CRLF and a BOM. */
  function unfold(text) {
    var s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    var raw = s.split(/\r\n|\r|\n/);
    var lines = [];
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i];
      if (line.length && (line.charAt(0) === ' ' || line.charAt(0) === '\t')) {
        if (lines.length) lines[lines.length - 1] += line.slice(1);
        else lines.push(line.slice(1));
      } else {
        lines.push(line);
      }
    }
    return lines;
  }

  /* "NAME;PARAM=VALUE;PARAM=V1,V2:value" → { name, params, value }. */
  function parseContentLine(line) {
    var quoted = false;
    var colon = -1;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '"') quoted = !quoted;
      else if (c === ':' && !quoted) { colon = i; break; }
    }
    if (colon === -1) return null;

    var segs = splitUnquoted(line.slice(0, colon), ';');
    var name = upper(segs.shift());
    if (!name) return null;

    var params = {};
    for (var j = 0; j < segs.length; j++) {
      var eq = segs[j].indexOf('=');
      if (eq === -1) continue;
      params[upper(segs[j].slice(0, eq))] = splitUnquoted(segs[j].slice(eq + 1), ',').map(unquote);
    }
    return { name: name, params: params, value: line.slice(colon + 1) };
  }

  /* ---------- component tree ---------- */

  function buildTree(lines, warnings) {
    var root = { name: 'ROOT', props: [], children: [] };
    var stack = [root];
    var limit = Math.min(lines.length, MAX_LINES);

    for (var i = 0; i < limit; i++) {
      if (!lines[i]) continue;
      var cl = parseContentLine(lines[i]);
      if (!cl) { warnings.push('Skipped an unreadable line.'); continue; }

      if (cl.name === 'BEGIN') {
        if (stack.length >= MAX_DEPTH) { warnings.push('Ignored content nested too deeply.'); continue; }
        var comp = { name: upper(cl.value), props: [], children: [] };
        stack[stack.length - 1].children.push(comp);
        stack.push(comp);
      } else if (cl.name === 'END') {
        if (stack.length > 1) stack.pop();
      } else {
        stack[stack.length - 1].props.push(cl);
      }
    }
    if (lines.length > MAX_LINES) warnings.push('Input truncated after ' + MAX_LINES + ' lines.');
    return root;
  }

  function childrenNamed(comp, name) {
    return comp.children.filter(function (c) { return c.name === name; });
  }
  function propNamed(comp, name) {
    for (var i = 0; i < comp.props.length; i++) if (comp.props[i].name === name) return comp.props[i];
    return null;
  }
  function propsNamed(comp, name) {
    return comp.props.filter(function (p) { return p.name === name; });
  }
  function param(prop, name) {
    if (!prop || !prop.params[name] || !prop.params[name].length) return null;
    return prop.params[name][0] || null;
  }

  /* ---------- dates, zones, durations ---------- */

  function isValidZone(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
    catch (e) { return false; }
  }

  function resolveZone(tzid) {
    if (!tzid) return null;
    var raw = unquote(tzid).trim();
    if (!raw) return null;
    if (/^(UTC|GMT|Z)$/i.test(raw)) return 'UTC';
    if (isValidZone(raw)) return raw;
    var win = WINDOWS_ZONES[raw.toLowerCase()];
    if (win && isValidZone(win)) return win;
    return null;
  }

  /* "+0530" / "-040000" → signed minutes east of UTC. */
  function parseUtcOffset(value) {
    var m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(value).trim());
    if (!m) return null;
    var mins = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    if (m[4]) mins += parseInt(m[4], 10) / 60;
    return (m[1] === '-' ? -1 : 1) * mins;
  }

  /* Fixed offsets declared by VTIMEZONE, keyed by TZID — a best-effort fallback
   * for custom zones Intl does not know. */
  function vtimezoneOffsets(root) {
    var map = {};
    childrenNamed(root, 'VCALENDAR').forEach(function (vc) {
      childrenNamed(vc, 'VTIMEZONE').forEach(function (tz) {
        var idProp = propNamed(tz, 'TZID');
        if (!idProp) return;
        var subs = childrenNamed(tz, 'STANDARD').concat(childrenNamed(tz, 'DAYLIGHT'));
        for (var i = 0; i < subs.length; i++) {
          var off = propNamed(subs[i], 'TZOFFSETTO');
          if (off) {
            var mins = parseUtcOffset(off.value);
            if (mins != null) { map[unquote(idProp.value)] = mins; break; }
          }
        }
      });
    });
    return map;
  }

  /*
   * DTSTART/DTEND → { kind:'date', parts } or
   * { kind:'datetime', date, timezone, floating }. `timezone` is an IANA name,
   * 'UTC', or null (floating / unknown-zone fixed offset).
   */
  function parseDateProp(prop, offsets, warnings, label) {
    if (!prop) return null;
    var value = String(prop.value || '').trim();
    var asDate = upper(param(prop, 'VALUE')) === 'DATE' || /^\d{8}$/.test(value);

    if (asDate) {
      var dm = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
      if (!dm) { warnings.push('Could not read ' + label + '.'); return null; }
      return { kind: 'date', parts: { year: +dm[1], month: +dm[2], day: +dm[3] } };
    }

    var m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(value);
    if (!m) { warnings.push('Could not read ' + label + '.'); return null; }
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = m[6] ? +m[6] : 0;

    if (m[7]) {
      return { kind: 'datetime', date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), timezone: 'UTC' };
    }

    var tzid = param(prop, 'TZID');
    if (tzid) {
      var zone = resolveZone(tzid);
      if (zone) {
        return { kind: 'datetime', date: core.zonedTimeToDate(y, mo, d, h, mi, zone, s), timezone: zone };
      }
      var off = offsets[unquote(tzid)];
      if (off != null) {
        warnings.push('Unknown time zone "' + unquote(tzid) + '"; used its declared UTC offset.');
        return { kind: 'datetime', date: new Date(Date.UTC(y, mo - 1, d, h, mi, s) - off * 60000), timezone: null };
      }
      warnings.push('Unknown time zone "' + unquote(tzid) + '"; treated the time as floating (your device zone).');
    }
    /* Floating time means "local wall clock" per RFC 5545. */
    return { kind: 'datetime', date: new Date(y, mo - 1, d, h, mi, s), timezone: null, floating: true };
  }

  /* ISO 8601 duration → minutes (may be fractional); null when unreadable. */
  function parseDurationMinutes(value) {
    var m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(upper(value));
    if (!m) return null;
    var weeks = +(m[2] || 0), days = +(m[3] || 0), hours = +(m[4] || 0), mins = +(m[5] || 0), secs = +(m[6] || 0);
    return (m[1] === '-' ? -1 : 1) * (((weeks * 7 + days) * 24 + hours) * 60 + mins + secs / 60);
  }

  function addDaysToParts(parts, n) {
    var d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + n));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  /* ORGANIZER/ATTENDEE → { name?, email, role?, status?, rsvp? }. */
  function parseCalAddress(prop) {
    var addr = {
      email: String(prop.value || '').trim().replace(/^mailto:/i, '')
    };
    var cn = param(prop, 'CN');
    if (cn) addr.name = unescapeText(unquote(cn));
    var role = param(prop, 'ROLE');
    if (role) addr.role = upper(role);
    var status = param(prop, 'PARTSTAT');
    if (status) addr.status = upper(status);
    if (/^true$/i.test(param(prop, 'RSVP') || '')) addr.rsvp = true;
    return addr;
  }

  /* ---------- VEVENT → plain event object ---------- */

  var KNOWN_PROPS = {
    UID: 1, SUMMARY: 1, DESCRIPTION: 1, LOCATION: 1, URL: 1, STATUS: 1,
    CATEGORIES: 1, DTSTART: 1, DTEND: 1, DURATION: 1, RRULE: 1,
    ORGANIZER: 1, ATTENDEE: 1, TRANSP: 1, PRIORITY: 1
  };

  function parseEvent(comp, offsets, warnings) {
    var start = parseDateProp(propNamed(comp, 'DTSTART'), offsets, warnings, 'DTSTART');
    if (!start) { warnings.push('Skipped an event with no readable DTSTART.'); return null; }

    var end = parseDateProp(propNamed(comp, 'DTEND'), offsets, warnings, 'DTEND');
    var allDay = start.kind === 'date';
    var ev = {
      allDay: allDay,
      start: allDay ? start.parts : start.date,
      timezone: start.timezone || null,
      floating: !!start.floating,
      categories: [],
      alarms: [],
      attendees: [],
      unsupported: []
    };

    var p;
    if ((p = propNamed(comp, 'UID'))) ev.uid = unescapeText(p.value).trim();
    if ((p = propNamed(comp, 'SUMMARY'))) ev.title = unescapeText(p.value).trim();
    if ((p = propNamed(comp, 'DESCRIPTION'))) ev.description = unescapeText(p.value);
    if ((p = propNamed(comp, 'LOCATION'))) ev.location = unescapeText(p.value);
    if ((p = propNamed(comp, 'URL'))) ev.url = String(p.value).trim();
    if ((p = propNamed(comp, 'STATUS'))) ev.status = upper(p.value);
    if ((p = propNamed(comp, 'TRANSP'))) {
      if (/^(OPAQUE|TRANSPARENT)$/.test(upper(p.value))) ev.transp = upper(p.value);
      else warnings.push('Ignored an unreadable TRANSP value.');
    }
    if ((p = propNamed(comp, 'PRIORITY'))) {
      if (/^[1-9]$/.test(String(p.value).trim())) ev.priority = Number(p.value);
      else warnings.push('Ignored an unreadable PRIORITY value.');
    }
    if ((p = propNamed(comp, 'RRULE'))) ev.rrule = String(p.value).trim();

    propsNamed(comp, 'CATEGORIES').forEach(function (c) {
      splitEscaped(String(c.value), ',').forEach(function (part) {
        var t = unescapeText(part).trim();
        if (t) ev.categories.push(t);
      });
    });

    if (end) {
      ev.end = end.kind === 'date' ? end.parts : end.date;
      if (!allDay && ev.end instanceof Date && ev.start instanceof Date && ev.end.getTime() <= ev.start.getTime()) {
        warnings.push('DTEND is not after DTSTART; kept as-is.');
      }
    } else {
      var durProp = propNamed(comp, 'DURATION');
      var mins = durProp ? parseDurationMinutes(durProp.value) : null;
      if (mins != null) {
        ev.end = allDay
          ? addDaysToParts(start.parts, Math.round(mins / 1440))
          : new Date(start.date.getTime() + mins * 60000);
      }
    }

    childrenNamed(comp, 'VALARM').forEach(function (al) {
      var trig = propNamed(al, 'TRIGGER');
      if (!trig) return;
      var action = upper((propNamed(al, 'ACTION') || {}).value || 'DISPLAY');
      if (action !== 'DISPLAY') {
        warnings.push('Skipped a non-DISPLAY (' + action + ') reminder.');
        return;
      }
      var alarm = { trigger: String(trig.value).trim() };
      var desc = propNamed(al, 'DESCRIPTION');
      if (desc) alarm.description = unescapeText(desc.value);
      ev.alarms.push(alarm);
    });

    var org = propNamed(comp, 'ORGANIZER');
    if (org) ev.organizer = parseCalAddress(org);
    propsNamed(comp, 'ATTENDEE').forEach(function (a) {
      var addr = parseCalAddress(a);
      if (addr.email) ev.attendees.push(addr);
    });

    var seen = {};
    comp.props.forEach(function (pp) {
      if (!KNOWN_PROPS[pp.name] && !seen[pp.name]) { seen[pp.name] = 1; ev.unsupported.push(pp.name); }
    });
    if (propNamed(comp, 'RECURRENCE-ID')) {
      warnings.push('Imported a recurrence override as a standalone event.');
    }
    return ev;
  }

  /* ---------- public API ---------- */

  function parse(text) {
    var warnings = [];
    var root = buildTree(unfold(text), warnings);
    var calendars = childrenNamed(root, 'VCALENDAR');
    if (!calendars.length) {
      throw new Error('Not an iCalendar file: no BEGIN:VCALENDAR block found.');
    }

    var calendar = { name: null, desc: null };
    var counts = { vevent: 0, vtimezone: 0, valarm: 0, other: 0 };
    calendars.forEach(function (vc) {
      var nm = propNamed(vc, 'X-WR-CALNAME');
      if (nm) calendar.name = unescapeText(nm.value);
      var ds = propNamed(vc, 'X-WR-CALDESC');
      if (ds) calendar.desc = unescapeText(ds.value);
      counts.vtimezone += childrenNamed(vc, 'VTIMEZONE').length;
      vc.children.forEach(function (c) {
        if (c.name !== 'VEVENT' && c.name !== 'VTIMEZONE') counts.other++;
      });
    });

    var offsets = vtimezoneOffsets(root);
    var events = [];
    calendars.forEach(function (vc) {
      childrenNamed(vc, 'VEVENT').forEach(function (ve) {
        counts.vevent++;
        counts.valarm += childrenNamed(ve, 'VALARM').length;
        var ev = parseEvent(ve, offsets, warnings);
        if (ev) events.push(ev);
      });
    });

    return { calendar: calendar, events: events, warnings: warnings, counts: counts };
  }

  function parseEvents(text) {
    var result = parse(text);
    if (!result.events.length) throw new Error('No VEVENT found in the .ics text.');
    return result.events;
  }

  return { parse: parse, parseEvents: parseEvents };
});
