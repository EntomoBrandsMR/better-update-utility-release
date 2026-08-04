// Reproduce the worker's login environment: bundled chromium, headless, goto fieldwork.
const path = require('path');
const fs = require('fs');
// find bundled chromium the same way main.js does, from the INSTALLED app
const roots = [
  'C:/BUU/resources/app.asar.unpacked/node_modules/playwright-core/.local-browsers',
  path.join(__dirname, '..', 'node_modules', 'playwright-core', '.local-browsers'),
];
let exe = null;
for (const r of roots) {
  try {
    for (const d of fs.readdirSync(r).filter(d => d.startsWith('chromium-'))) {
      const c = path.join(r, d, 'chrome-win', 'chrome.exe');
      if (fs.existsSync(c)) { exe = c; break; }
    }
  } catch (_) {}
  if (exe) break;
}
console.log('chromium:', exe || 'NOT FOUND');
if (!exe) process.exit(1);
(async () => {
  const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));
  const b = await chromium.launch({ headless: true, executablePath: exe, args: ['--disable-gpu','--disable-dev-shm-usage'] });
  const page = await (await b.newContext()).newPage();
  try {
    await page.goto('https://app.fieldworkhq.com/', { waitUntil: 'load', timeout: 30000 });
    console.log('LOADED url:', page.url());
    console.log('title:', await page.title());
    const hasEmail = await page.locator('#email').count();
    console.log('#email count:', hasEmail);
    const body = (await page.content()).slice(0, 600).replace(/\s+/g, ' ');
    console.log('content head:', body);
  } catch (e) {
    console.log('NAV/WAIT ERROR:', e.message.split('\n')[0]);
    try { console.log('url now:', page.url()); console.log('content:', (await page.content()).slice(0, 600).replace(/\s+/g,' ')); } catch(_){}
  }
  await b.close();
})();
