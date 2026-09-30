'use strict';

// Writes the update manifest next to the installers: the version, and each
// file's sha512 and size. The app's update check (src/main/updates.js)
// downloads it with the update and refuses a file that doesn't match. Run by
// the release workflow:
//
//   node packaging/latest-yml.js --version 0.2.1 --installer dist/Loupe-Setup-x64.exe
//   node packaging/latest-yml.js --version 0.2.1 --installer dist/Loupe-arm64.dmg \
//     --installer dist/Loupe-x64.dmg --out dist/latest-mac.yml
//
// It writes <first installer's folder>/latest.yml, or --out <file>.

const fs = require('node:fs');
const path = require('node:path');
const { formatLatestYml, parseLatestYml, parseVersion, sha512OfFile } = require('../src/main/updates');

// --installer may be given more than once.
function args(argv) {
  const out = { installer: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'installer') out.installer.push(argv[i + 1]);
    else out[key] = argv[i + 1];
  }
  return out;
}

async function writeLatestYml({ version, installer, out, now = new Date() }) {
  if (!parseVersion(version)) throw new Error(`Not a version: ${JSON.stringify(version)}`);
  const installers = [installer].flat();
  if (!installers.length) throw new Error('No --installer given');
  const files = [];
  for (const file of installers) {
    files.push({ file: path.basename(file), sha512: await sha512OfFile(file), size: fs.statSync(file).size });
  }
  const text = formatLatestYml({ version, files, releaseDate: now.toISOString() });
  // Read back through the app's own parser, so a format slip fails the
  // release instead of every user's update check.
  const check = parseLatestYml(text);
  if (check.version !== version || check.files.length !== files.length
    || check.files.some((f, i) => f.url !== files[i].file || f.sha512 !== files[i].sha512 || f.size !== files[i].size)) {
    throw new Error('The manifest did not read back correctly');
  }
  const target = out ?? path.join(path.dirname(installers[0]), 'latest.yml');
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
