// UTF-8-safe CURRENT_VERSION bump. PowerShell Get-Content/-replace mangles the em-dashes
// (reads UTF-8 as ANSI); this reads/writes utf8 and touches only the version line.
const fs = require('fs');
const p = require('path').join(__dirname, '..', 'src', 'main.js');
let s = fs.readFileSync(p, 'utf8');
const before = s.length;
s = s.replace(/const CURRENT_VERSION = '3\.2\.3';/, "const CURRENT_VERSION = '3.2.4';");
if (!/const CURRENT_VERSION = '3\.2\.4';/.test(s)) { console.error('FAIL: version line not found/replaced'); process.exit(1); }
fs.writeFileSync(p, s, 'utf8');
console.log('OK bumped, length', before, '->', s.length);
