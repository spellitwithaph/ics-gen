/*!
 * v2/tests/ics.test.js — coverage for the v2 copy of the generator (v2/ics.js).
 *
 * Run with: node v2/tests/run.js
 *
 * These tests pin the generator's public behavior: TEXT escaping, CRLF output,
 * 75-octet folding, UTC/DATE/TZID timestamps, recurrence, alarms, attendees,
 * URL/email validation, UIDs, calendar properties, and mutation helpers.
 */
'use strict';

var ICS = require('../ics.js');
require('../ics-parse.js'); /* attaches ICS.parse for the VTIMEZONE round-trip test */

var CRLF = '\r\n';

/* Rejoin folded content lines so assertions are not sensitive to offsets. */
function unfold(text) {
  var out = [];
  String(text).split(CRLF).forEach(function (line) {
    if (line.charAt(0) === ' ' && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  });
  return out.join('\n');
}

function makeEvent(options) {
  return new ICS.Calendar().addEvent(options);
}

function calendarWith(options) {
  var calendar = new ICS.Calendar();
  calendar.addEvent(options);
  return calendar;
}

/* ---------- availability & priority ---------- */

function fieldEvent(fields) {
  return makeEvent(Object.assign({ title: 'Fields', start: new Date('2026-01-05T10:00:00Z') }, fields));
}

test('explicit OPAQUE and TRANSPARENT emit TRANSP', function () {
  ['OPAQUE', 'TRANSPARENT'].forEach(function (transp) {
    assert.includes(fieldEvent({ transp: transp }).toString(), 'TRANSP:' + transp);
  });
});

test('omitted transp emits no TRANSP line', function () {
  assert.ok(fieldEvent({}).toString().indexOf('TRANSP:') === -1);
});

test('invalid transp values are rejected eagerly', function () {
  ['BUSY', 'transparent', '', null, 'OPAQUE\r\nPRIORITY:1'].forEach(function (transp) {
    assert.throws(function () { fieldEvent({ transp: transp }); }, /event "transp"/);
  });
});

test('priority 1 and 9 emit PRIORITY', function () {
  [1, 9].forEach(function (priority) {
    assert.includes(fieldEvent({ priority: priority }).toString(), 'PRIORITY:' + priority);
  });
});

test('priority zero and undefined emit no PRIORITY line', function () {
  [0, undefined].forEach(function (priority) {
    assert.ok(fieldEvent({ priority: priority }).toString().indexOf('PRIORITY:') === -1);
  });
});

test('invalid priorities are rejected eagerly', function () {
  [10, -1, 1.5, NaN, Infinity, '1', null].forEach(function (priority) {
    assert.throws(function () { fieldEvent({ priority: priority }); }, /event "priority"/);
  });
});

test('mutated transp and priority are revalidated during serialization', function () {
  var ev = fieldEvent({ transp: 'OPAQUE', priority: 1 });
  ev.options.transp = 'BUSY';
  assert.throws(function () { ev.toString(); }, /event "transp"/);
  ev.options.transp = 'TRANSPARENT';
  ev.options.priority = 10;
  assert.throws(function () { ev.toString(); }, /event "priority"/);
});

test('calendar name can be changed or omitted through its options', function () {
  var cal = new ICS.Calendar({ name: 'My Events' });
  assert.includes(cal.toString(), 'X-WR-CALNAME:My Events');
  cal.options.name = 'Team, planning';
  assert.includes(cal.toString(), 'X-WR-CALNAME:Team\\, planning');
  cal.options.name = '';
  assert.ok(cal.toString().indexOf('X-WR-CALNAME:') === -1);
});

/* ---------- escaping ---------- */

test('escapeText escapes backslashes', function () {
  assert.eq(ICS.escapeText('a\\b'), 'a\\\\b');
});

test('escapeText escapes semicolons and commas', function () {
  assert.eq(ICS.escapeText('a;b,c'), 'a\\;b\\,c');
});

test('escapeText normalises CRLF, CR and LF to \\n', function () {
  assert.eq(ICS.escapeText('a\r\nb\rc\nd'), 'a\\nb\\nc\\nd');
});

test('escapeText drops disallowed control characters', function () {
  assert.eq(ICS.escapeText('a\u0000b\u0007c\u007fd'), 'abcd');
  assert.eq(ICS.escapeText('tab\tkept'), 'tab\tkept');
});

test('TEXT values are escaped in generated output', function () {
  var text = unfold(
    makeEvent({
      title: 'R&D; review, day 1',
      start: new Date('2026-01-05T10:00:00Z'),
      durationMinutes: 30,
      description: 'one\ntwo; three, four \\ five',
      location: 'Room; 42, B'
    }).toString()
  );
  assert.includes(text, 'SUMMARY:R&D\\; review\\, day 1');
  assert.includes(text, 'DESCRIPTION:one\\ntwo\\; three\\, four \\\\ five');
  assert.includes(text, 'LOCATION:Room\\; 42\\, B');
});

/* ---------- line endings & folding ---------- */

test('generated calendars use CRLF line endings and end with CRLF', function () {
  var text = calendarWith({ title: 'CRLF', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 }).toString();
  assert.eq(text.slice(-CRLF.length), CRLF, 'output must end with CRLF');
  assert.ok(!/[^\r]\n/.test(text), 'every LF must be preceded by CR');
  assert.includes(text.split(CRLF), 'BEGIN:VCALENDAR');
});

test('foldLines keeps every line within 75 UTF-8 octets', function () {
  var value = 'DESCRIPTION:' + 'é'.repeat(90) + '😀'.repeat(30) + ',' + 'x'.repeat(80);
  var folded = ICS.foldLines(value);
  folded.split(CRLF).forEach(function (line) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, 'line exceeds 75 octets: ' + line);
  });
});

