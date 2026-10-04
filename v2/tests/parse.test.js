/*!
 * v2/tests/parse.test.js — coverage for the v2 copy of the .ics reader (v2/ics-parse.js).
 *
 * Run with: node v2/tests/run.js
 *
 * These tests cover unfolding, quoted/escaped values, every supported DTSTART
 * form, DURATION, VTIMEZONE offsets, categories, alarms, people, warnings,
 * unknown-property capture, and a full generator → parser round trip.
 */
'use strict';

var ICS = require('../ics-parse.js');

/* ics-parse.js extends the generator module, so ICS.parse and ICS.Calendar are
 * both available here. */
var parse = ICS.parse;

function ics(lines) {
  return lines.join('\r\n');
}

/* ---------- availability & priority ---------- */

test('TRANSP and PRIORITY survive generator-parser-generator round trip', function () {
  ['OPAQUE', 'TRANSPARENT'].forEach(function (transp) {
    [1, 9].forEach(function (priority) {
      var cal = new ICS.Calendar();
      cal.addEvent({ title: 'Fields', start: new Date('2026-01-05T10:00:00Z'), transp: transp, priority: priority });
      var ev = parse(cal.toString()).events[0];
      assert.eq(ev.transp, transp);
      assert.eq(ev.priority, priority);
      assert.ok(ev.unsupported.indexOf('TRANSP') === -1);
      assert.ok(ev.unsupported.indexOf('PRIORITY') === -1);
      var rebuilt = new ICS.Calendar();
      rebuilt.addEvent(ev);
      assert.includes(rebuilt.toString(), 'TRANSP:' + transp);
      assert.includes(rebuilt.toString(), 'PRIORITY:' + priority);
    });
  });
});

test('absent TRANSP and PRIORITY remain absent in parsed objects', function () {
  var cal = new ICS.Calendar();
  cal.addEvent({ title: 'Minimal', start: new Date('2026-01-05T10:00:00Z') });
  var ev = parse(cal.toString()).events[0];
  assert.ok(!Object.prototype.hasOwnProperty.call(ev, 'transp'));
  assert.ok(!Object.prototype.hasOwnProperty.call(ev, 'priority'));
});

test('invalid TRANSP and zero or invalid PRIORITY are ignored with warnings', function () {
  ['0', '10', '-1', '1.5', 'garbage'].forEach(function (priority) {
    var result = parse(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Invalid',
      'DTSTART:20260105T100000Z', 'TRANSP:BUSY', 'PRIORITY:' + priority,
      'END:VEVENT', 'END:VCALENDAR']));
    var ev = result.events[0];
    assert.ok(!Object.prototype.hasOwnProperty.call(ev, 'transp'));
    assert.ok(!Object.prototype.hasOwnProperty.call(ev, 'priority'));
    assert.includes(result.warnings, 'Ignored an unreadable TRANSP value.');
    assert.includes(result.warnings, 'Ignored an unreadable PRIORITY value.');
  });
});

test('lowercase transparent parses to TRANSPARENT and a valid priority has no warning', function () {
  var result = parse(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Valid',
    'DTSTART:20260105T100000Z', 'TRANSP:transparent', 'PRIORITY:9',
    'END:VEVENT', 'END:VCALENDAR']));
  var ev = result.events[0];
  assert.eq(ev.transp, 'TRANSPARENT');
  assert.eq(ev.priority, 9);
  assert.eq(result.warnings.length, 0);
});

test("priority '09' is rejected with a warning", function () {
  var result = parse(ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Leading zero',
    'DTSTART:20260105T100000Z', 'PRIORITY:09',
    'END:VEVENT', 'END:VCALENDAR']));
  var ev = result.events[0];
  assert.ok(!Object.prototype.hasOwnProperty.call(ev, 'priority'));
  assert.includes(result.warnings, 'Ignored an unreadable PRIORITY value.');
});

/* ---------- unfolding & value parsing ---------- */

test('folded continuation lines are unfolded into one logical line', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Hello ',
    ' World',
    'DTSTART:20260105T100000Z',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var ev = parse(text).events[0];
  assert.eq(ev.title, 'Hello World');
});

test('quoted parameter values keep commas intact', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Quoted',
    'DTSTART:20260105T100000Z',
    'ORGANIZER;CN="Doe, John":mailto:john@example.com',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var organizer = parse(text).events[0].organizer;
  assert.eq(organizer.name, 'Doe, John');
  assert.eq(organizer.email, 'john@example.com');
});

test('TEXT values are unescaped', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Unescape',
    'DTSTART:20260105T100000Z',
    'DESCRIPTION:a\\nb\\;c\\,d',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  assert.eq(parse(text).events[0].description, 'a\nb;c,d');
});

