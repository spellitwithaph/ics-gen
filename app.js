/**
 * ics-gen demo app — form wiring and event-list rendering.
 *
 * Kept in its own file (rather than an inline <script>) so the page can ship a
 * strict Content-Security-Policy with script-src 'self' and no 'unsafe-inline'.
 *
 * All user-provided text is inserted into the DOM via textContent, never as
 * HTML, and user input flows into the .ics only through IcsGenerator's
 * escaping/validation (see ics.js — "Security" note).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var cal = new IcsGenerator.Calendar({ name: 'My Events' });

  /* ---------- helpers ---------- */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toISODate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function toISOTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function addDays(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2] + n);
    return toISODate(d);
  }
  function parseDateInput(v) {
    var p = v.split('-').map(Number);
    return { year: p[0], month: p[1], day: p[2] };
  }
  function parseTimeInput(v) {
    var p = v.split(':').map(Number);
    return { hour: p[0], minute: p[1] };
  }
  function slugify(s) {
    return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'calendar');
  }
  function nextWeekday(targetDay, hour, minute) {
    var now = new Date();
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diff = (targetDay - now.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    d.setHours(hour || 9, minute || 0, 0, 0);
    return d;
  }
  function daysFromNow(n) {
    var d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  }

  /* ---------- time zones ---------- */

  /* Curated fallback used only when Intl.supportedValuesOf is unavailable
   * (older Safari/Firefox). The browser's own zone is always offered on top. */
  var FALLBACK_TIME_ZONES = [
    'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
    'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota',
    'America/Chicago', 'America/Denver', 'America/Halifax', 'America/Lima',
    'America/Los_Angeles', 'America/Mexico_City', 'America/New_York',
    'America/Phoenix', 'America/Santiago', 'America/Sao_Paulo', 'America/Toronto',
    'America/Vancouver', 'Asia/Bangkok', 'Asia/Dhaka', 'Asia/Dubai',
    'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Karachi',
    'Asia/Kathmandu', 'Asia/Kolkata', 'Asia/Kuala_Lumpur', 'Asia/Manila',
    'Asia/Riyadh', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore',
    'Asia/Taipei', 'Asia/Tehran', 'Asia/Tokyo', 'Atlantic/Azores',
    'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Darwin',
    'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney',
    'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Brussels',
    'Europe/Bucharest', 'Europe/Budapest', 'Europe/Copenhagen', 'Europe/Dublin',
    'Europe/Helsinki', 'Europe/Istanbul', 'Europe/Kyiv', 'Europe/Lisbon',
    'Europe/London', 'Europe/Madrid', 'Europe/Moscow', 'Europe/Oslo',
    'Europe/Paris', 'Europe/Prague', 'Europe/Rome', 'Europe/Stockholm',
    'Europe/Vienna', 'Europe/Warsaw', 'Europe/Zurich', 'Pacific/Auckland',
    'Pacific/Fiji', 'Pacific/Honolulu', 'Pacific/Midway', 'Pacific/Tahiti'
  ];

  function localTimeZone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) return tz;
    } catch (e) { /* fall through to UTC */ }
    return 'UTC';
  }

  function availableTimeZones() {
    try {
      if (typeof Intl.supportedValuesOf === 'function') {
        var list = Intl.supportedValuesOf('timeZone');
        if (list && list.length) return list.slice();
      }
    } catch (e) { /* fall through to the curated list */ }
    return FALLBACK_TIME_ZONES.slice();
  }

  /* "America/Argentina/Buenos_Aires" → "America" (optgroup label). */
  function timeZoneGroup(zone) {
    var i = zone.indexOf('/');
    return i === -1 ? 'Other' : zone.slice(0, i);
  }

  function timeZoneOption(zone, label) {
    var opt = document.createElement('option');
    opt.value = zone;
    opt.textContent = label || zone;
    return opt;
  }

  /* Device zone first and selected, then UTC, then every IANA zone grouped by
   * region. Populated from Intl so the list stays current without a hard-coded
   * table in the HTML. */
  function populateTimeZones() {
    var sel = timezoneEl;
    var local = localTimeZone();
    sel.textContent = '';

    sel.appendChild(timeZoneOption(local, local + ' (your device)'));
    if (local !== 'UTC') {
      sel.appendChild(timeZoneOption('UTC', 'UTC (Coordinated Universal Time)'));
    }

    var zones = availableTimeZones();
    if (zones.indexOf(local) === -1) zones.push(local);
    zones = zones.filter(function (z, i) {
      return z && zones.indexOf(z) === i && z !== local && z !== 'UTC';
    });
    zones.sort();

    var groups = {};
    zones.forEach(function (z) {
      var g = timeZoneGroup(z);
      (groups[g] = groups[g] || []).push(z);
    });
    Object.keys(groups).sort().forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g;
      groups[g].forEach(function (z) { og.appendChild(timeZoneOption(z)); });
      sel.appendChild(og);
    });

    sel.value = local;
  }

  /* Wall-clock components a Date shows in `timeZone`. */
  function zoneParts(date, timeZone) {
    var parts = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).forEach(function (p) {
      if (p.type !== 'literal') parts[p.type] = Number(p.value);
    });
    return parts;
  }

  /* Interpret year-month-day h:mi[:ss] as wall-clock time in `timeZone` and
   * return the matching Date. Repeats because the first guess can land on the
   * far side of a DST transition. */
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

  /* Calendar-day identity for a Date in a zone (browser zone when omitted). */
  function dayKey(date, timeZone) {
    if (!timeZone) return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
    var p = zoneParts(date, timeZone);
    return p.year + '-' + p.month + '-' + p.day;
  }

  function setStatus(msg, isError) {
    var el = $('status-msg');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  /* ---------- form wiring ---------- */

  var startDateEl = $('start-date');
  var startTimeEl = $('start-time');
  var endDateEl = $('end-date');
  var endTimeEl = $('end-time');
  var timezoneEl = $('timezone');

  function defaultFormDates() {
    var now = new Date();
    startDateEl.value = toISODate(now);
    endDateEl.value = toISODate(now);
    startTimeEl.value = '09:00';
    endTimeEl.value = '10:00';
  }

  function syncAllDayUI() {
    var allDay = $('all-day').checked;
    $('field-start-time').hidden = allDay;
    $('field-end-time').hidden = allDay;
    /* All-day events are date-only, so a time zone would be misleading. */
    $('field-timezone').hidden = allDay;
    if (allDay && endDateEl.value && startDateEl.value && endDateEl.value <= startDateEl.value) {
      endDateEl.value = addDays(startDateEl.value, 1);
    }
  }

  function syncRecurUI() {
    var off = $('recur-freq').value === 'NONE';
    $('field-interval').hidden = off;
    $('field-until').hidden = off;
    /* Down to just the select? Let it span a Status-select-sized column
     * instead of the first third of the row (which clips "Does not repeat"). */
    $('recur-row').classList.toggle('single', off);
  }

  function syncReminderUI() {
    var off = $('reminder-toggle').value === 'off';
    $('field-reminder-value').hidden = off;
    $('field-reminder-unit').hidden = off;
    $('reminder-row').classList.toggle('single', off);
  }

  $('all-day').addEventListener('change', syncAllDayUI);
  $('recur-freq').addEventListener('change', syncRecurUI);
  $('reminder-toggle').addEventListener('change', syncReminderUI);

  /* ---------- reading the form ---------- */

  function readForm() {
    var title = $('title').value.trim();
    if (!title) throw new Error('Please give the event a title.');

    var allDay = $('all-day').checked;
    var opts = { title: title, allDay: allDay };

    if (allDay) {
      if (!startDateEl.value) throw new Error('Pick a start date.');
      opts.start = parseDateInput(startDateEl.value); /* { year, month, day } — timezone-safe */
      if (endDateEl.value) opts.end = parseDateInput(endDateEl.value);
    } else {
      if (!startDateEl.value) throw new Error('Pick a start date.');
      if (!startTimeEl.value) throw new Error('Pick a start time.');
      /* Read the typed wall-clock time in the chosen zone. 'UTC' is emitted as
       * a plain ...Z timestamp (no TZID); every other zone gets a TZID. */
      var tz = timezoneEl.value || localTimeZone();
      if (tz !== 'UTC') opts.timezone = tz;
      var sd = parseDateInput(startDateEl.value);
      var st = parseTimeInput(startTimeEl.value);
      opts.start = zonedTimeToDate(sd.year, sd.month, sd.day, st.hour, st.minute, tz);
      if (endDateEl.value && endTimeEl.value) {
        var ed = parseDateInput(endDateEl.value);
        var et = parseTimeInput(endTimeEl.value);
        opts.end = zonedTimeToDate(ed.year, ed.month, ed.day, et.hour, et.minute, tz);
        if (opts.end <= opts.start) throw new Error('The end date/time must be after the start.');
      } else {
        opts.end = new Date(opts.start.getTime() + 60 * 60000); /* default: 1 hour */
      }
    }

    var desc = $('description').value.trim();
    if (desc) opts.description = desc;
    var loc = $('location').value.trim();
    if (loc) opts.location = loc;
    var url = $('url').value.trim();
    /* Bare "example.com/agenda" → https://…; other schemes are rejected by ics.js. */
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
    if (url) opts.url = url;
    var cats = $('categories').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (cats.length) opts.categories = cats;
    opts.status = $('status').value;

    var freq = $('recur-freq').value;
    if (freq !== 'NONE') {
      var parts = ['FREQ=' + freq];
      var iv = parseInt($('recur-interval').value, 10);
      if (!isNaN(iv) && iv > 1) parts.push('INTERVAL=' + iv);
      var until = $('recur-until').value;
      if (until) {
        var up = parseDateInput(until);
        if (allDay) {
          parts.push('UNTIL=' + IcsGenerator.formatDateUTC({ year: up.year, month: up.month, day: up.day }));
        } else {
          /* End of that day in the event's zone, converted to UTC (UNTIL for a
           * timed rule must be a UTC instant). */
          parts.push('UNTIL=' + IcsGenerator.formatDateTimeUTC(
            zonedTimeToDate(up.year, up.month, up.day, 23, 59, opts.timezone || 'UTC', 59)
          ));
        }
      }
      opts.rrule = parts.join(';');
    }

    var on = $('reminder-toggle').value === 'on';
    if (on) {
      var n = parseInt($('reminder-value').value, 10);
      if (!n || n < 1) throw new Error('Pick how long before the event to remind you (1 or more).');
      var unit = $('reminder-unit').value; /* minutes | hours | days */
      var dur = unit === 'days' ? 'P' + n + 'D'
        : unit === 'hours' ? 'PT' + n + 'H'
        : 'PT' + n + 'M';
      opts.alarms = [{ trigger: '-' + dur }]; /* e.g. -PT10M, -PT2H, -P1D */
    }

    return opts;
  }

  /* ---------- rendering ---------- */

  /* Number of minutes, or an ISO 8601 duration string (e.g. '-PT10M', '-PT2H',
   * '-P1D'), → a human label like "10 min" or "2 days". */
  function humanizeDuration(trigger) {
    var raw;
    if (typeof trigger === 'number') {
      raw = 'PT' + Math.abs(trigger) + 'M'; /* minutes → 'PT10M' */
    } else {
      var s = String(trigger == null ? '' : trigger);
      raw = s.replace(/^[-+]/, ''); /* strip the sign: '-PT2H' → 'PT2H' */
    }
    var m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(raw);
    if (!m) return raw;
    var out = [];
    if (m[1]) out.push(m[1] === '1' ? '1 day' : m[1] + ' days');
    if (m[2]) out.push(m[2] === '1' ? '1 hour' : m[2] + ' hours');
    if (m[3]) out.push(m[3] === '1' ? '1 min' : m[3] + ' min');
    return out.join(' ') || '0 min';
  }

  function describeEvent(ev) {
    var o = ev.options;
    var bits = [];
    if (ev.allDay) {
      var sp = ev.start && ev.start.year
        ? new Date(Date.UTC(ev.start.year, ev.start.month - 1, ev.start.day))
        : ev.start;
      bits.push('All day · ' + sp.toLocaleDateString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
      }));
      if (ev.end) {
        var ep = ev.end && ev.end.year
          ? new Date(Date.UTC(ev.end.year, ev.end.month - 1, ev.end.day))
          : ev.end;
        if (ep.getTime() - sp.getTime() > 86400000) {
          bits.push('through ' + ep.toLocaleDateString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'
          }));
        }
      }
    } else {
      var startOpts = {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      };
      if (o.timezone) startOpts.timeZone = o.timezone;
      var startLabel = ev.start.toLocaleString(undefined, startOpts);
      if (ev.end) {
        var sameDay = dayKey(ev.start, o.timezone) === dayKey(ev.end, o.timezone);
        var endOpts = sameDay
          ? { hour: 'numeric', minute: '2-digit' }
          : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
        if (o.timezone) endOpts.timeZone = o.timezone;
        startLabel += ' – ' + ev.end.toLocaleString(undefined, endOpts);
      }
      bits.push(startLabel);
      if (o.timezone) bits.push(o.timezone);
    }
    var rule = /FREQ=([A-Z]+)/.exec(o.rrule || '');
    if (rule) bits.push('Repeats ' + rule[1].toLowerCase());
    if (Array.isArray(o.alarms) && o.alarms.length) {
      bits.push(o.alarms.map(function (a) {
        return 'remind ' + humanizeDuration(a.trigger) + ' before';
      }).join(' & '));
    }
    if (o.location) bits.push(o.location);
    return bits.join(' · ');
  }

  function render() {
    var list = $('event-list');
    list.textContent = '';

    if (!cal.events.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No events yet. Add one on the left, or load the samples.';
      list.appendChild(li);
    } else {
      cal.events.forEach(function (ev, i) {
        var li = document.createElement('li');

        var info = document.createElement('div');
        info.className = 'event-info';
        var strong = document.createElement('strong');
        strong.textContent = ev.options.title;
        var small = document.createElement('small');
        small.textContent = describeEvent(ev);
        info.appendChild(strong);
        info.appendChild(small);

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn ghost';
        del.textContent = 'Remove';
        del.addEventListener('click', function () {
          cal.removeEvent(i);
          render();
        });

        li.appendChild(info);
        li.appendChild(del);
        list.appendChild(li);
      });
    }

    $('event-count').textContent = cal.events.length + (cal.events.length === 1 ? ' event' : ' events');
    $('preview').textContent = cal.toString();

    var has = cal.events.length > 0;
    $('download-btn').disabled = !has;
    $('copy-btn').disabled = !has;
    /* Auto-show the preview once any event exists; collapse when the list empties. */
    $('preview-box').open = has;
  }

  /* ---------- actions ---------- */

  $('event-form').addEventListener('submit', function (e) {
    e.preventDefault();
    try {
      var ev = cal.addEvent(readForm());
      /* quick-entry flow: roll the form forward to the next slot */
      if (!$('all-day').checked && endDateEl.value && endTimeEl.value) {
        startDateEl.value = endDateEl.value;
        startTimeEl.value = endTimeEl.value;
        var next = new Date(endDateEl.value + 'T' + endTimeEl.value);
        next.setMinutes(next.getMinutes() + 60);
        endDateEl.value = toISODate(next);
        endTimeEl.value = toISOTime(next);
      }
      render();
      setStatus('Added "' + ev.options.title + '" to the calendar.');
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $('download-btn').addEventListener('click', function () {
    IcsGenerator.download(slugify(cal.events[0].options.title) + '.ics', cal.toString());
    setStatus('Download started.');
  });

  $('copy-btn').addEventListener('click', function () {
    var text = cal.toString();
    function done() { setStatus('Copied to clipboard.'); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { setStatus('Copy failed — select the text manually.', true); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  });

  $('clear-btn').addEventListener('click', function () {
    if (cal.events.length && !window.confirm('Remove all ' + cal.events.length + ' event(s) from the list?')) return;
    cal.clear();
    render();
    setStatus('Cleared.');
  });

  $('sample-btn').addEventListener('click', function () {
    cal.clear();

    /* 1. recurring standup — remind 10 min before (number trigger) */
    cal.addEvent({
      title: 'Team standup',
      description: 'Daily sync — what I did, what I am doing, blockers.',
      location: 'Zoom',
      start: nextWeekday(1, 9, 0),
      durationMinutes: 30,
      rrule: 'FREQ=WEEKLY',
      categories: ['Work', 'Standup'],
      alarms: [{ trigger: -10 }]
    });

    /* 2. all-day multi-day event — remind 1 day before */
    var offsite = daysFromNow(21);
    var offsiteEnd = daysFromNow(22);
    cal.addEvent({
      title: 'Quarterly planning offsite',
      description: 'Annual planning for next quarter. Bring your laptops!',
      location: 'Mountain lodge',
      start: { year: offsite.getFullYear(), month: offsite.getMonth() + 1, day: offsite.getDate() },
      end: { year: offsiteEnd.getFullYear(), month: offsiteEnd.getMonth() + 1, day: offsiteEnd.getDate() },
      categories: ['Release', 'Planning'],
      alarms: [{ trigger: '-P1D' }]
    });

    /* 3. one-off with attendees — remind 2 hours before */
    cal.addEvent({
      title: 'Design review',
      start: nextWeekday(3, 14, 0),
      durationMinutes: 60,
      location: 'Room 4B',
      url: 'https://example.com/design-review',
      status: 'TENTATIVE',
      organizer: { name: 'Pat Manager', email: 'pat@example.com' },
      attendees: [
        { name: 'Riley Dev', email: 'riley@example.com', role: 'REQ-PARTICIPANT' },
        { email: 'sam@example.com', status: 'NEEDS-ACTION' }
      ],
      alarms: [{ trigger: '-PT2H' }]
    });

    render();
    setStatus('Loaded 3 sample events. Try downloading the .ics and importing it.');
  });

  /* ---------- init ---------- */

  defaultFormDates();
  populateTimeZones();
  syncAllDayUI();
  syncRecurUI();
  syncReminderUI();
  render();
})();