test('foldLines prefixes continuations with a space and unfolds losslessly', function () {
  var value = 'SUMMARY:' + 'segment '.repeat(30);
  var out = ICS.foldLines(value).split(CRLF);
  assert.ok(out.length > 1, 'long line should be folded');
  var unfolded = out[0];
  for (var i = 1; i < out.length; i++) {
    assert.eq(out[i].charAt(0), ' ', 'continuation line must start with a space');
    unfolded += out[i].slice(1);
  }
  assert.eq(unfolded, value);
});

test('a long calendar summary never emits a line over 75 octets', function () {
  var text = makeEvent({
    title: 'Ünïcödé 😀 meeting ' + 'long '.repeat(40),
    start: new Date('2026-01-05T10:00:00Z'),
    durationMinutes: 30
  }).toString();
  text.split(CRLF).forEach(function (line) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, 'line exceeds 75 octets: ' + line);
  });
});

test('a long multi-byte description folds within 75 octets and unfolds exactly', function () {
  var original = '会議の議事録 😀 ' + '予定と議題'.repeat(12) + ' 🚀🎉';
  var text = makeEvent({
    title: 'Unicode fold',
    start: new Date('2026-01-05T10:00:00Z'),
    durationMinutes: 30,
    description: original
  }).toString();

  text.split(CRLF).forEach(function (line) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, 'line exceeds 75 octets: ' + line);
  });

  var descriptionLine = unfold(text)
    .split('\n')
    .filter(function (line) { return line.indexOf('DESCRIPTION:') === 0; })[0];
  assert.eq(descriptionLine, 'DESCRIPTION:' + original);
});

/* ---------- timestamp formatting ---------- */

test('formatDateTimeUTC formats UTC fields as YYYYMMDDTHHMMSSZ', function () {
  assert.eq(ICS.formatDateTimeUTC(new Date('2026-01-05T10:30:09Z')), '20260105T103009Z');
});

test('formatDateUTC formats a Date from its UTC fields', function () {
  assert.eq(ICS.formatDateUTC(new Date(Date.UTC(2026, 0, 5, 23, 59, 59))), '20260105');
});

test('formatDateUTC passes through { year, month, day } parts', function () {
  assert.eq(ICS.formatDateUTC({ year: 2026, month: 1, day: 5 }), '20260105');
  assert.eq(ICS.formatDateUTC({ year: 2026, month: 12, day: 25 }), '20261225');
});

test('timed events without a timezone are emitted as UTC instants', function () {
  var text = unfold(
    makeEvent({ title: 'UTC', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 }).toString()
  );
  assert.includes(text, 'DTSTART:20260105T100000Z');
  assert.includes(text, 'DTEND:20260105T103000Z');
});

test('durationMinutes supplies the default end for timed events', function () {
  var ev = makeEvent({ title: 'Dur', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 45 });
  assert.eq(ev.end.toISOString(), '2026-01-05T10:45:00.000Z');
  assert.includes(unfold(ev.toString()), 'DTEND:20260105T104500Z');
});

test('a punctual timed event omits DTEND', function () {
  var text = unfold(makeEvent({ title: 'Punctual', start: new Date('2026-01-05T10:00:00Z') }).toString());
  assert.includes(text, 'DTSTART:20260105T100000Z');
  assert.ok(text.indexOf('DTEND') === -1, 'DTEND should be omitted when no end/duration is given');
});

test('all-day event from date parts emits VALUE=DATE with exclusive DTEND', function () {
  var text = unfold(makeEvent({ title: 'Holiday', start: { year: 2026, month: 1, day: 5 } }).toString());
  assert.includes(text, 'DTSTART;VALUE=DATE:20260105');
  assert.includes(text, 'DTEND;VALUE=DATE:20260106');
});

test('all-day event honours an explicit exclusive end', function () {
  var text = unfold(
    makeEvent({ title: 'Trip', start: { year: 2026, month: 1, day: 5 }, end: { year: 2026, month: 1, day: 7 } }).toString()
  );
  assert.includes(text, 'DTSTART;VALUE=DATE:20260105');
  assert.includes(text, 'DTEND;VALUE=DATE:20260107');
});

test('allDay with a Date start rolls DTEND to the next day', function () {
  var text = unfold(
    makeEvent({ title: 'AllDayDate', start: new Date('2026-01-05T10:00:00Z'), allDay: true }).toString()
  );
  assert.includes(text, 'DTSTART;VALUE=DATE:20260105');
  assert.includes(text, 'DTEND;VALUE=DATE:20260106');
});

/* ---------- time zones / DST ---------- */

test('zonedTimeToDate converts New York wall clock to the correct winter instant', function () {
  assert.eq(
    ICS.zonedTimeToDate(2026, 1, 15, 12, 0, 'America/New_York').toISOString(),
    '2026-01-15T17:00:00.000Z'
  );
});

test('zonedTimeToDate converts New York wall clock to the correct summer instant', function () {
  assert.eq(
    ICS.zonedTimeToDate(2026, 7, 15, 12, 0, 'America/New_York').toISOString(),
    '2026-07-15T16:00:00.000Z'
  );
});

test('zonedTimeToDate maths spans a DST boundary (winter vs summer offset)', function () {
  var winterOffset =
    ICS.zonedTimeToDate(2026, 1, 15, 12, 0, 'America/New_York').getTime() - Date.UTC(2026, 0, 15, 12, 0);
  var summerOffset =
    ICS.zonedTimeToDate(2026, 7, 15, 12, 0, 'America/New_York').getTime() - Date.UTC(2026, 6, 15, 12, 0);
  assert.eq(winterOffset, 5 * 3600000, 'EST is UTC-5');
  assert.eq(summerOffset, 4 * 3600000, 'EDT is UTC-4');
  assert.eq(winterOffset - summerOffset, 3600000, 'EDT is one hour ahead of EST');
});

test('timezone events emit DTSTART;TZID= with wall-clock time', function () {
  var text = unfold(
    makeEvent({
      title: 'NY',
      start: new Date('2026-01-15T17:00:00Z'),
      timezone: 'America/New_York'
    }).toString()
  );
  assert.includes(text, 'DTSTART;TZID=America/New_York:20260115T120000');
});

