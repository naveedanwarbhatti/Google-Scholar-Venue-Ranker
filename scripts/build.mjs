import fs from 'node:fs/promises';
import path from 'node:path';
import { generateRankingsIndex } from './generate_rankings_index.mjs';

const root = process.cwd();
const srcDir = path.join(root, 'GSVR');
const distDir = path.join(root, 'dist');

// Build inputs and dev tools only; none of these run in the extension.
// rankings.csv (28 MB) feeds the index generator; the compact index ships.
// journal_match.js backs the Node test suite and index generator.
// match_cli.js / venue_accuracy_csv.js are matcher debugging CLIs.
const IGNORE_FILES = new Set([
  'rankings.csv',
  'journal_match.js',
  'match_cli.js',
  'venue_accuracy_csv.js',
]);

// A tiny build step: copy the extension folder to ./dist so it can be loaded
// directly via chrome://extensions (Load unpacked).

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  'tests', // tests are useful in-source, but not needed in the packed extension
  'sjr' // raw SCImago CSVs (~230 MB) feed the index generator; only the compact index ships
]);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const ent of entries) {
    if (ent.isDirectory() && IGNORE_DIRS.has(ent.name)) continue;

    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);

    if (ent.isDirectory()) {
      await copyDir(from, to);
    } else if (ent.isFile()) {
      if (IGNORE_FILES.has(ent.name)) continue;
      await fs.copyFile(from, to);
    }
    // (No symlinks expected in this repo.)
  }
}

if (!(await exists(srcDir))) {
  throw new Error(`Expected extension sources at: ${srcDir}`);
}

const manifestPath = path.join(srcDir, 'manifest.json');
if (!(await exists(manifestPath))) {
  throw new Error(`manifest.json not found at: ${manifestPath}`);
}

const indexResult = await generateRankingsIndex({ root });
await fs.rm(distDir, { recursive: true, force: true });
await copyDir(srcDir, distDir);

console.log('Build complete.');
console.log(`  Source: ${srcDir}`);
console.log(`  Output: ${distDir}`);
console.log(`  Rankings index: ${indexResult.outPath} (${indexResult.sjrCount} SJR entries, ${indexResult.coreYears} CORE years, ${indexResult.venueCount} DBLP venues)`);
console.log('Load the extension from ./dist via chrome://extensions → Load unpacked.');
