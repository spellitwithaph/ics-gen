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
