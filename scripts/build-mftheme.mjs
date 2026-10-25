#!/usr/bin/env node
// Package a MenuForge theme folder into a catalog-ready .mftheme archive.
//
//   node scripts/build-mftheme.mjs <theme-dir> [options]
//
// The theme id is the folder name; the version, display name and description come from the
// folder's package.json (`version`, `menuforge.name`, `menuforge.description`). Prints the
// archive path, its sha256 and a ready-to-paste catalog.json entry.
//
// The archive is checked against the same rules MenuForge's installer enforces
// (packages/server/src/themes/install.js): index.html at the root, no unsafe entry paths.
// The installer also verifies `checksum` against the exact published bytes BEFORE opening
// the zip, so publish the file this script writes, unmodified.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import AdmZip from 'adm-zip';

const THEME_ID_RE = /^[a-z0-9][a-z0-9-]*$/; // catalog.js THEME_ID_RE
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RAW_BASE = 'https://raw.githubusercontent.com/ma-menu-org/menuforge-themes/main/themes';
const DEFAULT_MAX_THEME_BYTES = 25 * 1024 * 1024; // server config.js MF_MAX_THEME_BYTES default
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node scripts/build-mftheme.mjs <theme-dir> [options]

Options:
  --out <dir>                  where to write the archive (default: <repo>/themes)
  --premium                    set "isPremium": true (requires --required-feature-id)
  --required-feature-id <id>   the keyforge-anvil feature id gating the theme (requires --premium)
  --screenshot-url <url>       add "screenshotUrl" to the catalog entry
  --min-menuforge <version>    add "minMenuforgeVersion" (recorded, not enforced, by the server)
  --force                      overwrite an existing archive of the same id + version
  -h, --help                   show this help`;

class BuildError extends Error {}

// Mirrors packages/server/src/lib/safe-path.js `isUnsafeRelPath`.
function isUnsafeRelPath(rel) {
  return (
    !rel ||
    rel.startsWith('/') ||
    /^[A-Za-z]:/.test(rel) ||
    rel.includes('\\') ||
    rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
  );
}

/** Every file under `dir` as a '/'-joined archive path. Rejects symlinks and theme.json. */
function collectFiles(dir, prefix = '', skipped = []) {
  const files = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    const abs = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      throw new BuildError(`Refusing to package a symlink: ${rel}`);
    }
    if (isUnsafeRelPath(rel)) {
      throw new BuildError(`Unsafe path in the theme folder: ${rel}`);
    }
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name) || dirent.name.startsWith('.')) {
        skipped.push(`${rel}/`);
        continue;
      }
      files.push(...collectFiles(abs, rel, skipped).files);
      continue;
    }
    if (!dirent.isFile()) {
      throw new BuildError(`Not a regular file: ${rel}`);
    }
    if (dirent.name === 'theme.json') {
      throw new BuildError(`${rel}: remove it — the installer generates theme.json on install.`);
    }
    if (dirent.name.startsWith('.')) {
      skipped.push(rel);
      continue;
    }
    files.push({ rel, abs });
  }
  return { files, skipped };
}

function readThemeMeta(themeDir) {
  const id = path.basename(themeDir);
  if (!THEME_ID_RE.test(id)) {
    throw new BuildError(`Theme id "${id}" (the folder name) must be lower-kebab-case: ${THEME_ID_RE}`);
  }
  if (!fs.existsSync(path.join(themeDir, 'index.html'))) {
    throw new BuildError(`${themeDir} has no index.html at its root.`);
  }
  const pkgPath = path.join(themeDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new BuildError(`${themeDir} has no package.json (version and display name come from it).`);
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    throw new BuildError(`${pkgPath} is not valid JSON: ${err.message}`);
  }
  if (typeof pkg.version !== 'string' || !VERSION_RE.test(pkg.version)) {
    throw new BuildError(`package.json "version" must be semver (x.y.z), got ${JSON.stringify(pkg.version)}.`);
  }
  const name = pkg.menuforge?.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new BuildError('package.json needs a "menuforge": { "name": … } block (the theme card title).');
  }
  return { id, version: pkg.version, name, description: pkg.menuforge.description ?? '' };
}

/** Re-open the built archive and apply the installer's own checks to it. */
function verifyArchive(bytes) {
  const entries = new AdmZip(bytes).getEntries();
  for (const e of entries) {
    if (!e.isDirectory && isUnsafeRelPath(e.entryName)) {
      throw new BuildError(`Built archive has an unsafe path: ${e.entryName}`);
    }
    if (e.entryName.split('/').pop() === 'theme.json') {
      throw new BuildError('Built archive contains a theme.json.');
    }
  }
  if (!entries.some((e) => !e.isDirectory && e.entryName === 'index.html')) {
    throw new BuildError('Built archive has no index.html at its root.');
  }
  return entries.length;
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      premium: { type: 'boolean', default: false },
      'required-feature-id': { type: 'string' },
      'screenshot-url': { type: 'string' },
      'min-menuforge': { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) {
    throw new BuildError(`Expected exactly one theme folder.\n\n${USAGE}`);
  }

  // A premium flag without a feature id (or the reverse) leaves a theme that looks gated but
  // isn't: the server gates on requiredFeatureId against the live entitlement.
  const requiredFeatureId = values['required-feature-id'] ?? null;
  if (values.premium !== Boolean(requiredFeatureId)) {
    throw new BuildError('--premium and --required-feature-id must be used together.');
  }
  const screenshotUrl = values['screenshot-url'];
  if (screenshotUrl !== undefined && !URL.canParse(screenshotUrl)) {
    throw new BuildError(`--screenshot-url is not a valid URL: ${screenshotUrl}`);
  }

  const themeDir = path.resolve(positionals[0]);
  if (!fs.existsSync(themeDir) || !fs.statSync(themeDir).isDirectory()) {
    throw new BuildError(`Not a folder: ${themeDir}`);
  }
  const meta = readThemeMeta(themeDir);
  const { files, skipped } = collectFiles(themeDir);

  const zip = new AdmZip();
  for (const { rel, abs } of files) {
    zip.addFile(rel, fs.readFileSync(abs));
  }
  const bytes = zip.toBuffer();
  const entryCount = verifyArchive(bytes);

  const fileName = `${meta.id}-${meta.version}.mftheme`;
  const outDir = path.resolve(values.out ?? path.join(repoRoot, 'themes'));
  const outPath = path.join(outDir, fileName);
  if (fs.existsSync(outPath) && !values.force) {
    throw new BuildError(
      `${outPath} already exists. A published archive must not change under its checksum — bump the ` +
        'version, or pass --force if it was never published.',
    );
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, bytes);

  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const entry = {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    version: meta.version,
    ...(screenshotUrl ? { screenshotUrl } : {}),
    downloadUrl: `${RAW_BASE}/${fileName}`,
    checksum,
    isPremium: values.premium,
    requiredFeatureId,
    ...(values['min-menuforge'] ? { minMenuforgeVersion: values['min-menuforge'] } : {}),
  };

  const maxBytes = Number.parseInt(process.env.MF_MAX_THEME_BYTES ?? '', 10) || DEFAULT_MAX_THEME_BYTES;
  console.log(`archive:  ${outPath}`);
  console.log(`size:     ${bytes.byteLength} bytes (${entryCount} entries)`);
  console.log(`sha256:   ${checksum}`);
  if (skipped.length) console.log(`skipped:  ${skipped.join(', ')}`);
  if (bytes.byteLength > maxBytes) {
    console.warn(
      `WARNING: archive is ${bytes.byteLength} bytes, over the ${maxBytes}-byte MF_MAX_THEME_BYTES limit — ` +
        'branches using that limit will refuse to install it (THEME_TOO_LARGE).',
    );
  }
  console.log('\ncatalog.json entry:');
  console.log(JSON.stringify(entry, null, 2));
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof BuildError || err?.code?.startsWith?.('ERR_PARSE_ARGS')) {
    console.error(`build-mftheme: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
