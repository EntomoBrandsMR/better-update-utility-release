// 3.2.5: stamp a real-Chrome userAgent on every newContext() in main.js + coordinator.js.
// (worker.js already patched by hand.) Headless Chromium's default "HeadlessChrome" UA is
// 403-blocked by Fieldwork as of 08/04.
const fs = require('fs');
const ua = "{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }";
for (const f of ['src/main.js', 'src/pool/coordinator.js']) {
  let s = fs.readFileSync(f, 'utf8');
  const n = (s.match(/browser\.newContext\(\)/g) || []).length;
  if (!n) { console.log(f, 'no bare newContext() found'); continue; }
  s = s.split('browser.newContext()').join('browser.newContext(' + ua + ')');
  fs.writeFileSync(f, s, 'utf8');
  console.log(f, 'patched', n, 'site(s)');
}
