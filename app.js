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
    if (allDay && endDateEl.value && startDateEl.value && endDateEl.value <= startDateEl.value) {
      endDateEl.value = addDays(startDateEl.value, 1);
    }
  }

  function syncRecurUI() {
    var off = $('recur-freq').value === 'NONE';
    $('field-interval').hidden = off;
    $('field-until').hidden = off;
  }

  $('all-day').addEventListener('change', syncAllDayUI);
  $('recur-freq').addEventListener('change', syncRecurUI);

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
      opts.start = new Date(startDateEl.value + 'T' + startTimeEl.value);
      if (endDateEl.value && endTimeEl.value) {
        opts.end = new Date(endDateEl.value + 'T' + endTimeEl.value);
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
          /* end of that day, UTC */
          parts.push('UNTIL=' + IcsGenerator.formatDateTimeUTC(new Date(Date.UTC(up.year, up.month - 1, up.day, 23, 59, 59))));
        }
      }
      opts.rrule = parts.join(';');
    }

    var rem = $('reminder').value;
    if (rem !== 'none') opts.alarms = [{ trigger: -parseInt(rem, 10) }];

    return opts;
  }

  /* ---------- rendering ---------- */

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
      var startLabel = ev.start.toLocaleString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
      if (ev.end) {
        var sameDay = ev.start.toDateString() === ev.end.toDateString();
        var endOpts = sameDay
          ? { hour: 'numeric', minute: '2-digit' }
          : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
        startLabel += ' – ' + ev.end.toLocaleString(undefined, endOpts);
      }
      bits.push(startLabel);
    }
    var rule = /FREQ=([A-Z]+)/.exec(o.rrule || '');
    if (rule) bits.push('Repeats ' + rule[1].toLowerCase());
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

    /* 1. recurring standup */
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

    /* 2. all-day multi-day event */
    var offsite = daysFromNow(21);
    var offsiteEnd = daysFromNow(22);
    cal.addEvent({
      title: 'Quarterly planning offsite',
      description: 'Annual planning for next quarter. Bring your laptops!',
      location: 'Mountain lodge',
      start: { year: offsite.getFullYear(), month: offsite.getMonth() + 1, day: offsite.getDate() },
      end: { year: offsiteEnd.getFullYear(), month: offsiteEnd.getMonth() + 1, day: offsiteEnd.getDate() },
      categories: ['Release', 'Planning']
    });

    /* 3. one-off with attendees */
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
      ]
    });

    render();
    setStatus('Loaded 3 sample events. Try downloading the .ics and importing it.');
  });

  /* ---------- init ---------- */

  defaultFormDates();
  syncAllDayUI();
  syncRecurUI();
  render();
})();