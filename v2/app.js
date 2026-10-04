/**
 * ICS Generator demo app — form wiring and event-list rendering.
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

  /* Hard ceiling on the list. Every growth point (form submit, duplicate,
   * import) checks it and restore applies it, so the cap can never be evaded
   * silently. */
  var MAX_EVENTS = 200;

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
  function isDateParts(v) {
    return v && typeof v === 'object' &&
      typeof v.year === 'number' && typeof v.month === 'number' && typeof v.day === 'number';
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

  /* Session caches: "UTC±HH:MM" labels keyed by zone, and the full IANA zone
   * list. Offsets are computed once per zone, the first time it is shown. */
  var zoneOffsetCache = {};
  var allZonesCache = null;

  function formatOffsetMinutes(minutes) {
    var sign = minutes < 0 ? '-' : '+';
    var abs = Math.abs(minutes);
    return sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
  }

  /* Offset in minutes, derived from the zone's wall clock vs UTC right now. */
  function wallClockOffset(zone) {
    var now = new Date();
    var z = zoneParts(now, zone);
    var u = zoneParts(now, 'UTC');
    var diff = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) -
      Date.UTC(u.year, u.month - 1, u.day, u.hour, u.minute, u.second);
    return Math.round(diff / 60000);
  }

  /* "UTC+02:00" for a zone right now. Intl's longOffset is authoritative and
   * handles Etc/GMT±N (whose zone-name signs are inverted); wall-clock math is
   * the fallback for engines without longOffset. */
  function utcOffset(zone) {
    if (Object.prototype.hasOwnProperty.call(zoneOffsetCache, zone)) return zoneOffsetCache[zone];
    var label = null;
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, timeZoneName: 'longOffset'
      }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type !== 'timeZoneName') continue;
        var name = parts[i].value;
        if (name === 'GMT' || name === 'UTC') { label = 'UTC+00:00'; break; }
        var m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
        if (m) { label = 'UTC' + m[1] + pad2(parseInt(m[2], 10)) + ':' + (m[3] || '00'); break; }
      }
    } catch (e) { /* fall back below */ }
    if (!label) {
      try { label = 'UTC' + formatOffsetMinutes(wallClockOffset(zone)); }
      catch (e2) { return null; }
    }
    zoneOffsetCache[zone] = label;
    return label;
  }

  /* A failed offset lookup stays uncached and has no misleading suffix. */
  function timeZoneLabel(zone, device) {
    var offset = utcOffset(zone);
    return offset ? zone + ' (' + (device ? 'your device, ' : '') + offset + ')' : zone;
  }

  /* Every IANA zone the picker can show, excluding the device zone and UTC
   * (both pinned separately). Built once per session. */
  function allTimeZones() {
    if (allZonesCache) return allZonesCache;
    var local = localTimeZone();
    var zones = availableTimeZones();
    if (zones.indexOf(local) === -1) zones.push(local);
    zones = zones.filter(function (z, i) {
      return z && zones.indexOf(z) === i && z !== local && z !== 'UTC';
    });
    zones.sort();
    allZonesCache = zones;
    return allZonesCache;
  }

  function timeZoneFilterValue() {
    var el = $('timezone-filter');
    return el ? String(el.value || '').trim() : '';
  }

  function optionValueExists(sel, value) {
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === value) return true;
    }
    return false;
  }

  function appendZoneGroups(sel, zones) {
    var groups = {};
    zones.forEach(function (z) {
      var g = timeZoneGroup(z);
      (groups[g] = groups[g] || []).push(z);
    });
    Object.keys(groups).sort().forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g;
      groups[g].forEach(function (z) {
        og.appendChild(timeZoneOption(z, timeZoneLabel(z)));
      });
      sel.appendChild(og);
    });
  }

  /* Build the option list for the current filter: device zone pinned first,
   * then UTC, then every IANA zone grouped by region. A non-empty filter keeps
   * only matching zones, but always keeps the currently-selected value so the
   * select can never lose it. */
  function renderTimeZones() {
    var sel = timezoneEl;
    var local = localTimeZone();
    var filter = timeZoneFilterValue();
    var needle = filter.toLowerCase();
    var current = sel.value || local;
    sel.textContent = '';

    var matches = function (zone) {
      return !needle || zone.toLowerCase().indexOf(needle) !== -1;
    };

    var matchedAny = false;
    if (matches(local)) {
      sel.appendChild(timeZoneOption(local, timeZoneLabel(local, true)));
      matchedAny = true;
    }
    if (local !== 'UTC' && matches('UTC')) {
      sel.appendChild(timeZoneOption('UTC', 'UTC (Coordinated Universal Time)'));
      matchedAny = true;
    }

    var zones = allTimeZones().filter(matches);
    if (zones.length) matchedAny = true;
    appendZoneGroups(sel, zones);

    if (!optionValueExists(sel, current)) {
      sel.insertBefore(timeZoneOption(current, timeZoneLabel(current)), sel.firstChild);
    }

    if (filter && !matchedAny) {
      var none = document.createElement('option');
      none.disabled = true;
      none.textContent = 'No zones match "' + filter + '"';
      sel.appendChild(none);
    }

    sel.value = current;
  }

  /* Device zone first and selected, then UTC, then every IANA zone grouped by
   * region. Populated from Intl so the list stays current without a hard-coded
   * table in the HTML. */
  function populateTimeZones() {
    var filterEl = $('timezone-filter');
    if (filterEl) filterEl.value = '';
    renderTimeZones();
    timezoneEl.value = localTimeZone();
  }

  /* Set the select to `zone`, clearing an active filter first when the target
   * zone is not currently listed so populateForm can never silently drop it. */
  function setTimeZoneValue(zone) {
    zone = zoneForForm(zone);
    if (!optionValueExists(timezoneEl, zone) && timeZoneFilterValue()) {
      $('timezone-filter').value = '';
      renderTimeZones();
    }
    timezoneEl.value = zone;
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
    rememberStartInstant();
  }

  /* Visibility only: which controls an all-day event hides. Kept separate from
   * the date correction below so restoring a snapshot can reproduce its values
   * exactly without the auto-bump rewriting the visitor's draft. */
  function syncAllDayVisibility() {
    var allDay = $('all-day').checked;
    $('field-start-time').hidden = allDay;
    $('field-end-time').hidden = allDay;
    /* All-day events are date-only, so a time zone would be misleading. */
    $('field-timezone').hidden = allDay;
    /* DTEND on an all-day event is exclusive — only worth explaining when the
     * end date itself is visible. */
    $('all-day-end-hint').hidden = !allDay;
  }

  function syncAllDayUI() {
    syncAllDayVisibility();
    var allDay = $('all-day').checked;
    if (allDay && endDateEl.value && startDateEl.value && endDateEl.value <= startDateEl.value) {
      endDateEl.value = addDays(startDateEl.value, 1);
      /* The rewritten end date is valid again, so drop any stale inline error. */
      clearFieldError('end-date');
    }
  }

  /* Weekly recurrence day codes in RFC 5545 / calendar order. */
  var WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

  function bydayBoxes() {
    return document.querySelectorAll('#field-byday input[type="checkbox"]');
  }

  /* Checked day codes, in the picker's DOM order (already MO…SU). */
  function readByday() {
    var boxes = bydayBoxes();
    var out = [];
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) out.push(boxes[i].value);
    }
    return out;
  }

  function setByday(days) {
    var boxes = bydayBoxes();
    var want = days || [];
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = want.indexOf(boxes[i].value) !== -1;
    }
  }

  /* Canonical MO…SU order so a representable rule always re-emits identically. */
  function sortByday(days) {
    return WEEKDAY_CODES.filter(function (code) { return days.indexOf(code) !== -1; });
  }

  /* BYDAY value → canonical day codes, or null when any token is not one of the
   * seven weekday codes (ordinals like "2MO", malformed/empty values). */
  function parseByday(value) {
    var tokens = String(value).toUpperCase().split(',');
    var days = [];
    for (var i = 0; i < tokens.length; i++) {
      var code = tokens[i].trim();
      if (WEEKDAY_CODES.indexOf(code) === -1) return null;
      if (days.indexOf(code) === -1) days.push(code);
    }
    return days.length ? sortByday(days) : null;
  }

  /* The weekday of the current start date, as a BYDAY code. */
  function startWeekdayCode() {
    if (!startDateEl.value) return null;
    var p = parseDateInput(startDateEl.value);
    var d = new Date(p.year, p.month - 1, p.day);
    return WEEKDAY_CODES[(d.getDay() + 6) % 7];
  }

  /* Entering WEEKLY with nothing checked defaults to the start date's weekday. */
  function defaultBydayToStart() {
    if (readByday().length) return;
    var code = startWeekdayCode();
    if (code) setByday([code]);
  }

  function syncRecurUI() {
    var freq = $('recur-freq').value;
    var off = freq === 'NONE';
    var end = $('recur-end').value;
    $('field-interval').hidden = off;
    $('field-end').hidden = off;
    $('field-count').hidden = off || end !== 'after';
    $('field-until').hidden = off || end !== 'on-date';
    $('field-byday').hidden = off || freq !== 'WEEKLY';
    /* Down to just the select? Let it span a Status-select-sized column
     * instead of the first third of the row (which clips "Does not repeat"). */
    $('recur-row').classList.toggle('single', off);
  }

  function reminderRows() {
    return document.querySelectorAll('#reminder-rows .reminder-row');
  }

  function syncReminderUI() {
    var rows = reminderRows();
    $('add-reminder-btn').disabled = rows.length >= 5;
    for (var i = 0; i < rows.length; i++) {
      rows[i].querySelector('.reminder-value').setAttribute('aria-label', 'Reminder ' + (i + 1) + ' value');
      rows[i].querySelector('.reminder-unit').setAttribute('aria-label', 'Reminder ' + (i + 1) + ' unit');
      rows[i].querySelector('.reminder-remove').setAttribute('aria-label', 'Remove reminder ' + (i + 1));
    }
  }

  $('all-day').addEventListener('change', syncAllDayUI);
  $('recur-freq').addEventListener('change', function () {
    if ($('recur-freq').value === 'WEEKLY') defaultBydayToStart();
    syncRecurUI();
    updateKeptHint();
  });
  $('recur-end').addEventListener('change', function () { syncRecurUI(); updateKeptHint(); });
  $('recur-count').addEventListener('change', updateKeptHint);
  /* Delegated so every dynamically added reminder row refreshes the hint. */
  $('reminder-rows').addEventListener('input', updateKeptHint);
  $('reminder-rows').addEventListener('change', updateKeptHint);
  $('add-reminder-btn').addEventListener('click', function () {
    var row = addReminderRow();
    updateKeptHint();
    if (row) row.querySelector('.reminder-value').focus();
  });

  /* Keep the end after the start when the start moves past it: shift the end by
   * the duration entered before the change (min 1 hour). The previous start
   * instant is cached, because a change event only carries the new value. */
  var prevStartInstant = null;

  function instantFromDateInput(dateStr, timeStr) {
    if (!dateStr) return null;
    var d = parseDateInput(dateStr);
    var t = parseTimeInput(timeStr || '00:00'); /* missing time → midnight */
    return zonedTimeToDate(d.year, d.month, d.day, t.hour, t.minute, timezoneEl.value || localTimeZone());
  }

  function rememberStartInstant() {
    prevStartInstant = instantFromDateInput(startDateEl.value, startTimeEl.value);
  }

  function keepEndAfterStart() {
    if ($('all-day').checked) {
      /* Plain date strings: end <= start becomes start + 1 day (syncAllDayUI). */
      syncAllDayUI();
    } else {
      var newStart = instantFromDateInput(startDateEl.value, startTimeEl.value);
      var end = instantFromDateInput(endDateEl.value, endTimeEl.value);
      if (newStart && end && prevStartInstant && newStart.getTime() >= end.getTime()) {
        var duration = Math.max(end.getTime() - prevStartInstant.getTime(), 60 * 60000);
        var tz = timezoneEl.value || localTimeZone();
        var projected = newStart.getTime() + duration;
        var p = zoneParts(new Date(projected), tz);
        /* Around a DST fall-back the projected wall clock can re-parse to the
         * same (or an earlier) instant as the start, because the repeated hour
         * is always read as its first occurrence. Step the projection forward
         * until what readForm() would parse is strictly after the new start. */
        for (var i = 0; i < 6; i++) {
          var reparsed = zonedTimeToDate(p.year, p.month, p.day, p.hour, p.minute, tz);
          if (reparsed.getTime() > newStart.getTime()) break;
          projected += 30 * 60000;
          p = zoneParts(new Date(projected), tz);
        }
        endDateEl.value = isoFromParts(p);
        endTimeEl.value = pad2(p.hour) + ':' + pad2(p.minute);
      }
    }
    rememberStartInstant();
  }
  startDateEl.addEventListener('change', keepEndAfterStart);
  startTimeEl.addEventListener('change', keepEndAfterStart);
  /* The cached start instant is zone-dependent; re-read it when the zone changes
   * so a later start change measures duration from the correct instant. */
  timezoneEl.addEventListener('change', rememberStartInstant);
  $('timezone-filter').addEventListener('input', renderTimeZones);

  /* ---------- validation ---------- */

  /* Inline field errors live next to the control they describe: the `.field`
   * wrapper gets `.invalid`, the control gets aria-invalid/aria-describedby,
   * and a <p class="field-error"> is inserted right after the control. */

  function fieldErrorId(fieldId) { return fieldId + '-error'; }

  function setFieldError(fieldId, message) {
    var input = $(fieldId);
    if (!input) return;
    var wrap = input.closest ? input.closest('.field') : null;
    if (!wrap) return;
    var errId = fieldErrorId(fieldId);
    wrap.classList.add('invalid');
    input.setAttribute('aria-invalid', 'true');
    var ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (ids.indexOf(errId) === -1) ids.push(errId);
    input.setAttribute('aria-describedby', ids.join(' '));

    var err = document.getElementById(errId);
    if (!err) {
      err = document.createElement('p');
      err.className = 'field-error';
      err.id = errId;
      if (input.nextSibling) wrap.insertBefore(err, input.nextSibling);
      else wrap.appendChild(err);
    }
    err.textContent = message;
  }

  function clearFieldError(fieldId) {
    var input = $(fieldId);
    if (!input) return;
    var wrap = input.closest ? input.closest('.field') : null;
    if (wrap) wrap.classList.remove('invalid');

    var errId = fieldErrorId(fieldId);
    input.removeAttribute('aria-invalid');
    var ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
      .filter(function (id) { return id !== errId; });
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');

    var err = document.getElementById(errId);
    if (err && err.parentNode) err.parentNode.removeChild(err);
  }

  function clearAllFieldErrors() {
    var wraps = document.querySelectorAll('#event-form .field.invalid');
    for (var i = 0; i < wraps.length; i++) {
      wraps[i].classList.remove('invalid');
      var input = wraps[i].querySelector('input, select, textarea');
      if (!input) continue;
      input.removeAttribute('aria-invalid');
      if (!input.id) continue;
      var errId = fieldErrorId(input.id);
      var ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)
        .filter(function (id) { return id !== errId; });
      if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
      else input.removeAttribute('aria-describedby');
    }
    var errs = document.querySelectorAll('#event-form .field-error');
    for (var j = 0; j < errs.length; j++) {
      if (errs[j].parentNode) errs[j].parentNode.removeChild(errs[j]);
    }
  }

  /* Errors clear as soon as the visitor edits the offending control. Delegated
   * so dynamically added attendee rows are covered too. */
  $('event-form').addEventListener('input', function (e) {
    if (e.target && e.target.id) clearFieldError(e.target.id);
  });
  $('event-form').addEventListener('change', function (e) {
    if (e.target && e.target.id) clearFieldError(e.target.id);
  });

  function focusFirstInvalidField() {
    var controls = $('event-form').querySelectorAll('input, select, textarea');
    for (var i = 0; i < controls.length; i++) {
      if (controls[i].getAttribute('aria-invalid') === 'true') { controls[i].focus(); return; }
    }
  }

  /* Paint a map of field id → message and move focus to the first bad field in
   * DOM order; #status-msg carries a short generic explanation. */
  function showFormErrors(errors) {
    clearAllFieldErrors();
    Object.keys(errors).forEach(function (id) { setFieldError(id, errors[id]); });
    setStatus('Fix the highlighted fields and try again.', true);
    focusFirstInvalidField();
  }

  function firstInvalidAttendeeEmail() {
    var inputs = document.querySelectorAll('#attendee-list .att-email');
    for (var i = 0; i < inputs.length; i++) {
      var v = inputs[i].value.trim();
      if (v && !looksLikeEmail(v)) return inputs[i];
    }
    return null;
  }

  /* Map a genuine library rejection (ics.js validateEventOptions/VEvent) onto
   * the control that caused it. Returns false when it is not identifiable, so
   * the caller can fall back to the status line. */
  function showFieldErrorFromLib(err) {
    var msg = String((err && err.message) || '');
    var generic = 'Fix the highlighted fields and try again.';

    if (/event "url"/.test(msg)) {
      setFieldError('url', 'Enter a valid http(s) link, for example https://example.com/agenda.');
      setStatus(generic, true);
      focusFirstInvalidField();
      return true;
    }
    /* A control-character name is not an email problem: match it first so the
     * message lands on #organizer-name instead of the email field. */
    if (/organizer name/.test(msg)) {
      setFieldError('organizer-name', 'Remove special characters from the organizer name.');
      setStatus(generic, true);
      focusFirstInvalidField();
      return true;
    }
    if (/organizer email/.test(msg)) {
      setFieldError('organizer-email', 'Enter a valid email address for the organizer.');
      setStatus(generic, true);
      focusFirstInvalidField();
      return true;
    }
    if (/attendee/.test(msg)) {
      var input = firstInvalidAttendeeEmail();
      if (input && input.id) {
        setFieldError(input.id, 'Enter a valid email address for this attendee.');
        setStatus(generic, true);
        input.focus();
        return true;
      }
    }
    return false;
  }

  /* ---------- reading the form ---------- */

  /* Build the addEvent options. User-input problems are collected as a map of
   * field id → message (no throw) so the caller can render inline errors;
   * library-level checks still live in ics.js and are caught at the submit
   * boundary (showFieldErrorFromLib). */
  function readForm() {
    var errors = {};
    var opts = {};

    var title = $('title').value.trim();
    if (!title) errors['title'] = 'Please give the event a title.';
    opts.title = title;

    var allDay = $('all-day').checked;
    opts.allDay = allDay;

    if (allDay) {
      if (!startDateEl.value) {
        errors['start-date'] = 'Pick a start date.';
      } else {
        opts.start = parseDateInput(startDateEl.value); /* { year, month, day } — timezone-safe */
      }
      if (endDateEl.value) opts.end = parseDateInput(endDateEl.value);
      /* DTEND is exclusive, so end == start would emit a zero-length (or
       * immediate) all-day event — reject it rather than write DTEND == DTSTART. */
      if (opts.start && opts.end && isoFromParts(opts.end) <= isoFromParts(opts.start)) {
        errors['end-date'] = 'The end date must be after the start date.';
      }
    } else {
      if (!startDateEl.value) errors['start-date'] = 'Pick a start date.';
      if (!startTimeEl.value) errors['start-time'] = 'Pick a start time.';
      /* Read the typed wall-clock time in the chosen zone. 'UTC' is emitted as
       * a plain ...Z timestamp (no TZID); every other zone gets a TZID. */
      var tz = timezoneEl.value || localTimeZone();
      if (tz !== 'UTC') opts.timezone = tz;
      if (startDateEl.value && startTimeEl.value) {
        var sd = parseDateInput(startDateEl.value);
        var st = parseTimeInput(startTimeEl.value);
        opts.start = zonedTimeToDate(sd.year, sd.month, sd.day, st.hour, st.minute, tz);
      }
      if (endDateEl.value && endTimeEl.value) {
        var ed = parseDateInput(endDateEl.value);
        var et = parseTimeInput(endTimeEl.value);
        opts.end = zonedTimeToDate(ed.year, ed.month, ed.day, et.hour, et.minute, tz);
        if (opts.start && opts.end <= opts.start) {
          errors['end-date'] = 'The end date/time must be after the start.';
          errors['end-time'] = 'The end date/time must be after the start.';
        }
      } else if (opts.start) {
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
    if ($('transp').value === 'TRANSPARENT') opts.transp = 'TRANSPARENT';
    var priority = Number($('priority').value);
    if (priority >= 1) opts.priority = priority;

    var freq = $('recur-freq').value;
    if (freq !== 'NONE') {
      var parts = ['FREQ=' + freq];
      var iv = parseInt($('recur-interval').value, 10);
      if (!isNaN(iv) && iv > 1) parts.push('INTERVAL=' + iv);
      if (freq === 'WEEKLY') {
        /* No checked days means "weekly on the start weekday" (no BYDAY). */
        var days = sortByday(readByday());
        if (days.length) parts.push('BYDAY=' + days.join(','));
      }
      var end = $('recur-end').value;
      if (end === 'after') {
        var countEl = $('recur-count');
        /* Same raw-spelling rule as reminder rows: '1e2' must not slip through
         * as COUNT=100. */
        var rawCount = String(countEl.value).trim();
        var count = Number(rawCount);
        if (!/^[0-9]{1,3}$/.test(rawCount) || !Number.isInteger(count) || count < 1 || count > 999) {
          errors['recur-count'] = 'Pick a whole number of occurrences (1-999).';
        } else {
          parts.push('COUNT=' + count);
        }
      } else if (end === 'on-date') {
        var until = $('recur-until').value;
        if (!until) {
          errors['recur-until'] = 'Pick the date the recurrence ends on.';
        } else if (startDateEl.value && until < startDateEl.value) {
          errors['recur-until'] = 'The end date must be on or after the event start date.';
        } else {
          parts.push('UNTIL=' + untilFromDate(until, allDay, opts.timezone || 'UTC'));
        }
      }
      opts.rrule = parts.join(';');
    }

    var reminders = reminderRows();
    var alarms = [];
    for (var ri = 0; ri < reminders.length; ri++) {
      var valueInput = reminders[ri].querySelector('.reminder-value');
      /* Validate the raw spelling, not valueAsNumber: '1e2' parses to 100 but
       * is not a whole-number literal the form should accept. */
      var rawValue = String(valueInput.value).trim();
      var n = Number(rawValue);
      if (!/^[0-9]{1,3}$/.test(rawValue) || !Number.isInteger(n) || n < 1 || n > 999) {
        errors[valueInput.id] = 'Reminder ' + (ri + 1) + ': pick a whole number from 1 to 999.';
      } else {
        alarms.push({ trigger: triggerFromParts({ value: n, unit: reminders[ri].querySelector('.reminder-unit').value }) });
      }
    }
    if (alarms.length) opts.alarms = alarms;

    var orgName = $('organizer-name').value.trim();
    var orgEmail = $('organizer-email').value.trim();
    if (orgEmail || orgName) {
      if (!orgEmail) {
        errors['organizer-email'] = 'Add an email address for the organizer (or clear the name).';
      } else {
        opts.organizer = { email: orgEmail };
        if (orgName) opts.organizer.name = orgName;
      }
    }
    var attendees = readAttendees(errors);
    if (attendees.length) opts.attendees = attendees;

    if (Object.keys(errors).length) return { errors: errors };
    return { opts: opts };
  }

  function readAttendees(errors) {
    var rows = document.querySelectorAll('#attendee-list .attendee-row');
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var emailInput = row.querySelector('.att-email');
      var name = row.querySelector('.att-name').value.trim();
      var email = emailInput.value.trim();
      var role = row.querySelector('.att-role').value;
      var status = row.querySelector('.att-status').value;
      var rsvp = row.querySelector('.att-rsvp-input').checked;
      if (!name && !email && !rsvp) continue; /* untouched row */
      if (!email) {
        if (emailInput.id) errors[emailInput.id] = 'Attendee ' + (i + 1) + ' needs an email address.';
        continue;
      }
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

  /* Membership is checked against the full zone list, never the filtered view. */
  function hasZone(tz) {
    if (!tz) return false;
    if (tz === 'UTC' || tz === localTimeZone()) return true;
    return allTimeZones().indexOf(tz) !== -1;
  }

  /* The zone to show an imported instant in: the event's own zone when the
   * picker knows it, otherwise the device zone. */
  function zoneForForm(tz) {
    if (tz && hasZone(tz)) return tz;
    return localTimeZone();
  }

  /* The exact UNTIL token the form writes: date-only for all-day events,
   * otherwise the end of the chosen calendar day in the event's zone. */
  function untilFromDate(value, allDay, tz) {
    var p = parseDateInput(value);
    if (allDay) return IcsGenerator.formatDateUTC(p);
    return IcsGenerator.formatDateTimeUTC(
      zonedTimeToDate(p.year, p.month, p.day, 23, 59, tz || 'UTC', 59)
    );
  }

  /* Only the form's simple subset is representable: FREQ, INTERVAL, a weekly
   * BYDAY, and an end that is either UNTIL or COUNT (never both). Anything else
   * (BYDAY on a non-weekly rule, ordinal BYDAY, …) is preserved on the event but
   * not loaded. */
  function simpleRule(rule, allDay, tz) {
    var out = { freq: null, interval: 1, until: '', count: null, byday: null };
    var seenUntil = false;
    var seenCount = false;
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
      } else if (k === 'BYDAY') {
        var days = parseByday(v);
        if (!days) return null;
        out.byday = days;
      } else if (k === 'UNTIL') {
        var u = untilToDate(v, allDay, tz);
        if (!u || untilFromDate(u, allDay, tz) !== v) return null;
        out.until = u;
        seenUntil = true;
      } else if (k === 'COUNT') {
        if (!/^\d+$/.test(v)) return null;
        var n = parseInt(v, 10);
        /* Only counts the form can re-emit (readForm validates 1..999) count
         * as representable; anything else is preserved via the kept-RRULE path. */
        if (!(n >= 1 && n <= 999)) return null;
        out.count = n;
        seenCount = true;
      } else {
        return null;
      }
    }
    if (!out.freq) return null;
    /* UNTIL and COUNT are mutually exclusive in RFC 5545. */
    if (seenUntil && seenCount) return null;
    /* BYDAY only means anything on a weekly rule in this simple form. */
    if (out.byday && out.freq !== 'WEEKLY') return null;
    return out;
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

  /* The exact trigger string the reminder form writes for { value, unit }:
   * '-P2D', '-PT3H', '-PT10M' (see the alarm branch in readForm). */
  function triggerFromParts(parts) {
    if (parts.unit === 'days') return '-P' + parts.value + 'D';
    if (parts.unit === 'hours') return '-PT' + parts.value + 'H';
    return '-PT' + parts.value + 'M';
  }

  /* True only when `trigger` is exactly what the form would write back for
   * `parts`, so a no-change Update reproduces it byte-for-byte. Compound
   * durations (-PT1H30M, -P1DT12H), leading zeros and absolute/non-trigger
   * strings all fail. Numeric minute triggers (-10) equal the '-PT10M' the
   * form writes, so they count as representable when integral. */
  function triggerRoundTrips(trigger, parts) {
    if (!parts || !Number.isInteger(parts.value) || parts.value < 1 || parts.value > 999) return false;
    if (typeof trigger === 'number') return Number.isInteger(trigger) && trigger < 0;
    return String(trigger == null ? '' : trigger) === triggerFromParts(parts);
  }

  /* Up to five DISPLAY alarms without descriptions, returned as row parts.
   * Every trigger must round-trip exactly; otherwise the entire array is kept
   * as-is rather than loading a partial, potentially destructive edit. */
  function simpleAlarm(alarms) {
    if (!Array.isArray(alarms) || alarms.length > 5) return null;
    var rows = [];
    for (var i = 0; i < alarms.length; i++) {
      var a = alarms[i];
      if (!a) return null;
      var action = a.action ? String(a.action).toUpperCase() : 'DISPLAY';
      if (action !== 'DISPLAY' || a.description != null) return null;
      var parts = parseTrigger(a.trigger);
      if (!triggerRoundTrips(a.trigger, parts)) return null;
      rows.push(parts);
    }
    return rows;
  }

  var reminderRowSeq = 0;

  function addReminderRow(parts) {
    if (reminderRows().length >= 5) return null;
    parts = parts || { value: 10, unit: 'minutes' };
    var row = document.createElement('div');
    row.className = 'reminder-row';
    var valueField = attendeeField('number', 'reminder-value', '', 'Reminder value', parts.value, 'reminder-value-' + (++reminderRowSeq));
    var input = valueField.querySelector('input');
    input.min = '1';
    input.max = '999';
    input.step = '1';
    row.appendChild(valueField);
    row.appendChild(attendeeSelect('reminder-unit', 'Reminder unit', [
      ['minutes', 'Minutes'], ['hours', 'Hours'], ['days', 'Days']
    ], parts.unit, 'minutes'));
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn ghost reminder-remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', function () {
      row.parentNode.removeChild(row);
      syncReminderUI();
      updateKeptHint();
      $('add-reminder-btn').focus();
    });
    row.appendChild(remove);
    $('reminder-rows').appendChild(row);
    syncReminderUI();
    return row;
  }

  function setReminders(rows) {
    $('reminder-rows').textContent = '';
    (rows || []).forEach(addReminderRow);
    syncReminderUI();
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

  var attendeeRowSeq = 0;

  function attendeeField(type, cls, placeholder, aria, value, id) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var input = document.createElement('input');
    input.type = type;
    input.className = cls;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', aria);
    input.autocomplete = 'off';
    input.value = value;
    if (id) input.id = id;
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

    var rowSeq = ++attendeeRowSeq;
    row.appendChild(attendeeField('text', 'att-name', 'Name', 'Attendee name', a.name || ''));
    row.appendChild(attendeeField('email', 'att-email', 'Email', 'Attendee email', a.email || '', 'att-email-' + rowSeq));
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
    remove.addEventListener('click', function () {
      box.removeChild(row);
      /* Focus lands on the removed row's button otherwise; keep it on a
       * stable control so keyboard visitors are not stranded. */
      $('add-attendee-btn').focus();
    });
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
    clearAllFieldErrors();
    $('title').value = ev.title || '';
    $('description').value = ev.description || '';
    $('location').value = ev.location || '';
    $('url').value = ev.url || '';
    $('categories').value = (ev.categories || []).join(', ');
    $('status').value = /^(CONFIRMED|TENTATIVE|CANCELLED)$/.test(ev.status || '') ? ev.status : 'CONFIRMED';
    $('transp').value = ev.transp === 'TRANSPARENT' ? 'TRANSPARENT' : 'OPAQUE';
    $('priority').value = ev.priority >= 1 && ev.priority <= 9 ? String(ev.priority) : '0';

    var allDay = !!ev.allDay;
    $('all-day').checked = allDay;

    if (allDay) {
      setDateInput(startDateEl, ev.start);
      if (ev.end) {
        setDateInput(endDateEl, ev.end);
      } else if (isDateParts(ev.start)) {
        /* No explicit end: mirror computeEnd's exclusive start+1day default so
         * a no-change update reproduces the same DTEND instead of keeping a
         * stale end date that happened to be in the input. */
        endDateEl.value = addDays(isoFromParts(ev.start), 1);
      }
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
      setTimeZoneValue(zone);
    }
    syncAllDayUI();
    rememberStartInstant();

    var rule = ev.rrule ? simpleRule(ev.rrule, allDay, timezoneEl.value) : null;
    $('recur-freq').value = rule ? rule.freq : 'NONE';
    $('recur-interval').value = rule ? rule.interval : 1;
    $('recur-count').value = rule && rule.count != null ? rule.count : 1;
    $('recur-until').value = rule ? rule.until : '';
    $('recur-end').value = !rule ? 'never'
      : (rule.count != null ? 'after' : (rule.until ? 'on-date' : 'never'));
    /* An implicit start weekday stays implicit; only a fresh WEEKLY change
     * defaults a checkbox, never loading or restoring the form. */
    setByday(rule && rule.byday);
    syncRecurUI();

    setReminders(simpleAlarm(ev.alarms));

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
          /* DTEND on an all-day event is exclusive — name the last covered
           * day, not the day after the event ends. */
          var lastCovered = new Date(ep.getTime() - 86400000);
          bits.push('through ' + lastCovered.toLocaleDateString(undefined, {
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
    if (o.transp === 'TRANSPARENT') bits.push('Free');
    if (o.priority >= 1) bits.push('priority ' + o.priority);
    if (o.location) bits.push(o.location);
    if (o.organizer && o.organizer.email) bits.push('by ' + (o.organizer.name || o.organizer.email));
    if (Array.isArray(o.attendees) && o.attendees.length) {
      bits.push(o.attendees.length + (o.attendees.length === 1 ? ' attendee' : ' attendees'));
    }
    return bits.join(' · ');
  }

  /* ---------- Google Calendar link ---------- */

  function gcalTimestamp(date) {
    return date.getUTCFullYear() + pad2(date.getUTCMonth() + 1) + pad2(date.getUTCDate()) +
      'T' + pad2(date.getUTCHours()) + pad2(date.getUTCMinutes()) + pad2(date.getUTCSeconds()) + 'Z';
  }

  function gcalDate(parts) {
    return parts.year + pad2(parts.month) + pad2(parts.day);
  }

  function datePartsOf(v) {
    if (isDateParts(v)) return { year: v.year, month: v.month, day: v.day };
    if (v instanceof Date) {
      return { year: v.getUTCFullYear(), month: v.getUTCMonth() + 1, day: v.getUTCDate() };
    }
    return null;
  }

  function nextDateParts(parts) {
    var d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  /* Build the Google Calendar "add event" template URL for one list item.
   * Google wants UTC instants for timed events (with ctz naming the display
   * zone) and an exclusive end date for all-day events. Every value is
   * percent-encoded, and the caller only ever sets href/textContent. */
  function googleCalendarUrl(ev) {
    var o = ev.options;
    var params = [['action', 'TEMPLATE'], ['text', String(o.title || '')]];

    var dates;
    if (ev.allDay) {
      var startParts = datePartsOf(ev.start);
      var endParts = datePartsOf(ev.end) || (startParts ? nextDateParts(startParts) : null);
      dates = (startParts ? gcalDate(startParts) : '') + '/' + (endParts ? gcalDate(endParts) : '');
    } else {
      var start = ev.start;
      var end = ev.end instanceof Date ? ev.end : null;
      if (!end) {
        var minutes = Number(o.durationMinutes) > 0 ? Number(o.durationMinutes) : 0;
        end = new Date(start.getTime() + minutes * 60000);
      }
      dates = gcalTimestamp(start) + '/' + gcalTimestamp(end);
    }
    params.push(['dates', dates]);

    var details = '';
    if (o.description && o.url) details = o.description + '\n' + o.url;
    else if (o.description) details = o.description;
    else if (o.url) details = o.url;
    if (details) params.push(['details', details]);

    if (o.location) params.push(['location', String(o.location)]);
    if (o.timezone && o.timezone !== 'UTC') params.push(['ctz', String(o.timezone)]);
    if (o.rrule) params.push(['recur', 'RRULE:' + String(o.rrule).replace(/^RRULE:/i, '')]);

    return 'https://calendar.google.com/calendar/render?' + params.map(function (p) {
      return p[0] + '=' + encodeURIComponent(p[1]);
    }).join('&');
  }

  /* Sort key for the list view: an all-day event sorts by its calendar day
   * (UTC midnight), a timed event by its instant. */
  function eventSortTime(ev) {
    if (isDateParts(ev.start)) return Date.UTC(ev.start.year, ev.start.month - 1, ev.start.day);
    return ev.start.getTime();
  }

  /* The list is shown in start order, but every action must still target the
   * event's real index in cal.events (and the preview keeps insertion order),
   * so the sorted view carries the original index alongside each event. */
  function sortedEventEntries() {
    return cal.events
      .map(function (ev, index) { return { realIndex: index, ev: ev }; })
      .sort(function (a, b) {
        var byStart = eventSortTime(a.ev) - eventSortTime(b.ev);
        if (byStart) return byStart;
        var byTitle = String(a.ev.options.title).localeCompare(String(b.ev.options.title));
        if (byTitle) return byTitle;
        return a.realIndex - b.realIndex;
      });
  }

  function render() {
    var list = $('event-list');
    list.textContent = '';

    if (!cal.events.length) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No events yet — add your first event with the form, or load the samples.';
      list.appendChild(li);
    } else {
      sortedEventEntries().forEach(function (entry) {
        var ev = entry.ev;
        var i = entry.realIndex;
        var li = document.createElement('li');
        li.setAttribute('data-index', i);

        var info = document.createElement('div');
        info.className = 'event-info';
        var strong = document.createElement('strong');
        strong.textContent = ev.options.title;
        strong.tabIndex = -1; /* programmatic focus target after an update */
        var small = document.createElement('small');
        small.textContent = describeEvent(ev);
        info.appendChild(strong);
        info.appendChild(small);

        var edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn ghost';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', 'Edit ' + ev.options.title);
        edit.disabled = ev === editingEvent;
        edit.addEventListener('click', function () { startEditing(i); });

        var dup = document.createElement('button');
        dup.type = 'button';
        dup.className = 'btn ghost';
        dup.textContent = 'Duplicate';
        dup.setAttribute('aria-label', 'Duplicate ' + ev.options.title);
        dup.addEventListener('click', function () {
          if (cal.events.length >= MAX_EVENTS) {
            setStatus('The list is full (' + MAX_EVENTS + ' events). Remove one first.', true);
            return;
          }
          /* This mutation supersedes any pending undo: drop it without
           * restoring so a later Undo cannot wipe the duplicate. */
          cal.addEvent(cloneEventOptions(ev.options));
          unlockStorage();
          dismissUndoToast();
          render();
          setStatus('Duplicated "' + ev.options.title + '".');
        });

        var gcal = document.createElement('a');
        gcal.className = 'btn ghost gcal-link';
        gcal.href = googleCalendarUrl(ev);
        gcal.target = '_blank';
        gcal.rel = 'noopener noreferrer';
        gcal.textContent = 'Google Calendar';
        gcal.title = 'Open in Google Calendar';
        gcal.setAttribute('aria-label', 'Open ' + ev.options.title + ' in Google Calendar');

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn ghost';
        del.textContent = 'Remove';
        del.addEventListener('click', function () {
          var removed = cal.events[i];
          var removedIndex = i;
          cal.removeEvent(removedIndex);
          unlockStorage();
          render();
          showUndoToast('Removed "' + removed.options.title + '".', function () {
            /* Reinsertion grows the list, so respect the same cap every other
             * growth point uses; refuse rather than lose an event on reload. */
            if (cal.events.length >= MAX_EVENTS) {
              setStatus('The list is full — the removal could not be undone.', true);
              return false;
            }
            cal.events.splice(removedIndex, 0, removed);
          }, del);
        });

        li.appendChild(info);
        li.appendChild(edit);
        li.appendChild(dup);
        li.appendChild(gcal);
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

    saveEvents();
  }

  /* ---------- edit mode ---------- */
  /* Deep-enough copy of an event's options for duplication: a fresh title with
   * a "(copy)" suffix, no uid, fresh categories/attendees/alarms arrays (with
   * copied object elements), and rebuilt Date / { year, month, day } values so
   * editing the copy can never mutate the original. */
  /* Never let stored JSON rewire an object's prototype. */
  function copyPlain(o) {
    var out = {};
    Object.keys(o).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor') return;
      out[k] = o[k];
    });
    return out;
  }

  function copyDateValue(v) {
    if (isDateParts(v)) return { year: v.year, month: v.month, day: v.day };
    if (v instanceof Date) return new Date(v.getTime());
    return v;
  }

  function cloneEventOptions(o) {
    var clone = copyPlain(o);
    delete clone.uid;
    clone.title = (o.title || '') + ' (copy)';
    if (o.start != null) clone.start = copyDateValue(o.start);
    if (o.end != null) clone.end = copyDateValue(o.end);
    if (Array.isArray(o.categories)) clone.categories = o.categories.slice();
    if (Array.isArray(o.attendees)) clone.attendees = o.attendees.map(copyPlain);
    if (Array.isArray(o.alarms)) clone.alarms = o.alarms.map(copyPlain);
    if (o.organizer) clone.organizer = copyPlain(o.organizer);
    return clone;
  }

  /* The VEvent currently being edited, or null when the form adds a new event.
   * Tracking the reference (not an index) keeps the update pointed at the same
   * event even if the list is reordered or an item is removed while the form is
   * open. `editingKept` remembers the parts of the original the simple form
   * cannot represent so a no-change update does not destroy them. */
  var editingEvent = null;
  var editingKept = { rrule: null, alarms: null };

  /* The parts of `ev` the form cannot represent and must therefore be carried
   * through an update when the visitor leaves that control untouched. */
  function keptFromEvent(ev) {
    var o = ev.options;
    var kept = { rrule: null, alarms: null };
    if (o.rrule && !simpleRule(o.rrule, ev.allDay, timezoneEl.value)) {
      kept.rrule = o.rrule;
    }
    if (Array.isArray(o.alarms) && o.alarms.length && !simpleAlarm(o.alarms)) {
      kept.alarms = o.alarms.map(copyPlain);
    }
    return kept;
  }

  /* The parts of the original the simple form will keep as-is given what its
   * controls currently show (mirrors the carry-through logic in submit). */
  function keptParts() {
    var parts = [];
    if (editingEvent && editingKept.rrule && $('recur-freq').value === 'NONE') {
      parts.push('advanced recurrence');
    }
    if (editingEvent && editingKept.alarms && reminderRows().length === 0) {
      parts.push('extra reminders');
    }
    return parts;
  }

  function updateKeptHint() {
    var el = $('edit-kept-hint');
    var parts = keptParts();
    if (!parts.length) { el.hidden = true; return; }
    el.textContent = "Parts of this event (" + parts.join(' and ') +
      ") can't be edited in this simple form and will be kept as-is.";
    el.hidden = false;
  }

  function startEditing(index) {
    var ev = cal.events[index];
    if (!ev) return;
    editingEvent = ev;
    populateForm(ev.options);
    editingKept = keptFromEvent(ev);
    updateKeptHint();
    $('form-heading').textContent = 'Edit event';
    $('add-btn').textContent = 'Update event';
    $('cancel-edit-btn').hidden = false;
    render(); /* reflect the disabled Edit button on this item */
    $('title').focus();
  }

  function exitEditMode() {
    editingEvent = null;
    editingKept = { rrule: null, alarms: null };
    updateKeptHint();
    $('form-heading').textContent = 'New event';
    $('add-btn').textContent = 'Add event';
    $('cancel-edit-btn').hidden = true;
  }

  /* Face the event the visitor just changed: focus its title in the list, or
   * the status message when the item cannot be found. */
  function focusEventTitle(index) {
    var li = $('event-list').querySelector('li[data-index="' + index + '"]');
    var strong = li && li.querySelector('strong');
    if (strong) { strong.focus(); return; }
    $('status-msg').focus();
  }

  $('cancel-edit-btn').addEventListener('click', function () {
    exitEditMode(); /* the form keeps its content */
    render(); /* re-enable the Edit button on the item we were editing */
    $('title').focus();
  });

  /* ---------- undo toast ---------- */
  /* One level of undo for destructive list actions. Showing a new toast
   * replaces any previous snapshot, so there is no stack: only the most recent
   * action can be undone. */
  var UNDO_TIMEOUT_MS = 8000;
  var undoTimer = null;
  var undoAction = null;
  var undoTrigger = null;
  var undoHover = false;

  /* Drop the pending undo without restoring and without any focus side-effect.
   * Used when a later list mutation takes ownership of the list: the undo
   * belongs to the last action only, so it must not be able to fire against a
   * list that has changed since. */
  function dismissUndoToast() {
    pauseUndoTimer();
    undoAction = null;
    undoTrigger = null;
    undoHover = false;
    $('undo-toast').hidden = true;
  }

  function pauseUndoTimer() {
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  }

  /* The timer must not run down while the visitor is reading or tabbing through
   * the toast (WCAG 2.2.1): pause on pointer hover and keyboard focus. */
  function undoTimerPaused() {
    var toast = $('undo-toast');
    if (toast.hidden) return true;
    return undoHover || toast.contains(document.activeElement);
  }

  function resumeUndoTimer() {
    if (undoTimer || undoTimerPaused()) return;
    undoTimer = setTimeout(function () { hideUndoToast(); }, UNDO_TIMEOUT_MS);
  }

  /* Refocus after the toast goes away only when focus was inside it, and prefer
   * the button that triggered the action (if it still exists). */
  function refocusAfterUndo(trigger) {
    if (trigger && trigger.isConnected) { trigger.focus(); return; }
    var title = $('title');
    if (title) title.focus();
  }

  function hideUndoToast() {
    var toast = $('undo-toast');
    var focusInside = toast.contains(document.activeElement);
    var trigger = undoTrigger;
    dismissUndoToast();
    if (focusInside) refocusAfterUndo(trigger);
  }

  function showUndoToast(message, undoFn, trigger) {
    undoAction = { message: message, undo: undoFn };
    undoTrigger = trigger || null;
    var toast = $('undo-toast');
    /* Paint the live region before revealing it so the announcement is reliable. */
    $('undo-msg').textContent = message;
    toast.hidden = false;
    /* Deliberately no focus() on #undo-btn: the role="status" region announces
     * the change, and stealing focus would trap keyboard users on repeated
     * actions. The button stays reachable in normal tab order. */
    pauseUndoTimer();
    resumeUndoTimer();
  }

  (function wireUndoTimerPause() {
    var toast = $('undo-toast');
    toast.addEventListener('pointerenter', function () { undoHover = true; pauseUndoTimer(); });
    toast.addEventListener('pointerleave', function () { undoHover = false; resumeUndoTimer(); });
    toast.addEventListener('focusin', pauseUndoTimer);
    toast.addEventListener('focusout', function (e) {
      if (e.relatedTarget && toast.contains(e.relatedTarget)) return;
      resumeUndoTimer();
    });
  })();

  function runUndo() {
    var action = undoAction;
    if (!action) return;
    var trigger = undoTrigger;
    var focusInside = $('undo-toast').contains(document.activeElement);
    dismissUndoToast();
    var result;
    try {
      result = action.undo();
    } catch (e) {
      setStatus('Could not undo that action.', true);
      return;
    }
    /* A refused undo (e.g. the cap would be exceeded) reports its own status. */
    if (result === false) return;
    unlockStorage();
    render(); /* also persists the restored list */
    setStatus('Undone.');
    if (focusInside) refocusAfterUndo(trigger);
  }

  $('undo-btn').addEventListener('click', runUndo);

  document.addEventListener('keydown', function (e) {
    if ($('undo-toast').hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hideUndoToast();
      return;
    }
    /* Ctrl/Cmd+Z is a shortcut only outside form controls (and not the
     * shifted redo), where the browser's own undo must keep working. */
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      runUndo();
    }
  });

  /* Snapshot every control in the event form (plus attendee/reminder rows) so loading
   * samples can be undone back to the visitor's work. */
  function snapshotForm() {
    var values = [];
    var fields = $('event-form').querySelectorAll('input, select, textarea');
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      if (!el.id || el.id === 'timezone-filter' || (el.closest && el.closest('#attendee-list, #reminder-rows'))) continue;
      values.push({
        id: el.id,
        checked: el.type === 'checkbox' ? el.checked : null,
        value: el.type === 'checkbox' ? null : el.value
      });
    }
    var attendees = [];
    var rows = document.querySelectorAll('#attendee-list .attendee-row');
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      attendees.push({
        name: row.querySelector('.att-name').value,
        email: row.querySelector('.att-email').value,
        role: row.querySelector('.att-role').value,
        status: row.querySelector('.att-status').value,
        rsvp: row.querySelector('.att-rsvp-input').checked
      });
    }
    return {
      values: values,
      attendees: attendees,
      reminders: Array.prototype.map.call(reminderRows(), function (row) {
        return { value: row.querySelector('.reminder-value').value, unit: row.querySelector('.reminder-unit').value };
      }),
      /* Edit context travels with the draft so a samples undo can put the
       * visitor back into the same Update session, not a silent Add. */
      editingEvent: editingEvent,
      editingKept: {
        rrule: editingKept.rrule,
        alarms: editingKept.alarms ? editingKept.alarms.map(copyPlain) : null
      }
    };
  }

  function restoreForm(snap) {
    if (!snap) return;
    clearAllFieldErrors();
    var box = $('attendee-list');
    box.textContent = '';
    snap.attendees.forEach(addAttendeeRow);
    setReminders(snap.reminders);
    snap.values.forEach(function (rec) {
      var el = $(rec.id);
      if (!el) return;
      if (rec.checked !== null) el.checked = rec.checked;
      else el.value = rec.value;
    });
    /* The filter is view state, not event data: rebuild from whatever filter is
     * showing and re-apply the snapshot's zone so a filtered list can't drop it. */
    renderTimeZones();
    var snapZone = null;
    snap.values.forEach(function (rec) { if (rec.id === 'timezone') snapZone = rec.value; });
    if (snapZone) setTimeZoneValue(snapZone);
    /* Visibility only: the snapshot's date values must survive byte-for-byte. */
    syncAllDayVisibility();
    syncRecurUI();
    syncReminderUI();
    updateKeptHint();
    rememberStartInstant();
  }

  /* Re-enter the edit session a snapshot captured. Targets the same event by
   * reference; if it is gone (removed while the toast was pending) the form is
   * left cleanly in Add mode instead of updating the wrong event. */
  function restoreEditState(snap) {
    var ev = snap && snap.editingEvent;
    if (!ev || cal.events.indexOf(ev) === -1) { exitEditMode(); return; }
    editingEvent = ev;
    editingKept = snap.editingKept || { rrule: null, alarms: null };
    $('form-heading').textContent = 'Edit event';
    $('add-btn').textContent = 'Update event';
    $('cancel-edit-btn').hidden = false;
    updateKeptHint();
  }

  /* ---------- actions ---------- */

  $('event-form').addEventListener('submit', function (e) {
    e.preventDefault();
    try {
      var result = readForm();
      if (result.errors) { showFormErrors(result.errors); return; }
      var opts = result.opts;
      clearAllFieldErrors();

      if (editingEvent !== null) {
        var index = cal.events.indexOf(editingEvent);
        var updated;
        if (index === -1) {
          /* The edited event was removed while the form was open — keep the
           * visitor's work by adding it as a new event instead. */
          if (cal.events.length >= MAX_EVENTS) {
            setStatus('The list is full (' + MAX_EVENTS + ' events). Remove one first.', true);
            return;
          }
          updated = cal.addEvent(opts);
          unlockStorage();
          dismissUndoToast();
          exitEditMode();
          render();
          setStatus('The event being edited was removed — added as a new event instead.');
        } else {
          /* Carry through the parts the simple form cannot represent unless the
           * visitor actively chose a new value for that control. */
          if (opts.rrule == null && editingKept.rrule && $('recur-freq').value === 'NONE') {
            opts.rrule = editingKept.rrule;
          }
          if (opts.alarms == null && editingKept.alarms && reminderRows().length === 0) {
            opts.alarms = editingKept.alarms.map(copyPlain);
          }
          updated = cal.updateEvent(index, opts);
          unlockStorage();
          dismissUndoToast();
          exitEditMode();
          render();
          setStatus('Updated "' + updated.options.title + '".');
        }
        focusEventTitle(cal.events.indexOf(updated));
        return;
      }

      if (cal.events.length >= MAX_EVENTS) {
        setStatus('The list is full (' + MAX_EVENTS + ' events). Remove one first.', true);
        return;
      }

      var ev = cal.addEvent(opts);
      unlockStorage();
      dismissUndoToast();
      /* quick-entry flow: roll the form forward to the next slot */
      if (!$('all-day').checked && endDateEl.value && endTimeEl.value) {
        startDateEl.value = endDateEl.value;
        startTimeEl.value = endTimeEl.value;
        var next = new Date(endDateEl.value + 'T' + endTimeEl.value);
        next.setMinutes(next.getMinutes() + 60);
        endDateEl.value = toISODate(next);
        endTimeEl.value = toISOTime(next);
      }
      rememberStartInstant();
      render();
      setStatus('Added "' + ev.options.title + '" to the calendar.');
    } catch (err) {
      /* A genuine library rejection is not a user-input problem we could have
       * predicted; map it onto the responsible field when identifiable. */
      if (!showFieldErrorFromLib(err)) setStatus(err.message, true);
    }
  });

  /* Calendar.toString reads options.name each time; no library setter needed.
   * These toolbar inputs are deliberately outside the event form snapshots.
   * The name is trimmed so a whitespace-only value emits no X-WR-CALNAME. */
  function syncCalendarName() {
    cal.options.name = $('calendar-name').value.trim();
  }

  /* Every keystroke would rebuild the list, preview and (when unlocked) the
   * save, so the input handler is debounced; change/blur flushes immediately. */
  var calendarNameTimer = null;
  function commitCalendarName() {
    syncCalendarName();
    render();
  }
  $('calendar-name').addEventListener('input', function () {
    if (calendarNameTimer) clearTimeout(calendarNameTimer);
    calendarNameTimer = setTimeout(function () {
      calendarNameTimer = null;
      commitCalendarName();
    }, 300);
  });
  $('calendar-name').addEventListener('change', function () {
    if (calendarNameTimer) { clearTimeout(calendarNameTimer); calendarNameTimer = null; }
    commitCalendarName();
  });
  $('download-filename').addEventListener('input', saveEvents);
  $('download-filename').addEventListener('change', saveEvents);

  $('download-btn').addEventListener('click', function () {
    /* Strip a typed .ics suffix before slugifying so 'invite.ics' does not
     * become 'invite-ics.ics'. */
    var raw = $('download-filename').value.trim();
    var filename = raw ? raw.replace(/\.ics$/i, '') : cal.events[0].options.title;
    IcsGenerator.download(slugify(filename) + '.ics', cal.toString());
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
    if (!cal.events.length) {
      cal.clear();
      unlockStorage();
      render();
      setStatus('Cleared.');
      return;
    }
    var snapshot = cal.events.slice();
    cal.clear();
    unlockStorage();
    render();
    setStatus('Cleared.');
    showUndoToast(
      snapshot.length === 1 ? 'Cleared 1 event.' : 'Cleared ' + snapshot.length + ' events.',
      function () { cal.events = snapshot; },
      $('clear-btn')
    );
  });

  $('sample-btn').addEventListener('click', function () {
    var previousEvents = cal.events.slice();
    var previousForm = snapshotForm();
    /* Loading samples replaces the form, so leave edit mode now: keeping a
     * stale Update target would silently turn a later Update into an Add.
     * The snapshot above already carries the edit context for Undo. */
    exitEditMode();

    cal.clear();
    unlockStorage();

    /* 1. recurring standup — remind 10 min before (number trigger) */
    cal.addEvent({
      title: 'Team standup',
      description: 'Mon/Wed/Fri sync — what I did, what I am doing, blockers.',
      location: 'Zoom',
      start: nextWeekday(1, 9, 0),
      durationMinutes: 30,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
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
    showUndoToast('Loaded 3 sample events.', function () {
      cal.events = previousEvents;
      restoreForm(previousForm);
      restoreEditState(previousForm);
    }, $('sample-btn'));
  });

  /* ---------- importing .ics ---------- */

  var MAX_IMPORT_CHARS = 2 * 1024 * 1024;

  function setImportStatus(msg, isError) {
    var el = $('import-status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  /* Import notes: parser warnings are informational, not failures, so they live
   * in their own collapsed box under the status line. The box is rebuilt on
   * every import attempt and hidden when there is nothing to report. */
  function renderImportNotes(warnings) {
    var host = $('import-notes');
    host.textContent = '';
    if (!warnings || !warnings.length) { host.hidden = true; return; }

    var details = document.createElement('details');
    details.className = 'import-notes';
    var summary = document.createElement('summary');
    summary.textContent = warnings.length + ' import note' + (warnings.length === 1 ? '' : 's');
    details.appendChild(summary);

    var ul = document.createElement('ul');
    warnings.slice(0, 20).forEach(function (warning) {
      var li = document.createElement('li');
      li.textContent = String(warning);
      ul.appendChild(li);
    });
    if (warnings.length > 20) {
      var more = document.createElement('li');
      more.textContent = '+' + (warnings.length - 20) + ' more';
      ul.appendChild(more);
    }
    details.appendChild(ul);
    host.appendChild(details);
    host.hidden = false;
  }

  function looksLikeEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }
  function looksLikeHttpUrl(s) { return /^https?:\/\//i.test(String(s || '')); }

  /* Parsed event → addEvent options. A field ics.js would reject (a non-http
   * link, a malformed address) is dropped rather than losing the whole event.
   * Unknown properties are ignored silently — listing every X- header an
   * Outlook invite carries is noise, not help. */
  function importOptions(ev) {
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
    if (ev.url && looksLikeHttpUrl(ev.url)) o.url = ev.url;
    if (/^(CONFIRMED|TENTATIVE|CANCELLED)$/.test(ev.status || '')) o.status = ev.status;
    if (ev.transp === 'OPAQUE' || ev.transp === 'TRANSPARENT') o.transp = ev.transp;
    if (ev.priority >= 1 && ev.priority <= 9) o.priority = ev.priority;
    if (ev.categories && ev.categories.length) o.categories = ev.categories;
    if (ev.rrule) o.rrule = ev.rrule;
    if (ev.alarms && ev.alarms.length) o.alarms = ev.alarms;
    if (ev.organizer && ev.organizer.email && looksLikeEmail(ev.organizer.email)) {
      o.organizer = { email: ev.organizer.email };
      if (ev.organizer.name) o.organizer.name = ev.organizer.name;
    }
    if (ev.attendees && ev.attendees.length) {
      var keep = ev.attendees
        .filter(function (a) { return looksLikeEmail(a.email); })
        .map(function (a) {
          var out = { email: a.email };
          if (a.name) out.name = a.name;
          if (a.role) out.role = a.role;
          if (a.status) out.status = a.status;
          if (a.rsvp) out.rsvp = true;
          return out;
        });
      if (keep.length) o.attendees = keep;
    }
    return o;
  }

  function applyImport(text, sourceLabel) {
    /* Every attempt replaces the previous notes, even one that fails early. */
    renderImportNotes([]);
    if (!text || !text.trim()) { setImportStatus('Nothing to import — the text was empty.', true); return; }
    if (text.length > MAX_IMPORT_CHARS) { setImportStatus('That text is too large to import (over 2 MB).', true); return; }

    var result;
    try {
      result = IcsGenerator.parse(text);
    } catch (err) {
      setImportStatus(err.message, true);
      return;
    }
    renderImportNotes(result.warnings);
    if (!result.events.length) {
      setImportStatus('No events found in ' + (sourceLabel || 'that text') + '.', true);
      return;
    }

    /* An imported calendar name fills the input only while it still shows the
     * built-in default; blank or whitespace names are intentional and stay
     * untouched, so a customized name is never overwritten either. */
    var importedName = result.calendar && typeof result.calendar.name === 'string'
      ? result.calendar.name.trim() : '';
    if (importedName) {
      var currentName = $('calendar-name').value.trim();
      if (currentName === 'My Events') {
        $('calendar-name').value = importedName.slice(0, 60);
        syncCalendarName();
      }
    }

    var added = 0;
    var hitCap = false;
    /* Replace mode clears the list only once at least one imported event is
     * about to land: a failed replace must leave the existing list intact, and
     * the snapshot is the undo path back to both the list and the form. */
    var replaceMode = $('import-mode-replace').checked;
    var previousEvents = replaceMode ? cal.events.slice() : null;
    var previousForm = replaceMode ? snapshotForm() : null;
    if (replaceMode) cal.clear();
    result.events.forEach(function (ev) {
      if (cal.events.length >= MAX_EVENTS) { hitCap = true; return; }
      /* Skip an event only if ics.js rejects it outright; the count below
       * already tells the visitor when fewer events landed than were found. */
      try {
        cal.addEvent(importOptions(ev));
        added++;
      } catch (err) { /* ignore and continue */ }
    });

    if (replaceMode && added === 0) {
      /* A replace that imported nothing is a failure: put the previous list
       * and form back before the failure status below explains it. */
      cal.events = previousEvents;
      restoreForm(previousForm);
      restoreEditState(previousForm);
      render();
    }

    if (added) {
      /* Importing mutated the list, so it supersedes any pending undo. In
       * replace mode the toast below becomes the undo, so leave it in place. */
      unlockStorage();
      if (!replaceMode) dismissUndoToast();
      render();
      /* Collapse the panel so the (now populated) form is pulled into view. */
      $('import-box').open = false;
      if (result.events.length === 1) {
        /* A single-event import takes over the form, so leave edit mode first:
         * otherwise a later Update would overwrite the previously edited event
         * with the imported data. render() re-enables its Edit button. */
        exitEditMode();
        render();
        populateForm(result.events[0]);
        $('title').focus();
      }
      if (replaceMode) {
        showUndoToast('Replaced ' + previousEvents.length + ' event(s) with ' + added + ' imported.', function () {
          cal.events = previousEvents;
          restoreForm(previousForm);
          restoreEditState(previousForm);
        }, $('import-text-btn'));
      }
    }

    var msg = 'Imported ' + added + ' of ' + result.events.length +
      ' event' + (result.events.length === 1 ? '' : 's');
    if (replaceMode) msg += ' (replaced ' + previousEvents.length + ')';
    if (sourceLabel) msg += ' from ' + sourceLabel;
    setImportStatus(msg + '.', added === 0);
    if (hitCap) setStatus('The list is full (' + MAX_EVENTS + ' events). Remove one first.', true);
    else if (added) setStatus('Imported ' + added + ' event' + (added === 1 ? '' : 's') + '.');
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

  /* ---------- persistence ---------- */

  /* Events survive a reload in localStorage. Dates are stored as a
   * self-describing { __type: 'date', iso } wrapper; { year, month, day }
   * objects are already JSON-safe and are kept as-is. Every access is wrapped
   * because localStorage throws on some schemes (file:// in some browsers,
   * private mode, disabled storage) and a failure must never break the page. */
  var STORAGE_KEY = 'ics-gen-v2';
  /* 3 adds calendarName/fileName; 2 wraps records as { options, uid };
   * 1 was the flat options array and is still accepted on restore. */
  var STORAGE_VERSION = 3;
  var MAX_RESTORED_EVENTS = MAX_EVENTS;
  /* Set when a restore leaves the stored payload unreadable or only partly
   * restored. While locked, saveEvents() writes nothing, so a metadata edit
   * can never overwrite data this version could not fully read. An explicit
   * event-list mutation expresses intent to move on and clears the lock. */
  var storageLocked = false;

  function unlockStorage() { storageLocked = false; }
  var SAVE_BLOCKED_MSG = "This browser blocks saving — events won't survive a reload.";

  /* The save warning has its own persistent element (not #status-msg) so a
   * later action status can never hide a browser that refuses to store. */
  function showSaveWarning() {
    var el = $('save-warning');
    el.textContent = SAVE_BLOCKED_MSG;
    el.hidden = false;
  }

  function hideSaveWarning() {
    $('save-warning').hidden = true;
  }

  /* The VTIMEZONE preference is stored in its own key: the v3 events envelope
   * (and its version) must not change just to remember a preview option. */
  var VTIMEZONE_KEY = 'ics-gen-v2-vtimezone';

  function loadVtimezonePref() {
    var on = false;
    try { on = localStorage.getItem(VTIMEZONE_KEY) === '1'; } catch (e) { on = false; }
    cal.includeVtimezone = on;
    $('vtimezone-toggle').checked = on;
  }

  function saveVtimezonePref() {
    try {
      localStorage.setItem(VTIMEZONE_KEY, cal.includeVtimezone ? '1' : '0');
    } catch (e) { /* storage may be unavailable; the toggle still works this session */ }
  }

  $('vtimezone-toggle').addEventListener('change', function () {
    cal.includeVtimezone = $('vtimezone-toggle').checked;
    saveVtimezonePref();
    render();
  });

  function serializeDateValue(v) {
    if (isDateParts(v)) return { year: v.year, month: v.month, day: v.day };
    if (v instanceof Date) return { __type: 'date', iso: v.toISOString() };
    return v;
  }

  function serializeOptions(o) {
    var out = copyPlain(o);
    if (o.start != null) out.start = serializeDateValue(o.start);
    if (o.end != null) out.end = serializeDateValue(o.end);
    return out;
  }

  function deserializeDateValue(v) {
    if (v && v.__type === 'date' && typeof v.iso === 'string') {
      var d = new Date(v.iso);
      return isNaN(d.getTime()) ? null : d;
    }
    if (isDateParts(v)) return { year: v.year, month: v.month, day: v.day };
    return v;
  }

  function deserializeOptions(o) {
    var out = copyPlain(o);
    if (o.start != null) out.start = deserializeDateValue(o.start);
    if (o.end != null) out.end = deserializeDateValue(o.end);
    return out;
  }

  function saveEvents() {
    if (storageLocked) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: STORAGE_VERSION,
        calendarName: $('calendar-name').value,
        fileName: $('download-filename').value,
        /* Each record carries its effective uid alongside the options so a
         * reload reproduces the identical UID line instead of a new random one. */
        events: cal.events.map(function (ev) {
          var options = serializeOptions(ev.options);
          delete options.uid;
          return { options: options, uid: ev.uid };
        })
      }));
      hideSaveWarning();
    } catch (e) {
      /* quota/security error — keep the warning visible until a save works */
      showSaveWarning();
    }
  }

  /* Returns { restored, saved, failed, unreadable }. `saved` is how many
   * records the payload held before the 200 cap. `failed` is true when any
   * part of the payload could not be restored, so the caller locks storage.
   * `unreadable` marks payloads this version cannot read at all (malformed
   * JSON, a foreign/newer version, or a missing events array). */
  function restoreEvents() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) { return { restored: 0, saved: 0, failed: false, unreadable: false }; }
    if (!raw) return { restored: 0, saved: 0, failed: false, unreadable: false };

    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) { return { restored: 0, saved: 0, failed: true, unreadable: true }; }
    if (!data || typeof data !== 'object') {
      return { restored: 0, saved: 0, failed: true, unreadable: true };
    }
    /* Accept v1's flat options and v2's wrapped records. Missing names leave
     * the UI defaults intact, then save migrates whatever the controls hold.
     * A newer/foreign version is left untouched in storage. */
    var legacy = data.version === 1;
    if (!legacy && data.version !== 2 && data.version !== STORAGE_VERSION) {
      return { restored: 0, saved: 0, failed: true, unreadable: true };
    }
    if (!Array.isArray(data.events)) {
      return { restored: 0, saved: 0, failed: true, unreadable: true };
    }
    if (data.version === STORAGE_VERSION) {
      if (typeof data.calendarName === 'string') $('calendar-name').value = data.calendarName.slice(0, 60);
      if (typeof data.fileName === 'string') $('download-filename').value = data.fileName.slice(0, 60);
    }
    syncCalendarName();

    var saved = data.events.length;
    var count = 0;
    var dropped = saved > MAX_RESTORED_EVENTS;
    data.events.slice(0, MAX_RESTORED_EVENTS).forEach(function (record) {
      if (!record || typeof record !== 'object') { dropped = true; return; }
      var options = legacy ? record : record.options;
      if (!options || typeof options !== 'object') { dropped = true; return; }
      try {
        var ev = cal.addEvent(deserializeOptions(options));
        /* v1 records carry no uid, so the fresh one addEvent generated stands. */
        var uid = legacy ? null : record.uid;
        /* ev.uid is stored already escaped, so assigning the stored string
         * directly reproduces the identical UID line. A missing or invalid uid
         * keeps the freshly generated one instead of dropping the event. */
        if (typeof uid === 'string' && uid.length > 0 && uid.length <= 200 &&
            !/[\u0000-\u001F\u007F]/.test(uid)) {
          ev.uid = uid;
        }
        count++;
      } catch (e) { dropped = true; /* an event that no longer validates is skipped */ }
    });
    return { restored: count, saved: saved, failed: dropped, unreadable: false };
  }

  /* ---------- init ---------- */

  syncCalendarName();
  loadVtimezonePref();
  defaultFormDates();
  populateTimeZones();
  syncAllDayUI();
  syncRecurUI();
  syncReminderUI();
  var restored = 0;
  var savedTotal = 0;
  var restoreFailed = false;
  var restoreUnreadable = false;
  try {
    var restoreResult = restoreEvents();
    restored = restoreResult.restored;
    savedTotal = restoreResult.saved;
    restoreFailed = restoreResult.failed;
    restoreUnreadable = restoreResult.unreadable;
  } catch (e) {
    /* No restore path may leave the page half-initialized: drop whatever was
     * loaded, lock storage and continue with an empty list. */
    cal.clear();
    restoreFailed = true;
    restoreUnreadable = true;
  }
  if (restoreFailed) storageLocked = true;
  render();
  if (restoreUnreadable) {
    setStatus('Saved events could not be restored — they were left untouched in storage.', true);
  } else if (restored && savedTotal > restored) {
    setStatus('Restored ' + restored + ' of ' + savedTotal + ' saved events — the rest could not be restored.');
  } else if (restored) {
    setStatus('Restored ' + restored + ' saved event(s).');
  } else if (savedTotal > 0) {
    setStatus('Saved events could not be restored — they were left untouched in storage.', true);
  }
  /* Start keyboard visitors in the first field (no scroll-jumping). */
  $('title').focus();
})();