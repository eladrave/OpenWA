'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const patcher = require('./patch-extract-zip-symlink.js');

test('patches the exact vulnerable symlink block and is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-zip-patch-'));
  const file = path.join(root, 'index.js');
  fs.writeFileSync(file, `prefix\n${patcher.before}\nsuffix\n`);
  assert.equal(patcher.patch(file), 'patched');
  const patched = fs.readFileSync(file, 'utf8');
  assert.match(patched, /path\.isAbsolute\(link\)/);
  assert.match(patched, /relativeLinkTarget\.split\(path\.sep\)\.includes\('\.\.'\)/);
  assert.doesNotMatch(patched, /debug\('creating symlink', link, dest\)/);
  assert.equal(patcher.patch(file), 'already-patched');
});

test('refuses dependency drift instead of pretending to patch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-zip-drift-'));
  const file = path.join(root, 'index.js');
  fs.writeFileSync(file, 'unknown shape\n');
  assert.throws(() => patcher.patch(file), /shape changed/);
});
