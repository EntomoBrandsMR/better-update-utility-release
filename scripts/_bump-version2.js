// Generic UTF-8-safe version bump: node scripts/_bump-version.js <from> <to>
const fs = require('fs'); const path = require('path');
const [from, to] = process.argv.slice(2);
if (!from || !to) { console.error('usage: node scripts/_bump-version.js <from> <to>'); process.exit(1); }
const esc = from.replace(/\./g, '\\.');
const mainP = path.join(__dirname, '..', 'src', 'main.js');
let m = fs.readFileSync(mainP, 'utf8');
if (!new RegExp("const CURRENT_VERSION = '" + esc + "';").test(m)) { console.error('FAIL: main.js not at ' + from); process.exit(1); }
m = m.replace(new RegExp("const CURRENT_VERSION = '" + esc + "';"), "const CURRENT_VERSION = '" + to + "';");
fs.writeFileSync(mainP, m, 'utf8');
const pkgP = path.join(__dirname, '..', 'package.json');
let p = fs.readFileSync(pkgP, 'utf8');
if (!p.includes('"version": "' + from + '"')) { console.error('FAIL: package.json not at ' + from); process.exit(1); }
p = p.replace('"version": "' + from + '"', '"version": "' + to + '"');
fs.writeFileSync(pkgP, p, 'utf8');
console.log('OK', from, '->', to, '(main.js + package.json)');