test('a DST spring-forward day keeps the TZID wall-clock time in emitted ICS', function () {
  /* America/New_York springs forward on 2026-03-08 (02:00 EST → 03:00 EDT). */
  var before = ICS.zonedTimeToDate(2026, 3, 8, 1, 30, 'America/New_York');
  var after = ICS.zonedTimeToDate(2026, 3, 8, 3, 30, 'America/New_York');
  assert.eq(before.toISOString(), '2026-03-08T06:30:00.000Z');
  assert.eq(after.toISOString(), '2026-03-08T07:30:00.000Z');

  var text = unfold(
    makeEvent({
      title: 'Spring forward',
      start: after,
      durationMinutes: 60,
      timezone: 'America/New_York'
    }).toString()
  );
  assert.includes(text, 'DTSTART;TZID=America/New_York:20260308T033000');
  assert.includes(text, 'DTEND;TZID=America/New_York:20260308T043000');

  var earlier = unfold(
    makeEvent({
      title: 'Before the jump',
      start: before,
      timezone: 'America/New_York'
    }).toString()
  );
  assert.includes(earlier, 'DTSTART;TZID=America/New_York:20260308T013000');
});

test('an unambiguous zoned end still emits DTEND;TZID= wall-clock time', function () {
  var text = unfold(
    makeEvent({
      title: 'NY winter',
      start: ICS.zonedTimeToDate(2026, 1, 15, 12, 0, 'America/New_York'),
      durationMinutes: 45,
      timezone: 'America/New_York'
    }).toString()
  );
  assert.includes(text, 'DTSTART;TZID=America/New_York:20260115T120000');
  assert.includes(text, 'DTEND;TZID=America/New_York:20260115T124500');
});

test('an ambiguous zoned end wall time is emitted as a UTC DTEND', function () {
  /* America/New_York falls back on 2026-11-01: the 01:30 wall clock happens
   * twice (05:30Z EDT, then 06:30Z EST). A 00:30 start plus 2 hours ends at the
   * SECOND occurrence, so a TZID'd wall clock would be read back as the first
   * and the event would appear an hour short. */
  var start = ICS.zonedTimeToDate(2026, 11, 1, 0, 30, 'America/New_York');
  assert.eq(start.toISOString(), '2026-11-01T04:30:00.000Z', 'start is 00:30 EDT');

  /* The library itself resolves that repeated wall clock to the earlier,
   * unintended instant — exactly the consumer behavior DTEND must avoid. */
  assert.eq(
    ICS.zonedTimeToDate(2026, 11, 1, 1, 30, 'America/New_York').toISOString(),
    '2026-11-01T05:30:00.000Z'
  );

  var text = unfold(
    makeEvent({
      title: 'Fall back',
      start: start,
      durationMinutes: 120,
      timezone: 'America/New_York'
    }).toString()
  );
  assert.includes(text, 'DTSTART;TZID=America/New_York:20261101T003000');
  assert.includes(text, 'DTEND:20261101T063000Z', 'the ambiguous end is written as UTC');
  assert.notOk(/DTEND;TZID=[^:]*:20261101T013000/.test(text), 'no ambiguous TZID DTEND is written');

  /* The UTC end is unambiguous: it names exactly the app's 06:30Z instant,
   * 120 elapsed minutes after the start. */
  var end = new Date(Date.UTC(2026, 10, 1, 6, 30, 0));
  assert.eq(end.toISOString(), '2026-11-01T06:30:00.000Z');
  assert.eq((end.getTime() - start.getTime()) / 60000, 120, 'elapsed minutes are exactly 120');
});

test('a spring-forward end whose wall time is not repeated keeps DTEND;TZID', function () {
  /* New York springs forward on 2026-03-08: 01:30 EST + 60min lands on 03:30
   * EDT (the skipped 02:30 never exists), which is not an ambiguous wall time. */
  var start = ICS.zonedTimeToDate(2026, 3, 8, 1, 30, 'America/New_York');
  assert.eq(start.toISOString(), '2026-03-08T06:30:00.000Z');
  var text = unfold(
    makeEvent({
      title: 'Spring forward',
      start: start,
      durationMinutes: 60,
      timezone: 'America/New_York'
    }).toString()
  );
  assert.includes(text, 'DTSTART;TZID=America/New_York:20260308T013000');
  assert.includes(text, 'DTEND;TZID=America/New_York:20260308T033000');
});

test('timezone values containing control characters are rejected', function () {
  assert.throws(function () {
    makeEvent({ title: 'Bad', start: new Date('2026-01-05T10:00:00Z'), timezone: 'Bad\nZone' });
  }, /control characters/);
});

test('unknown time zones are rejected at construction', function () {
  assert.throws(function () {
    makeEvent({ title: 'Bad zone', start: new Date('2026-01-05T10:00:00Z'), timezone: 'Not/AZone' });
  }, /unknown time zone/i);
});

test('updateEvent rejects an unknown time zone and leaves the calendar alone', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  assert.throws(function () {
    cal.updateEvent(0, { title: 'A', start: new Date('2026-01-05T10:00:00Z'), timezone: 'Not/AZone' });
  }, /unknown time zone/i);
  assert.eq(cal.events.length, 1, 'a failed update must not change the calendar');
  assert.eq(cal.events[0].options.timezone, undefined);
});

test('valid IANA zones, UTC, and an omitted zone all pass validation', function () {
  assert.ok(makeEvent({ title: 'NY', start: new Date('2026-01-05T10:00:00Z'), timezone: 'America/New_York' }));
  assert.ok(makeEvent({ title: 'UTC', start: new Date('2026-01-05T10:00:00Z'), timezone: 'UTC' }));
  assert.ok(makeEvent({ title: 'None', start: new Date('2026-01-05T10:00:00Z') }));
});

/* ---------- recurrence ---------- */

