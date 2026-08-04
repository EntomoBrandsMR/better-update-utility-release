const { execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const GH = 'gh';
// 1) current SHA of version-buu2.json
const cur = JSON.parse(execFileSync(GH, ['api', 'repos/EntomoBrandsMR/better-update-utility-release/contents/version-buu2.json'], { encoding: 'utf8' }));
// 2) new content (BOM-free)
const body = JSON.stringify({
  version: '3.2.4',
  // The 3.2.x renderer reads `downloadUrl` (index.html doUpdate -> install-update).
  // `url` alone produced "Cannot read properties of undefined (reading 'startsWith')"
  // in downloadFile. Keep both keys so older consumers of `url` also work.
  downloadUrl: 'https://github.com/EntomoBrandsMR/better-update-utility-release/releases/download/v3.2.4/BUU-2.0-Setup-3.2.4.exe',
  url: 'https://github.com/EntomoBrandsMR/better-update-utility-release/releases/download/v3.2.4/BUU-2.0-Setup-3.2.4.exe',
  notes: 'License check only runs for PestPac profiles; fixes permanent no-licenses pause on Fieldwork runs.'
}, null, 2) + '\n';
const b64 = Buffer.from(body, 'utf8').toString('base64');
if (Buffer.from(body, 'utf8')[0] !== 0x7B) { console.error('FAIL: not BOM-free/{'); process.exit(1); }
const payload = { message: 'version-buu2.json -> 3.2.4', content: b64, sha: cur.sha };
const tmp = path.join(os.tmpdir(), 'vpayload.json');
fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
const res = execFileSync(GH, ['api', '--method', 'PUT', 'repos/EntomoBrandsMR/better-update-utility-release/contents/version-buu2.json', '--input', tmp], { encoding: 'utf8' });
console.log('PUT ok:', JSON.parse(res).content.sha);