/* ---------- DTSTART forms ---------- */

test('DTSTART with a trailing Z is parsed as a UTC instant', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:UTC',
    'DTSTART:20260105T100000Z',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var ev = parse(text).events[0];
  assert.eq(ev.start.toISOString(), '2026-01-05T10:00:00.000Z');
  assert.eq(ev.timezone, 'UTC');
  assert.eq(ev.floating, false);
});

test('floating DTSTART is read as local wall-clock time', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Floating',
    'DTSTART:20260105T100000',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var ev = parse(text).events[0];
  assert.eq(ev.floating, true);
  assert.eq(ev.timezone, null);
  assert.eq(ev.start.getHours(), 10);
  assert.eq(ev.start.getMinutes(), 0);
});

test('DTSTART;TZID= with an IANA zone resolves to the right instant', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:NY',
    'DTSTART;TZID=America/New_York:20260105T100000',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var ev = parse(text).events[0];
  assert.eq(ev.timezone, 'America/New_York');
  assert.eq(ev.start.toISOString(), '2026-01-05T15:00:00.000Z');
});

test('VALUE=DATE DTSTART parses as an all-day event with date parts', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:All day',
    'DTSTART;VALUE=DATE:20260105',
    'DTEND;VALUE=DATE:20260106',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var ev = parse(text).events[0];
  assert.eq(ev.allDay, true);
  assert.deep(ev.start, { year: 2026, month: 1, day: 5 });
  assert.deep(ev.end, { year: 2026, month: 1, day: 6 });
});

test('DURATION supplies the event end when DTEND is absent', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Duration',
    'DTSTART:20260105T100000Z',
    'DURATION:PT90M',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  assert.eq(parse(text).events[0].end.toISOString(), '2026-01-05T11:30:00.000Z');
});

/* ---------- VTIMEZONE fallback ---------- */

test('a VTIMEZONE fixed offset is used when Intl does not know the TZID', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE',
    'TZID:Custom/Zone',
    'BEGIN:STANDARD',
    'TZOFFSETTO:+0530',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Custom',
    'DTSTART;TZID=Custom/Zone:20260105T100000',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var result = parse(text);
  assert.eq(result.events[0].start.toISOString(), '2026-01-05T04:30:00.000Z');
  assert.includes(result.warnings.join('\n'), 'declared UTC offset.');
});

test('an unknown TZID without a VTIMEZONE falls back to floating time', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Mystery',
    'DTSTART;TZID=Not/AZone:20260105T100000',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var result = parse(text);
  assert.eq(result.events[0].floating, true);
  assert.includes(result.warnings.join('\n'), 'treated the time as floating');
});

/* ---------- categories & alarms ---------- */

test('CATEGORIES splits on unescaped commas and keeps escaped commas', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Cats',
    'DTSTART:20260105T100000Z',
    'CATEGORIES:Work,Home\\, Suite',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  assert.deep(parse(text).events[0].categories, ['Work', 'Home, Suite']);
});

test('a DISPLAY VALARM is captured as an alarm with its trigger', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Alarm',
    'DTSTART:20260105T100000Z',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT10M',
    'DESCRIPTION:Remind me',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var result = parse(text);
  assert.deep(result.events[0].alarms, [{ trigger: '-PT10M', description: 'Remind me' }]);
  assert.eq(result.warnings.length, 0);
});

test('a non-DISPLAY alarm is skipped with a warning', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Email alarm',
    'DTSTART:20260105T100000Z',
    'BEGIN:VALARM',
    'ACTION:EMAIL',
    'TRIGGER:-PT10M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var result = parse(text);
  assert.eq(result.events[0].alarms.length, 0);
  assert.includes(result.warnings, 'Skipped a non-DISPLAY (EMAIL) reminder.');
});

/* ---------- people ---------- */

test('ORGANIZER and ATTENDEE parameters round trip through the parser', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:People',
    'DTSTART:20260105T100000Z',
    'ORGANIZER;CN=Pat:mailto:pat@example.com',
    'ATTENDEE;CN=Jane;ROLE=CHAIR;PARTSTAT=DECLINED;RSVP=TRUE:mailto:jane@example.com',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var ev = parse(text).events[0];
  assert.eq(ev.organizer.name, 'Pat');
  assert.eq(ev.organizer.email, 'pat@example.com');
  assert.deep(ev.attendees, [
    { email: 'jane@example.com', name: 'Jane', role: 'CHAIR', status: 'DECLINED', rsvp: true }
  ]);
});

/* ---------- warnings & unknown properties ---------- */