test('rrule is passed through to RRULE', function () {
  var text = unfold(
    makeEvent({
      title: 'Recurring',
      start: new Date('2026-01-05T10:00:00Z'),
      durationMinutes: 30,
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6'
    }).toString()
  );
  assert.includes(text, 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6');
});

test('rrule containing control characters is rejected', function () {
  assert.throws(function () {
    makeEvent({ title: 'Bad', start: new Date('2026-01-05T10:00:00Z'), rrule: 'FREQ=DAILY\r\nX:1' });
  }, /control characters/);
});

/* ---------- alarms ---------- */

test('numeric alarm triggers become minute durations (negative = before)', function () {
  var text = unfold(
    makeEvent({
      title: 'Alarm',
      start: new Date('2026-01-05T10:00:00Z'),
      durationMinutes: 30,
      alarms: [{ trigger: -15 }]
    }).toString()
  );
  assert.includes(text, 'BEGIN:VALARM');
  assert.includes(text, 'ACTION:DISPLAY');
  assert.includes(text, 'TRIGGER:-PT15M');
  assert.includes(text, 'END:VALARM');
});

test('alarm descriptions default to the event title', function () {
  var text = unfold(
    makeEvent({
      title: 'Standup',
      start: new Date('2026-01-05T10:00:00Z'),
      durationMinutes: 30,
      alarms: [{ trigger: 10 }]
    }).toString()
  );
  assert.includes(text, 'DESCRIPTION:Standup');
  assert.includes(text, 'TRIGGER:PT10M');
});

test('ISO 8601 duration alarm triggers pass through with a custom description', function () {
  var text = unfold(
    makeEvent({
      title: 'ISO',
      start: new Date('2026-01-05T10:00:00Z'),
      durationMinutes: 30,
      alarms: [{ trigger: '-PT30M', description: 'ISO alarm' }]
    }).toString()
  );
  assert.includes(text, 'TRIGGER:-PT30M');
  assert.includes(text, 'DESCRIPTION:ISO alarm');
});

test('alarm triggers containing control characters are rejected', function () {
  assert.throws(function () {
    makeEvent({ title: 'Bad', start: new Date('2026-01-05T10:00:00Z'), alarms: [{ trigger: '-PT1M\nX:1' }] });
  }, /control characters/);
});

/* ---------- people ---------- */

test('organizer and attendee parameters are emitted correctly', function () {
  var text = unfold(
    makeEvent({
      title: 'People',
      start: new Date('2026-01-05T10:00:00Z'),
      durationMinutes: 30,
      organizer: { name: 'Pat Manager', email: 'pat@example.com' },
      attendees: [
        { name: 'Ann Lee', email: 'ann@example.com', role: 'req-participant', status: 'accepted', rsvp: true },
        { email: 'bob@example.com' }
      ]
    }).toString()
  );
  assert.includes(text, 'ORGANIZER;CN=Pat Manager:mailto:pat@example.com');
  assert.includes(text, 'ATTENDEE;CN=Ann Lee;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:ann@example.com');
  assert.includes(text, 'ATTENDEE:mailto:bob@example.com');
});

test('invalid attendee and organizer emails are rejected', function () {
  assert.throws(function () {
    makeEvent({ title: 'Bad', start: new Date('2026-01-05T10:00:00Z'), attendees: [{ email: 'nope' }] });
  }, /invalid attendee email address/);
  assert.throws(function () {
    makeEvent({ title: 'Bad', start: new Date('2026-01-05T10:00:00Z'), organizer: { email: 'a@b' } });
  }, /invalid organizer email address/);
});

/* ---------- URL scheme restriction ---------- */

test('https URLs are accepted and emitted as URL', function () {
  var text = unfold(
    makeEvent({
      title: 'Link',
      start: new Date('2026-01-05T10:00:00Z'),
      durationMinutes: 30,
      url: 'https://example.com/agenda?x=1&y=2'
    }).toString()
  );
  assert.includes(text, 'URL:https://example.com/agenda?x=1&y=2');
});

test('javascript: URLs are rejected', function () {
  assert.throws(function () {
    makeEvent({ title: 'Bad', start: new Date('2026-01-05T10:00:00Z'), url: 'javascript:alert(1)' });
  }, /absolute http\(s\) URL/);
});

test('data: URLs are rejected', function () {
  assert.throws(function () {
    makeEvent({ title: 'Bad', start: new Date('2026-01-05T10:00:00Z'), url: 'data:text/plain,hi' });
  }, /absolute http\(s\) URL/);
});

/* ---------- identity & calendar properties ---------- */

test('a provided uid is preserved instead of a random one', function () {
  var ev = makeEvent({ title: 'Stable', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30, uid: 'stable-123' });
  assert.eq(ev.uid, 'stable-123');
  assert.includes(unfold(ev.toString()), 'UID:stable-123');
});

test('a random uid is generated when none is provided', function () {
  var a = makeEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  var b = makeEvent({ title: 'B', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  assert.ok(a.uid && a.uid.length > 0, 'uid should be present');
  assert.ok(a.uid !== b.uid, 'random uids should differ between events');
});

test('calendar name and description emit X-WR-CALNAME and X-WR-CALDESC', function () {
  var cal = new ICS.Calendar({ name: 'My Cal, v2', desc: 'Desc; with, chars' });
  cal.addEvent({ title: 'E', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  var text = unfold(cal.toString());
  assert.includes(text, 'X-WR-CALNAME:My Cal\\, v2');
  assert.includes(text, 'X-WR-CALDESC:Desc\\; with\\, chars');
});

test('the calendar envelope carries METHOD, PRODID, VERSION and CALSCALE', function () {
  var text = unfold(calendarWith({ title: 'Env', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 }).toString());
  assert.includes(text, 'BEGIN:VCALENDAR');
  assert.includes(text, 'VERSION:2.0');
  assert.includes(text, 'PRODID:' + ICS.PRODID);
  assert.includes(text, 'CALSCALE:GREGORIAN');
  assert.includes(text, 'METHOD:PUBLISH');
  assert.includes(text, 'END:VCALENDAR');
});

/* ---------- validation & mutation ---------- */

test('events require a non-empty title', function () {
  assert.throws(function () {
    makeEvent({ start: new Date('2026-01-05T10:00:00Z') });
  }, /"title" is required/);
  assert.throws(function () {
    makeEvent({ title: '   ', start: new Date('2026-01-05T10:00:00Z') });
  }, /"title" is required/);
});

test('events require a valid start', function () {
  assert.throws(function () {
    makeEvent({ title: 'Bad', start: 'not-a-date' });
  }, /"start" must be a Date or/);
});

test('removeEvent removes by reference and by index and reports success', function () {
  var cal = new ICS.Calendar();
  var first = cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  cal.addEvent({ title: 'B', start: new Date('2026-01-06T10:00:00Z'), durationMinutes: 30 });
  assert.eq(cal.events.length, 2);
  assert.eq(cal.removeEvent(first), true);
  assert.eq(cal.events.length, 1);
  assert.eq(cal.removeEvent(first), false, 'removing a missing event returns false');
  assert.eq(cal.removeEvent(0), true);
  assert.eq(cal.events.length, 0);
});

/* ---------- updateEvent ---------- */

test('updateEvent replaces in place and carries over the uid when omitted', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  var target = cal.addEvent({ title: 'B', start: new Date('2026-01-06T10:00:00Z'), durationMinutes: 30 });
  cal.addEvent({ title: 'C', start: new Date('2026-01-07T10:00:00Z'), durationMinutes: 30 });

  var updated = cal.updateEvent(1, { title: 'B renamed', start: new Date('2026-01-06T11:00:00Z'), durationMinutes: 45 });
  assert.ok(updated, 'updateEvent should return the new VEvent');
  assert.eq(cal.events.length, 3, 'no event is added or removed');
  assert.eq(cal.events.indexOf(updated), 1, 'the new event keeps the original index');
  assert.eq(updated.uid, target.uid, 'uid is carried over when options.uid is omitted');
  assert.eq(cal.events[0].options.title, 'A');
  assert.eq(cal.events[2].options.title, 'C');
});

test('updateEvent honors an explicit uid', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  var updated = cal.updateEvent(0, { title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30, uid: 'explicit-uid-1' });
  assert.eq(updated.uid, 'explicit-uid-1');
  assert.includes(unfold(cal.toString()), 'UID:explicit-uid-1');
});

test('updateEvent output reflects the new field values', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'Old title',
    start: new Date('2026-01-05T10:00:00Z'),
    durationMinutes: 30,
    description: 'old',
    location: 'Old room'
  });
  cal.updateEvent(0, {
    title: 'New title',
    start: new Date('2026-02-01T09:00:00Z'),
    durationMinutes: 90,
    description: 'new description',
    location: 'New room'
  });
  var text = unfold(cal.toString());
  assert.includes(text, 'SUMMARY:New title');
  assert.includes(text, 'DESCRIPTION:new description');
  assert.includes(text, 'LOCATION:New room');
  assert.includes(text, 'DTSTART:20260201T090000Z');
  assert.includes(text, 'DTEND:20260201T103000Z');
  assert.ok(text.indexOf('Old title') === -1, 'the old title must be gone');
});

