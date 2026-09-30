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

  /* Time-zone math lives in ics.js so the importer can share it. */
  var zoneParts = IcsGenerator.zoneParts;
  var zonedTimeToDate = IcsGenerator.zonedTimeToDate;

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

    var orgName = $('organizer-name').value.trim();
    var orgEmail = $('organizer-email').value.trim();
    if (orgEmail || orgName) {
      if (!orgEmail) throw new Error('Add an email address for the organizer (or clear the name).');
      opts.organizer = { email: orgEmail };
      if (orgName) opts.organizer.name = orgName;
    }
    var attendees = readAttendees();
    if (attendees.length) opts.attendees = attendees;

    return opts;
  }

  function readAttendees() {
    var rows = document.querySelectorAll('#attendee-list .attendee-row');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var name = row.querySelector('.att-name').value.trim();
      var email = row.querySelector('.att-email').value.trim();
      var role = row.querySelector('.att-role').value;
      var status = row.querySelector('.att-status').value;
      var rsvp = row.querySelector('.att-rsvp-input').checked;
      if (!name && !email && !rsvp) continue; /* untouched row */
      if (!email) throw new Error('Attendee ' + (i + 1) + ' needs an email address.');
      var a = { email: email };
      if (name) a.name = name;
      if (role) a.role = role;
      if (status) a.status = status;
      if (rsvp) a.rsvp = true;
      out.push(a);
    }
    return out;
  }

  /* ---------- filling the form from imported data ---------- */

  function isoFromParts(p) { return p.year + '-' + pad2(p.month) + '-' + pad2(p.day); }

  function setDateInput(el, parts) {
    if (parts && parts.year) el.value = isoFromParts(parts);
  }

  function hasZone(tz) {
    for (var i = 0; i < timezoneEl.options.length; i++) {
      if (timezoneEl.options[i].value === tz) return true;
    }
    return false;
  }

  /* The zone to show an imported instant in: the event's own zone when the
   * picker knows it, otherwise the device zone. */
  function zoneForForm(tz) {
    if (tz && hasZone(tz)) return tz;
    return localTimeZone();
  }

  /* Only the form's simple subset (FREQ/INTERVAL/UNTIL) is representable;
   * anything else (COUNT, BYDAY, …) is preserved on the event but not loaded. */
  function simpleRule(rule, allDay, tz) {
    var out = { freq: null, interval: 1, until: '' };
    var parts = String(rule).split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var k = (kv[0] || '').toUpperCase();
      var v = kv[1] || '';
      if (k === 'FREQ') {
        if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(v)) return null;
        out.freq = v;
      } else if (k === 'INTERVAL') {
        out.interval = parseInt(v, 10) || 1;
      } else if (k === 'UNTIL') {
        var u = untilToDate(v, allDay, tz);
        if (!u) return null;
        out.until = u;
      } else {
        return null;
      }
    }
    return out.freq ? out : null;
  }

  /* RRULE UNTIL → a value for the date input. */
  function untilToDate(value, allDay, tz) {
    var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
    if (!m) return '';
    if (!m[4]) return m[1] + '-' + m[2] + '-' + m[3];
    var date = m[7]
      ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)))
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    var p = zoneParts(date, m[7] ? 'UTC' : (tz || localTimeZone()));
    return isoFromParts(p);
  }

  /* A relative "before" trigger (-PT10M / -P1D) → the reminder controls. */
  function parseTrigger(trigger) {
    if (typeof trigger === 'number') {
      return trigger < 0 ? { value: Math.abs(trigger), unit: 'minutes' } : null;
    }
    var s = String(trigger == null ? '' : trigger).trim();
    if (s.charAt(0) !== '-') return null;
    var m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s.slice(1));
    if (!m) return null;
    if (m[1]) return { value: parseInt(m[1], 10), unit: 'days' };
    if (m[2]) return { value: parseInt(m[2], 10), unit: 'hours' };
    if (m[3]) return { value: parseInt(m[3], 10), unit: 'minutes' };
    return null;
  }

  var ATTENDEE_ROLES = [
    ['REQ-PARTICIPANT', 'Required'],
    ['OPT-PARTICIPANT', 'Optional'],
    ['NON-PARTICIPANT', 'Non-participant'],
    ['CHAIR', 'Chair']
  ];
  var ATTENDEE_STATUSES = [
    ['NEEDS-ACTION', 'No reply'],
    ['ACCEPTED', 'Accepted'],
    ['DECLINED', 'Declined'],
    ['TENTATIVE', 'Tentative']
  ];

  function attendeeField(type, cls, placeholder, aria, value) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var input = document.createElement('input');
    input.type = type;
    input.className = cls;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', aria);
    input.autocomplete = 'off';
    input.value = value;
    wrap.appendChild(input);
    return wrap;
  }

  function attendeeSelect(cls, aria, options, value, fallback) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var sel = document.createElement('select');
    sel.className = cls;
    sel.setAttribute('aria-label', aria);
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0];
      o.textContent = opt[1];
      sel.appendChild(o);
    });
    var known = options.some(function (o) { return o[0] === value; });
    sel.value = known ? value : fallback;
    wrap.appendChild(sel);
    return wrap;
  }

  function addAttendeeRow(a) {
    a = a || {};
    var box = $('attendee-list');
    var row = document.createElement('div');
    row.className = 'attendee-row';

    row.appendChild(attendeeField('text', 'att-name', 'Name', 'Attendee name', a.name || ''));
    row.appendChild(attendeeField('email', 'att-email', 'Email', 'Attendee email', a.email || ''));
    row.appendChild(attendeeSelect('att-role', 'Attendee role', ATTENDEE_ROLES, a.role, 'REQ-PARTICIPANT'));
    row.appendChild(attendeeSelect('att-status', 'Attendee status', ATTENDEE_STATUSES, a.status, 'NEEDS-ACTION'));

    var rsvpLabel = document.createElement('label');
    rsvpLabel.className = 'att-rsvp';
    var rsvp = document.createElement('input');
    rsvp.type = 'checkbox';
    rsvp.className = 'att-rsvp-input';
    rsvp.checked = !!a.rsvp;
    rsvpLabel.appendChild(rsvp);
    rsvpLabel.appendChild(document.createTextNode('RSVP'));
    row.appendChild(rsvpLabel);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn ghost att-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove attendee');
    remove.addEventListener('click', function () { box.removeChild(row); });
    row.appendChild(remove);

    box.appendChild(row);
  }

  function setOrganizer(org) {
    $('organizer-name').value = org && org.name ? org.name : '';
    $('organizer-email').value = org && org.email ? org.email : '';
  }

  function setAttendees(list) {
    var box = $('attendee-list');
    box.textContent = '';
    (list || []).forEach(addAttendeeRow);
  }

  $('add-attendee-btn').addEventListener('click', function () {
    addAttendeeRow();
    var rows = document.querySelectorAll('#attendee-list .attendee-row');
    var last = rows[rows.length - 1];
    if (last) last.querySelector('.att-name').focus();
  });

  function populateForm(ev) {
    $('title').value = ev.title || '';
    $('description').value = ev.description || '';
    $('location').value = ev.location || '';
    $('url').value = ev.url || '';
    $('categories').value = (ev.categories || []).join(', ');
    $('status').value = /^(CONFIRMED|TENTATIVE|CANCELLED)$/.test(ev.status || '') ? ev.status : 'CONFIRMED';

    var allDay = !!ev.allDay;
    $('all-day').checked = allDay;

    if (allDay) {
      setDateInput(startDateEl, ev.start);
      if (ev.end) setDateInput(endDateEl, ev.end);
    } else {
      var zone = zoneForForm(ev.timezone);
      var sp = zoneParts(ev.start, zone);
      startDateEl.value = isoFromParts(sp);
      startTimeEl.value = pad2(sp.hour) + ':' + pad2(sp.minute);
      var end = ev.end || new Date(ev.start.getTime() +
        (ev.durationMinutes > 0 ? ev.durationMinutes : 60) * 60000);
      var ep = zoneParts(end, zone);
      endDateEl.value = isoFromParts(ep);
      endTimeEl.value = pad2(ep.hour) + ':' + pad2(ep.minute);
      timezoneEl.value = zone;
    }
    syncAllDayUI();

    var rule = ev.rrule ? simpleRule(ev.rrule, allDay, timezoneEl.value) : null;
    $('recur-freq').value = rule ? rule.freq : 'NONE';
    $('recur-interval').value = rule ? rule.interval : 1;
    $('recur-until').value = rule ? rule.until : '';
    syncRecurUI();

    var alarm = ev.alarms && ev.alarms[0] ? parseTrigger(ev.alarms[0].trigger) : null;
    $('reminder-toggle').value = alarm ? 'on' : 'off';
    if (alarm) {
      $('reminder-value').value = alarm.value;
      $('reminder-unit').value = alarm.unit;
    }
    syncReminderUI();

    setOrganizer(ev.organizer);
    setAttendees(ev.attendees);
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
    if (o.organizer && o.organizer.email) bits.push('by ' + (o.organizer.name || o.organizer.email));
    if (Array.isArray(o.attendees) && o.attendees.length) {
      bits.push(o.attendees.length + (o.attendees.length === 1 ? ' attendee' : ' attendees'));
    }
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
    /* The preview starts expanded (see the `open` attribute in index.html) and
     * never auto-collapses; the visitor can still toggle it. */
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

  var copyFlashTimer = null;

  /* The toolbar button is far from the status line, so confirm the copy in the
   * button label itself for a moment. */
  function flashCopied() {
    var btn = $('copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(function () {
      btn.textContent = 'Copy .ics';
      btn.classList.remove('copied');
      copyFlashTimer = null;
    }, 1600);
  }

  $('copy-btn').addEventListener('click', function () {
    var text = cal.toString();
    function done() { setStatus('Copied to clipboard.'); flashCopied(); }
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

  /* True when the visitor has put something into the form. The date/time inputs
   * are pre-filled on load, so they alone do not count. */
  function formHasUserContent() {
    if ($('title').value.trim() || $('description').value.trim() ||
        $('location').value.trim() || $('categories').value.trim() ||
        $('url').value.trim() ||
        $('organizer-name').value.trim() || $('organizer-email').value.trim()) return true;
    if (document.querySelector('#attendee-list .attendee-row')) return true;
    if ($('recur-freq').value !== 'NONE') return true;
    if ($('reminder-toggle').value === 'on') return true;
    if ($('all-day').checked) return true;
    return false;
  }

  $('sample-btn').addEventListener('click', function () {
    var changes = [];
    if (cal.events.length) changes.push('replace the ' + cal.events.length + ' event(s) in the list');
    if (formHasUserContent()) changes.push('overwrite the form fields');
    if (changes.length && !window.confirm('Load sample events? This will ' + changes.join(' and ') + '.')) return;

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

    /* 3. one-off with attendees — remind 2 hours before; kept in a variable so
     *    it can also be loaded into the form (it exercises the most fields). */
    var designReview = {
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
    };
    cal.addEvent(designReview);

    render();
    /* Show the richest sample in the form so the .ics ↔ fields mapping is visible. */
    populateForm(designReview);
    setStatus('Loaded 3 sample events. The form shows "Design review" so you can see how it maps to the fields.');
  });

  /* ---------- importing .ics ---------- */

  var MAX_IMPORT_CHARS = 2 * 1024 * 1024;

  function setImportStatus(msg, isError) {
    var el = $('import-status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function looksLikeEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }
  function looksLikeHttpUrl(s) { return /^https?:\/\//i.test(String(s || '')); }

  /* Parsed event → addEvent options, dropping only what ics.js would reject so
   * one bad field never costs the whole event. */
  function importOptions(ev, warnings) {
    var label = ev.title ? '"' + ev.title + '"' : 'An event';
    var o = { title: ev.title || 'Untitled event' };
    if (ev.uid) o.uid = ev.uid;
    if (ev.allDay) {
      o.allDay = true;
      o.start = ev.start;
      if (ev.end) o.end = ev.end;
    } else {
      o.start = ev.start;
      if (ev.end) o.end = ev.end;
      if (ev.timezone && ev.timezone !== 'UTC') o.timezone = ev.timezone;
    }
    if (ev.description) o.description = ev.description;
    if (ev.location) o.location = ev.location;
    if (ev.url) {
      if (looksLikeHttpUrl(ev.url)) o.url = ev.url;
      else warnings.push(label + ': dropped a web link that was not http(s).');
    }
    if (/^(CONFIRMED|TENTATIVE|CANCELLED)$/.test(ev.status || '')) o.status = ev.status;
    if (ev.categories && ev.categories.length) o.categories = ev.categories;
    if (ev.rrule) o.rrule = ev.rrule;
    if (ev.alarms && ev.alarms.length) o.alarms = ev.alarms;
    if (ev.organizer && ev.organizer.email) {
      if (looksLikeEmail(ev.organizer.email)) {
        o.organizer = { email: ev.organizer.email };
        if (ev.organizer.name) o.organizer.name = ev.organizer.name;
      } else {
        warnings.push(label + ': dropped an organizer email that did not look valid.');
      }
    }
    if (ev.attendees && ev.attendees.length) {
      var keep = [];
      ev.attendees.forEach(function (a) {
        if (!looksLikeEmail(a.email)) {
          warnings.push(label + ': dropped an attendee email that did not look valid.');
          return;
        }
        var out = { email: a.email };
        if (a.name) out.name = a.name;
        if (a.role) out.role = a.role;
        if (a.status) out.status = a.status;
        if (a.rsvp) out.rsvp = true;
        keep.push(out);
      });
      if (keep.length) o.attendees = keep;
    }
    if (ev.unsupported && ev.unsupported.length) {
      warnings.push(label + ': ignored ' + ev.unsupported.join(', ') + '.');
    }
    return o;
  }

  function applyImport(text, sourceLabel) {
    if (!text || !text.trim()) { setImportStatus('Nothing to import — the text was empty.', true); return; }
    if (text.length > MAX_IMPORT_CHARS) { setImportStatus('That text is too large to import (over 2 MB).', true); return; }

    var result;
    try {
      result = IcsGenerator.parse(text);
    } catch (err) {
      setImportStatus(err.message, true);
      return;
    }
    if (!result.events.length) {
      setImportStatus('No events found in ' + (sourceLabel || 'that text') + '.', true);
      return;
    }

    var warnings = result.warnings.slice();
    var added = 0;
    result.events.forEach(function (ev) {
      try {
        cal.addEvent(importOptions(ev, warnings));
        added++;
      } catch (err) {
        warnings.push('Skipped an event: ' + err.message);
      }
    });

    if (added) {
      render();
      /* Collapse the panel so the (now populated) form is pulled into view. */
      $('import-box').open = false;
      if (result.events.length === 1) {
        populateForm(result.events[0]);
        $('title').focus();
      }
    }

    var msg = 'Imported ' + added + ' of ' + result.events.length +
      ' event' + (result.events.length === 1 ? '' : 's');
    if (sourceLabel) msg += ' from ' + sourceLabel;
    msg += '.';
    if (added && result.events.length === 1) msg += ' Fields loaded into the form above (the event is already in the list).';
    if (warnings.length) {
      msg += ' ' + warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') +
        ': ' + warnings.slice(0, 3).join(' ') + (warnings.length > 3 ? ' …' : '');
    }
    setImportStatus(msg, added === 0);
    if (added) setStatus('Imported ' + added + ' event' + (added === 1 ? '' : 's') + '.');
  }

  function readImportFile(file) {
    if (!file) return;
    var name = String(file.name || '');
    if (file.size > MAX_IMPORT_CHARS) {
      setImportStatus('"' + name + '" is larger than 2 MB — refusing to parse it.', true);
      return;
    }
    function done(text) { applyImport(text, '"' + name + '"'); }
    function fail() { setImportStatus('Could not read "' + name + '".', true); }
    if (typeof file.text === 'function') {
      file.text().then(done, fail);
    } else {
      var reader = new FileReader();
      reader.onload = function () { done(String(reader.result || '')); };
      reader.onerror = fail;
      reader.readAsText(file);
    }
  }

  $('import-file').addEventListener('change', function (e) {
    readImportFile(e.target.files && e.target.files[0]);
    e.target.value = ''; /* allow re-importing the same file */
  });

  $('import-text-btn').addEventListener('click', function () {
    applyImport($('import-text').value, 'pasted text');
  });
  $('import-text').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      applyImport($('import-text').value, 'pasted text');
    }
  });

  var dropZone = $('drop-zone');
  ['dragenter', 'dragover'].forEach(function (type) {
    dropZone.addEventListener(type, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dragging');
    });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    dropZone.addEventListener(type, function (e) {
      e.preventDefault();
      dropZone.classList.remove('dragging');
    });
  });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragging');
    var dt = e.dataTransfer;
    if (!dt) return;
    var file = dt.files && dt.files[0];
    if (file) { readImportFile(file); return; }
    var pasted = dt.getData ? dt.getData('text') : '';
    if (pasted) applyImport(pasted, 'dropped text');
    else setImportStatus('Drop an .ics file, or paste its text below.', true);
  });
  /* A file dropped outside the zone should not make the browser navigate to it;
   * text dropped on an input keeps its native behaviour. */
  function isTextTarget(el) { return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'); }
  window.addEventListener('dragover', function (e) {
    if (!isTextTarget(e.target)) e.preventDefault();
  });
  window.addEventListener('drop', function (e) {
    if (isTextTarget(e.target) || dropZone.contains(e.target)) return;
    e.preventDefault();
  });

  /* ---------- init ---------- */

  defaultFormDates();
  populateTimeZones();
  syncAllDayUI();
  syncRecurUI();
  syncReminderUI();
  render();
})();