'use strict';

// Writes latest.yml next to the Windows installer: the version, and the
// installer's sha512 and size. The app's update check (src/main/updates.js)
// downloads it with the installer and refuses an installer that doesn't
// match. Run by the release workflow's Windows job:
//
//   node packaging/latest-yml.js --version 0.2.1 --installer dist/Loupe-Setup-x64.exe
//
// It writes <installer's folder>/latest.yml, or --out <file>.

const fs = require('node:fs');
const path = require('node:path');
const { formatLatestYml, parseLatestYml, parseVersion, sha512OfFile } = require('../src/main/updates');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

async function writeLatestYml({ version, installer, out, now = new Date() }) {
  if (!parseVersion(version)) throw new Error(`Not a version: ${JSON.stringify(version)}`);
  const stat = fs.statSync(installer);
  const text = formatLatestYml({
    version,
    file: path.basename(installer),
    sha512: await sha512OfFile(installer),
    size: stat.size,
    releaseDate: now.toISOString()
  });
  // Read back through the app's own parser, so a format slip fails the
  // release instead of every user's update check.
  const check = parseLatestYml(text);
  if (check.version !== version || check.files[0]?.size !== stat.size) {
    throw new Error('latest.yml did not read back correctly');
  }
  const target = out ?? path.join(path.dirname(installer), 'latest.yml');
  fs.writeFileSync(target, text);
  return target;
}

if (require.main === module) {
  const { version, installer, out } = args(process.argv.slice(2));
  writeLatestYml({ version, installer, out }).then((file) => {
    console.log(`wrote ${file}`);
    console.log(fs.readFileSync(file, 'utf8'));
  }, (err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { writeLatestYml };