test('updateEvent resolves the target by VEvent reference too', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  var target = cal.addEvent({ title: 'B', start: new Date('2026-01-06T10:00:00Z'), durationMinutes: 30 });
  var updated = cal.updateEvent(target, { title: 'B2', start: new Date('2026-01-06T10:00:00Z'), durationMinutes: 30 });
  assert.ok(updated);
  assert.eq(cal.events[1], updated);
  assert.eq(cal.events[1].uid, target.uid);
});

test('updateEvent returns false for an invalid target and leaves the calendar alone', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  var opts = { title: 'X', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 };
  assert.eq(cal.updateEvent(5, opts), false, 'out-of-range index returns false');
  assert.eq(cal.updateEvent(-1, opts), false, 'negative index returns false');
  assert.eq(cal.updateEvent(new ICS.VEvent(opts), opts), false, 'a foreign VEvent is not found');
  assert.eq(cal.events.length, 1);
  assert.eq(cal.events[0].options.title, 'A');
});

test('updateEvent rejects non-integer and NaN indices', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  cal.addEvent({ title: 'B', start: new Date('2026-01-06T10:00:00Z'), durationMinutes: 30 });
  var opts = { title: 'X', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 };
  assert.eq(cal.updateEvent(1.5, opts), false, 'a fractional index returns false');
  assert.eq(cal.updateEvent(NaN, opts), false, 'NaN returns false');
  assert.eq(cal.events[0].options.title, 'A');
  assert.eq(cal.events[1].options.title, 'B');
});

test('updateEvent validates options exactly like addEvent', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  assert.throws(function () {
    cal.updateEvent(0, { start: new Date('2026-01-05T10:00:00Z') });
  }, /"title" is required/);
  assert.throws(function () {
    cal.updateEvent(0, { title: 'Bad', start: 'not-a-date' });
  }, /"start" must be a Date or/);
  assert.throws(function () {
    cal.updateEvent(0, { title: 'Bad', start: new Date('2026-01-05T10:00:00Z'), url: 'javascript:alert(1)' });
  }, /absolute http\(s\) URL/);
  assert.eq(cal.events.length, 1, 'a failed update must not change the calendar');
  assert.eq(cal.events[0].options.title, 'A');
});

