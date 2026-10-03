#!/usr/bin/env node
/*!
 * v2/tests/run.js — a tiny, zero-dependency test runner for the v2 preview.
 *
 * Discovers every `*.test.js` file next to this script, registers each test
 * through the global `test(name, fn)` API, and exposes a small `assert` helper
 * object (ok / eq / deep / includes / throws / match / notOk) that approximates
 * the parts of `node:assert` these tests need.
 *
 * Usage (from the repo root):
 *   node v2/tests/run.js [--verbose]
 *
 * Prints one line per failure (file + test name + error) and a final
 * "N passed, M failed" summary. Exits with code 1 when anything failed.
 *
 * No npm dependencies, no files outside v2/tests/.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');

var isDeepStrictEqual = util.isDeepStrictEqual;

/* ---------- assert helpers ---------- */

/* Render a value compactly for failure messages. */
function display(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return '[function ' + (value.name || 'anonymous') + ']';
  try {
    var json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch (e) {
    return String(value);
  }
}

function fail(message) {
  throw new Error(message);
}

var assert = {
  ok: function (value, message) {
    if (!value) fail(message || 'expected a truthy value, got ' + display(value));
  },

  notOk: function (value, message) {
    if (value) fail(message || 'expected a falsy value, got ' + display(value));
  },

  /* Strict equality, with Object.is semantics (like node:assert.strictEqual). */
  eq: function (actual, expected, message) {
    if (!Object.is(actual, expected)) {
      fail((message ? message + ': ' : '') + 'expected ' + display(expected) + ' but got ' + display(actual));
    }
  },

  /* Deep strict equality (like node:assert.deepStrictEqual). */
  deep: function (actual, expected, message) {
    if (!isDeepStrictEqual(actual, expected)) {
      fail(
        (message ? message + ': ' : '') +
          'expected ' + display(expected) + ' but got ' + display(actual)
      );
    }
  },

  /* Substring for strings, membership for arrays, or Array.prototype.includes. */
  includes: function (haystack, needle, message) {
    var found = false;
    if (typeof haystack === 'string') {
      found = haystack.indexOf(needle) !== -1;
    } else if (Array.isArray(haystack)) {
      found = haystack.some(function (item) { return isDeepStrictEqual(item, needle); });
    } else if (haystack && typeof haystack.includes === 'function') {
      found = haystack.includes(needle);
    }
    if (!found) {
      fail(
        (message ? message + ': ' : '') +
          'expected ' + display(haystack) + ' to include ' + display(needle)
      );
    }
  },

  match: function (value, pattern, message) {
    if (!(pattern instanceof RegExp)) pattern = new RegExp(pattern);
    if (!pattern.test(String(value))) {
      fail(
        (message ? message + ': ' : '') +
          'expected ' + display(value) + ' to match ' + pattern
      );
    }
  },

  /*
   * assert.throws(fn[, expected][, message])
   * `expected` may be a RegExp (tested against the message), a string
   * (substring of the message), or an Error constructor. Returns the error.
   */
  throws: function (fn, expected, message) {
    var error = null;
    try {
      fn();
    } catch (e) {
      error = e;
    }
    if (!error) {
      fail((message ? message + ': ' : '') + 'expected the function to throw, but it did not');
    }
    var text = String((error && error.message) || error);
    if (expected instanceof RegExp) {
      if (!expected.test(text)) {
        fail(
          (message ? message + ': ' : '') +
            'expected the error message ' + display(text) + ' to match ' + expected
        );
      }
    } else if (typeof expected === 'string') {
      if (text.indexOf(expected) === -1) {
        fail(
          (message ? message + ': ' : '') +
            'expected the error message ' + display(text) + ' to contain ' + display(expected)
        );
      }
    } else if (typeof expected === 'function') {
      if (!(error instanceof expected)) {
        fail(
          (message ? message + ': ' : '') +
            'expected a ' + (expected.name || 'Error') + ' but got ' + display(text)
        );
      }
    }
    return error;
  }
};

/* ---------- registration API ---------- */

var tests = [];
var currentFile = '(unknown)';

global.test = function test(name, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('test(' + display(name) + ') needs a function');
  }
  tests.push({ file: currentFile, name: name, fn: fn });
};

global.assert = assert;

/* ---------- discovery ---------- */

var verbose = process.argv.indexOf('--verbose') !== -1 || process.argv.indexOf('-v') !== -1;
var dir = __dirname;
var repoRoot = path.resolve(dir, '..', '..');

var files = fs
  .readdirSync(dir)
  .filter(function (name) { return /\.test\.js$/.test(name); })
  .sort();

files.forEach(function (name) {
  var full = path.join(dir, name);
  currentFile = path.relative(repoRoot, full);
  try {
    require(full);
  } catch (err) {
    /* A file that throws while loading is reported as a single failed test. */
    tests.push({
      file: currentFile,
      name: '(module load)',
      fn: function () { throw err; }
    });
  }
});

/* ---------- run ---------- */

function oneLine(err) {
  var text = String((err && err.message) || err);
  return text.replace(/\s*\r?\n\s*/g, ' | ');
}

(async function main() {
  var passed = 0;
  var failed = 0;

  if (!files.length) {
    console.log('No *.test.js files found in ' + path.relative(repoRoot, dir) + '.');
    process.exitCode = 1;
    return;
  }

  for (var i = 0; i < tests.length; i++) {
    var t = tests[i];
    try {
      await t.fn();
      passed++;
      if (verbose) console.log('ok   ' + t.file + ' :: ' + t.name);
    } catch (err) {
      failed++;
      console.log('FAIL ' + t.file + ' :: ' + t.name + ' — ' + oneLine(err));
    }
  }

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
