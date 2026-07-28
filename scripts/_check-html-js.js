// Extract inline <script> blocks (no src) from index.html and syntax-check each.
const fs = require('fs');
const vm = require('vm');
const p = 'C:\\Users\\Matt Ruckman\\projects\\Better Update Utility\\src\\index.html';
const html = fs.readFileSync(p, 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(html)) !== null) {
  i++;
  const code = m[1];
  if (!code.trim()) continue;
  try {
    new vm.Script(code, { filename: 'inline-script-' + i + '.js' });
    console.log('script #' + i + ' (' + code.length + ' chars): OK');
  } catch (e) {
    bad++;
    console.log('script #' + i + ': SYNTAX ERROR -> ' + e.message);
  }
}
console.log(bad === 0 ? 'ALL_INLINE_SCRIPTS_OK' : ('FAILED: ' + bad + ' block(s) with errors'));