test('updateEvent accepts and re-validates transp and priority like addEvent', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'A',
    start: new Date('2026-01-05T10:00:00Z'),
    durationMinutes: 30,
    transp: 'OPAQUE',
    priority: 5
  });
  var updated = cal.updateEvent(0, {
    title: 'A',
    start: new Date('2026-01-05T10:00:00Z'),
    durationMinutes: 30,
    transp: 'TRANSPARENT',
    priority: 9
  });
  assert.eq(updated.options.transp, 'TRANSPARENT');
  assert.eq(updated.options.priority, 9);
  var text = unfold(cal.toString());
  assert.includes(text, 'TRANSP:TRANSPARENT');
  assert.includes(text, 'PRIORITY:9');

  assert.throws(function () {
    cal.updateEvent(0, { title: 'A', start: new Date('2026-01-05T10:00:00Z'), transp: 'BUSY' });
  }, /event "transp"/);
  assert.throws(function () {
    cal.updateEvent(0, { title: 'A', start: new Date('2026-01-05T10:00:00Z'), priority: 10 });
  }, /event "priority"/);
  assert.eq(cal.events[0].options.transp, 'TRANSPARENT', 'a failed update must not change the event');
  assert.eq(cal.events[0].options.priority, 9);
});

test('updateEvent replaces alarms and attendees arrays instead of merging them', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'A',
    start: new Date('2026-01-05T10:00:00Z'),
    durationMinutes: 30,
    alarms: [{ trigger: -10 }, { trigger: -20 }],
    attendees: [
      { email: 'a@example.com' },
      { email: 'b@example.com' }
    ]
  });
  var updated = cal.updateEvent(0, {
    title: 'A',
    start: new Date('2026-01-05T10:00:00Z'),
    durationMinutes: 30,
    alarms: [{ trigger: '-PT5M' }],
    attendees: [{ email: 'c@example.com' }]
  });
  assert.eq(updated.options.alarms.length, 1);
  assert.eq(updated.options.alarms[0].trigger, '-PT5M');
  assert.eq(updated.options.attendees.length, 1);
  assert.eq(updated.options.attendees[0].email, 'c@example.com');
  var text = unfold(cal.toString());
  assert.ok(text.indexOf('a@example.com') === -1, 'the old attendees must be gone');
  assert.includes(text, 'ATTENDEE:mailto:c@example.com');
  assert.eq((text.match(/BEGIN:VALARM/g) || []).length, 1, 'only the new alarm remains');
});

test('clear removes every event', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'A', start: new Date('2026-01-05T10:00:00Z'), durationMinutes: 30 });
  cal.addEvent({ title: 'B', start: new Date('2026-01-06T10:00:00Z'), durationMinutes: 30 });
  cal.clear();
  assert.eq(cal.events.length, 0);
  assert.includes(unfold(cal.toString()), 'END:VCALENDAR');
  assert.ok(unfold(cal.toString()).indexOf('BEGIN:VEVENT') === -1);
});

test('status is upper-cased and categories are escaped and comma-joined', function () {
  var text = unfold(
    makeEvent({
      title: 'Meta',
      start: new Date('2026-01-05T10:00:00Z'),
      durationMinutes: 30,
      status: 'tentative',
      categories: ['Work, Big', 'Meeting']
    }).toString()
  );
  assert.includes(text, 'STATUS:TENTATIVE');
  assert.includes(text, 'CATEGORIES:Work\\, Big,Meeting');
});

/* ---------- VTIMEZONE emission (opt-in) ---------- */

test('VTIMEZONE is off by default', function () {
  var cal = calendarWith({
    title: 'NY',
    start: new Date('2026-07-15T14:00:00Z'),
    durationMinutes: 60,
    timezone: 'America/New_York'
  });
  assert.eq(cal.includeVtimezone, false);
  var text = unfold(cal.toString());
  assert.ok(text.indexOf('VTIMEZONE') === -1, 'no VTIMEZONE unless opted in');
  assert.includes(text, 'DTSTART;TZID=America/New_York:20260715T100000');
});

test('VTIMEZONE constructor option enables emission', function () {
  var cal = new ICS.Calendar({ includeVtimezone: true });
  cal.addEvent({
    title: 'NY',
    start: new Date('2026-07-15T14:00:00Z'),
    durationMinutes: 60,
    timezone: 'America/New_York'
  });
  assert.eq(cal.includeVtimezone, true);
  assert.includes(unfold(cal.toString()), 'BEGIN:VTIMEZONE');
});

test('VTIMEZONE: New York emits STANDARD and DAYLIGHT with correct offsets before VEVENTs', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'NY',
    start: new Date('2026-07-15T14:00:00Z'),
    durationMinutes: 60,
    timezone: 'America/New_York'
  });
  cal.includeVtimezone = true;
  var text = unfold(cal.toString());

  assert.eq((text.match(/BEGIN:VTIMEZONE/g) || []).length, 1, 'exactly one VTIMEZONE');
  assert.includes(text, 'TZID:America/New_York');
  assert.includes(text, 'BEGIN:STANDARD');
  assert.includes(text, 'BEGIN:DAYLIGHT');
  /* America/New_York in 2026: EST is -0500, EDT is -0400. */
  assert.includes(text, 'TZOFFSETFROM:-0500');
  assert.includes(text, 'TZOFFSETTO:-0400');
  assert.includes(text, 'TZOFFSETFROM:-0400');
  assert.includes(text, 'TZOFFSETTO:-0500');
  assert.ok(
    text.indexOf('BEGIN:VTIMEZONE') < text.indexOf('BEGIN:VEVENT'),
    'VTIMEZONE must precede the first VEVENT'
  );
  assert.ok(
    text.indexOf('END:VTIMEZONE') < text.indexOf('BEGIN:VEVENT'),
    'VTIMEZONE must be closed before the first VEVENT'
  );
});

test('VTIMEZONE: two events in the same zone emit one block', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'Spring',
    start: new Date('2026-04-15T14:00:00Z'),
    durationMinutes: 30,
    timezone: 'America/New_York'
  });
  cal.addEvent({
    title: 'Fall',
    start: new Date('2026-10-15T14:00:00Z'),
    durationMinutes: 30,
    timezone: 'America/New_York'
  });
  cal.includeVtimezone = true;
  var text = unfold(cal.toString());
  assert.eq((text.match(/BEGIN:VTIMEZONE/g) || []).length, 1);
  assert.eq((text.match(/TZID:America\/New_York/g) || []).length, 1);
});