test('malformed content lines produce a warning and are skipped', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Broken',
    'DTSTART:20260105T100000Z',
    'THIS LINE HAS NO COLON',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var result = parse(text);
  assert.includes(result.warnings, 'Skipped an unreadable line.');
  assert.eq(result.events[0].title, 'Broken');
});

test('unknown VEVENT properties are captured in unsupported', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:Custom',
    'DTSTART:20260105T100000Z',
    'X-CUSTOM-THING:foo',
    'X-OTHER:bar',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  assert.deep(parse(text).events[0].unsupported, ['X-CUSTOM-THING', 'X-OTHER']);
});

test('an event with no readable DTSTART is skipped with a warning', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'SUMMARY:No start',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  var result = parse(text);
  assert.eq(result.events.length, 0);
  assert.includes(result.warnings, 'Skipped an event with no readable DTSTART.');
});

/* ---------- document-level behavior ---------- */

test('parse throws when there is no BEGIN:VCALENDAR block', function () {
  assert.throws(function () { parse('hello world'); }, /Not an iCalendar file/);
});

test('parseEvents throws when the document has no VEVENT', function () {
  assert.throws(function () {
    ICS.parseEvents(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR']));
  }, /No VEVENT found/);
});

test('X-WR-CALNAME and X-WR-CALDESC are unescaped into calendar metadata', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'X-WR-CALNAME:My Cal\\, v2',
    'X-WR-CALDESC:Line one\\nLine two',
    'END:VCALENDAR'
  ]);
  var calendar = parse(text).calendar;
  assert.eq(calendar.name, 'My Cal, v2');
  assert.eq(calendar.desc, 'Line one\nLine two');
});

test('counts report vevent, vtimezone and valarm totals', function () {
  var text = ics([
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE',
    'TZID:UTC',
    'BEGIN:STANDARD',
    'TZOFFSETTO:+0000',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:a',
    'SUMMARY:A',
    'DTSTART:20260105T100000Z',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT5M',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b',
    'SUMMARY:B',
    'DTSTART:20260106T100000Z',
    'END:VEVENT',
    'END:VCALENDAR'
  ]);
  assert.deep(parse(text).counts, { vevent: 2, vtimezone: 1, valarm: 1, other: 0 });
});

/* ---------- generator → parser round trip ---------- */

test('a generated calendar round trips through the parser with fields intact', function () {
  var calendar = new ICS.Calendar({ name: 'Round Trip', desc: 'Desc, with; chars' });
  calendar.addEvent({
    title: 'Timed',
    start: new Date('2026-01-15T17:00:00Z'),
    durationMinutes: 60,
    timezone: 'America/New_York',
    categories: ['Work', 'Home, Suite'],
    rrule: 'FREQ=WEEKLY;COUNT=4',
    url: 'https://example.com/agenda',
    organizer: { name: 'Pat', email: 'pat@example.com' },
    attendees: [
      { name: 'Ann', email: 'ann@example.com', role: 'REQ-PARTICIPANT', status: 'ACCEPTED', rsvp: true }
    ],
    alarms: [{ trigger: -15 }]
  });
  calendar.addEvent({ title: 'Holiday', start: { year: 2026, month: 12, day: 25 } });

  var result = parse(calendar.toString());

  assert.eq(result.calendar.name, 'Round Trip');
  assert.eq(result.calendar.desc, 'Desc, with; chars');
  assert.eq(result.events.length, 2);

  var timed = result.events[0];
  assert.eq(timed.title, 'Timed');
  assert.eq(timed.start.toISOString(), '2026-01-15T17:00:00.000Z');
  assert.eq(timed.timezone, 'America/New_York');
  assert.eq(timed.end.toISOString(), '2026-01-15T18:00:00.000Z');
  assert.deep(timed.categories, ['Work', 'Home, Suite']);
  assert.eq(timed.rrule, 'FREQ=WEEKLY;COUNT=4');
  assert.eq(timed.url, 'https://example.com/agenda');
  assert.eq(timed.organizer.name, 'Pat');
  assert.eq(timed.organizer.email, 'pat@example.com');
  assert.deep(timed.attendees, [
    { email: 'ann@example.com', name: 'Ann', role: 'REQ-PARTICIPANT', status: 'ACCEPTED', rsvp: true }
  ]);
  assert.deep(timed.alarms, [{ trigger: '-PT15M', description: 'Timed' }]);

  var holiday = result.events[1];
  assert.eq(holiday.title, 'Holiday');
  assert.eq(holiday.allDay, true);
  assert.deep(holiday.start, { year: 2026, month: 12, day: 25 });
  assert.deep(holiday.end, { year: 2026, month: 12, day: 26 });
});
