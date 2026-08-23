#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', 'extract-zip', 'index.js');
const before = `    if (symlink) {
      const link = await getStream(readStream)
      debug('creating symlink', link, dest)
      await fs.symlink(link, dest)
    } else {`;
const after = `    if (symlink) {
      const link = String(await getStream(readStream))
      const canonicalLinkTarget = path.resolve(path.dirname(dest), link)
      const relativeLinkTarget = path.relative(this.opts.dir, canonicalLinkTarget)
      if (path.isAbsolute(link) || relativeLinkTarget.split(path.sep).includes('..')) {
        throw new Error(\`Out of bound symlink target found while processing \${entry.fileName}\`)
      }
      debug('creating validated symlink', dest)
      await fs.symlink(link, dest)
    } else {`;
const marker = 'const canonicalLinkTarget = path.resolve(path.dirname(dest), link)';

function patch(file = target) {
  if (!fs.existsSync(file)) return 'absent';
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(marker)) return 'already-patched';
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) throw new Error(`extract-zip symlink shape changed (found ${occurrences} target blocks)`);
  fs.writeFileSync(file, source.replace(before, after));
  return 'patched';
}

if (require.main === module) {
  try {
    const result = patch();
    if (result === 'patched') console.log('patch-extract-zip-symlink: applied');
    else if (result === 'already-patched') console.log('patch-extract-zip-symlink: already applied');
    else console.log('patch-extract-zip-symlink: extract-zip absent, skipped');
  } catch (error) {
    console.error(`patch-extract-zip-symlink: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { patch, before, after, marker, target };