test('VTIMEZONE: UTC-only and all-day-only calendars emit none', function () {
  var utc = new ICS.Calendar();
  utc.addEvent({
    title: 'UTC',
    start: new Date('2026-07-15T14:00:00Z'),
    durationMinutes: 30,
    timezone: 'UTC'
  });
  utc.includeVtimezone = true;
  assert.ok(unfold(utc.toString()).indexOf('VTIMEZONE') === -1, 'UTC needs no VTIMEZONE');

  var allDay = new ICS.Calendar();
  allDay.addEvent({ title: 'Holiday', start: { year: 2026, month: 7, day: 15 }, end: { year: 2026, month: 7, day: 16 } });
  allDay.includeVtimezone = true;
  assert.ok(unfold(allDay.toString()).indexOf('VTIMEZONE') === -1, 'all-day events carry no TZID');
});

test('VTIMEZONE: single-offset zone emits one STANDARD with equal FROM/TO', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'Tokyo',
    start: new Date('2026-07-15T14:00:00Z'),
    durationMinutes: 60,
    timezone: 'Asia/Tokyo'
  });
  cal.includeVtimezone = true;
  var text = unfold(cal.toString());
  assert.eq((text.match(/BEGIN:VTIMEZONE/g) || []).length, 1);
  assert.eq((text.match(/BEGIN:STANDARD/g) || []).length, 1);
  assert.ok(text.indexOf('BEGIN:DAYLIGHT') === -1, 'no DST component for a fixed-offset zone');
  assert.includes(text, 'TZOFFSETFROM:+0900');
  assert.includes(text, 'TZOFFSETTO:+0900');
  assert.includes(text, 'DTSTART:19700101T000000');
});

test('VTIMEZONE: generated output still parses and keeps event instants', function () {
  var start = new Date('2026-07-15T14:00:00Z');
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'NY', start: start, durationMinutes: 60, timezone: 'America/New_York' });
  cal.addEvent({ title: 'UTC', start: new Date('2026-07-16T09:00:00Z'), durationMinutes: 30 });
  cal.includeVtimezone = true;

  var parsed = ICS.parse(cal.toString());
  assert.eq(parsed.events.length, 2);
  assert.eq(parsed.counts.vtimezone, 1);
  assert.eq(parsed.events[0].start.getTime(), start.getTime());
});

/* ---------- VTIMEZONE observances (onset frame, sampling, labels) ---------- */

/* Pull each STANDARD/DAYLIGHT observance out of an unfolded .ics document. */
function vtimezoneComponents(text) {
  var comps = [];
  var current = null;
  unfold(text).split('\n').forEach(function (line) {
    if (line === 'BEGIN:STANDARD' || line === 'BEGIN:DAYLIGHT') {
      current = { type: line.slice(6), props: {} };
      comps.push(current);
    } else if (current && line.indexOf('END:') === 0) {
      current = null;
    } else if (current) {
      var at = line.indexOf(':');
      if (at !== -1) current.props[line.slice(0, at)] = line.slice(at + 1);
    }
  });
  return comps;
}

function parseOffsetToken(token) {
  var m = /^([+-])(\d{2})(\d{2})$/.exec(token);
  if (!m) throw new Error('bad offset token ' + token);
  var mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

/* DTSTART shown by an observance, as a naive wall-clock epoch (no offset). */
function onsetWallClock(comp) {
  var m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(comp.props.DTSTART);
  if (!m) throw new Error('bad observance DTSTART ' + comp.props.DTSTART);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]));
}

/* The real UTC instant an observance's DTSTART denotes, via TZOFFSETFROM. */
function onsetInstant(comp) {
  return onsetWallClock(comp) - parseOffsetToken(comp.props.TZOFFSETFROM) * 60000;
}

/* Resolve a local wall-clock instant using nothing but the emitted components:
 * the latest onset not after it wins, and TZOFFSETTO gives the offset. */
function resolveWithComponents(comps, naiveMs) {
  var best = null;
  comps.forEach(function (comp) {
    var onset = onsetWallClock(comp);
    if (onset <= naiveMs && (!best || onset > best.onset)) best = { onset: onset, comp: comp };
  });
  if (!best) return null;
  return naiveMs - parseOffsetToken(best.comp.props.TZOFFSETTO) * 60000;
}

test('VTIMEZONE: New York onsets are second-precise and in the TZOFFSETFROM frame', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'NY',
    start: new Date('2026-07-15T14:00:00Z'),
    durationMinutes: 60,
    timezone: 'America/New_York'
  });
  cal.includeVtimezone = true;
  var comps = vtimezoneComponents(cal.toString());

  var spring = comps.filter(function (c) { return c.props.DTSTART === '20260308T020000'; })[0];
  assert.ok(spring, '2026 spring-forward onset must be DTSTART:20260308T020000');
  assert.eq(spring.type, 'DAYLIGHT');
  assert.eq(spring.props.TZOFFSETFROM, '-0500');
  assert.eq(spring.props.TZOFFSETTO, '-0400');
  assert.ok(Math.abs(onsetInstant(spring) - Date.UTC(2026, 2, 8, 7, 0, 0)) <= 1000,
    'spring onset must re-resolve to the true transition within one second');

  var fall = comps.filter(function (c) { return c.props.DTSTART === '20261101T020000'; })[0];
  assert.ok(fall, '2026 fall-back onset must be DTSTART:20261101T020000');
  assert.eq(fall.type, 'STANDARD');
  assert.eq(fall.props.TZOFFSETFROM, '-0400');
  assert.eq(fall.props.TZOFFSETTO, '-0500');
  assert.ok(Math.abs(onsetInstant(fall) - Date.UTC(2026, 10, 1, 6, 0, 0)) <= 1000,
    'fall onset must re-resolve to the true transition within one second');
});

test('VTIMEZONE: events spanning years emit onsets for every sampled year', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'Spring 2026',
    start: new Date('2026-04-15T14:00:00Z'),
    durationMinutes: 30,
    timezone: 'America/New_York'
  });
  cal.addEvent({
    title: 'Summer 2027',
    start: new Date('2027-06-15T14:00:00Z'),
    durationMinutes: 30,
    timezone: 'America/New_York'
  });
  cal.includeVtimezone = true;
  var comps = vtimezoneComponents(cal.toString());
  var starts = comps.map(function (c) { return c.props.DTSTART; });

  assert.includes(starts, '20260308T020000');
  assert.includes(starts, '20261101T020000');
  assert.includes(starts, '20270314T020000');
  assert.includes(starts, '20271107T020000');
  assert.ok(comps.filter(function (c) { return c.type === 'DAYLIGHT'; }).length >= 2,
    'each spanned year contributes a DAYLIGHT onset');
  assert.ok(comps.filter(function (c) { return c.type === 'STANDARD'; }).length >= 2,
    'each spanned year contributes a STANDARD onset');

  /* Strict resolution of the 2027 June event from the block alone. */
  var naive = Date.UTC(2027, 5, 15, 10, 0, 0);
  assert.eq(resolveWithComponents(comps, naive), Date.UTC(2027, 5, 15, 14, 0, 0),
    'the 2027 June event must land on its true UTC instant');
});

test('VTIMEZONE: Sydney labels the lower offset STANDARD and the higher DAYLIGHT', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'Sydney',
    start: new Date('2026-07-15T04:00:00Z'),
    durationMinutes: 60,
    timezone: 'Australia/Sydney'
  });
  cal.includeVtimezone = true;
  var comps = vtimezoneComponents(cal.toString());
  var standard = comps.filter(function (c) { return c.type === 'STANDARD'; });
  var daylight = comps.filter(function (c) { return c.type === 'DAYLIGHT'; });

  assert.ok(standard.length >= 1, 'Sydney must emit a STANDARD component');
  assert.ok(daylight.length >= 1, 'Sydney must emit a DAYLIGHT component');
  standard.forEach(function (c) { assert.eq(c.props.TZOFFSETTO, '+1000'); });
  daylight.forEach(function (c) { assert.eq(c.props.TZOFFSETTO, '+1100'); });
});

test('VTIMEZONE: event years beyond the old sampling cap are still emitted', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({
    title: 'Summer 2026',
    start: new Date('2026-06-15T14:00:00Z'),
    durationMinutes: 60,
    timezone: 'America/New_York'
  });
  cal.addEvent({
    title: 'Summer 2040',
    start: new Date('2040-06-15T14:00:00Z'),
    durationMinutes: 60,
    timezone: 'America/New_York'
  });
  cal.includeVtimezone = true;
  var comps = vtimezoneComponents(cal.toString());
  var starts = comps.map(function (c) { return c.props.DTSTART; });

  /* Both event years are mandatory onsets; the 2041 recurrence margin fits. */
  assert.includes(starts, '20260308T020000');
  assert.includes(starts, '20400311T020000');
  assert.includes(starts, '20401104T020000');
  assert.includes(starts, '20410310T020000');
  /* No contiguous-range sampling: 2030 is neither an event year nor the margin. */
  assert.ok(starts.indexOf('20300310T020000') === -1,
    'intermediate years must not be sampled just to fill the range');
  assert.ok(starts.indexOf('20370308T020000') === -1,
    'the block must not stop at the old 12-year truncation point');

  /* Strict resolution of the 2040 June event from the block alone. */
  var naive = Date.UTC(2040, 5, 15, 10, 0, 0);
  assert.eq(resolveWithComponents(comps, naive), Date.UTC(2040, 5, 15, 14, 0, 0),
    'the 2040 June event must land on EDT (-0400), not the truncated EST offset');
});

test('VTIMEZONE: offsets still resolve when Intl longOffset is unsupported', function () {
  var RealDateTimeFormat = Intl.DateTimeFormat;
  var modulePath = require.resolve('../ics.js');

  /* Simulate an engine without the 'longOffset' timeZoneName (its constructor
   * throws a RangeError). Rebuild the module so its per-zone formatter caches
   * start empty, and keep the hostile Intl in place while it renders. */
  function LongOffsetHostile(locale, options) {
    if (options && options.timeZoneName === 'longOffset') {
      throw new RangeError('timeZoneName "longOffset" is not supported');
    }
    return new RealDateTimeFormat(locale, options);
  }

  Intl.DateTimeFormat = LongOffsetHostile;
  try {
    delete require.cache[modulePath];
    var FallbackICS = require('../ics.js');
    var cal = new FallbackICS.Calendar();
    cal.addEvent({
      title: 'NY',
      start: new Date('2026-07-15T14:00:00Z'),
      durationMinutes: 60,
      timezone: 'America/New_York'
    });
    cal.includeVtimezone = true;

    var comps = vtimezoneComponents(cal.toString());
    var byStart = {};
    comps.forEach(function (c) { byStart[c.props.DTSTART] = c; });

    assert.ok(byStart['20260308T020000'], 'spring-forward onset must survive the fallback');
    assert.eq(byStart['20260308T020000'].props.TZOFFSETFROM, '-0500');
    assert.eq(byStart['20260308T020000'].props.TZOFFSETTO, '-0400');
    assert.ok(byStart['20261101T020000'], 'fall-back onset must survive the fallback');
    assert.eq(byStart['20261101T020000'].props.TZOFFSETFROM, '-0400');
    assert.eq(byStart['20261101T020000'].props.TZOFFSETTO, '-0500');

    /* Block-only resolution still reaches the true UTC instant. */
    var naive = Date.UTC(2026, 6, 15, 10, 0, 0);
    assert.eq(resolveWithComponents(comps, naive), Date.UTC(2026, 6, 15, 14, 0, 0),
      'the wall-clock fallback must yield the same offset as longOffset');
  } finally {
    Intl.DateTimeFormat = RealDateTimeFormat;
    delete require.cache[modulePath];
    require('../ics.js'); /* restore the shared module instance in the cache */
  }
});
