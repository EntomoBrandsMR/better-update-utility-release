const { chromium } = require("playwright-core");
const os = require("os");

const EXE = "C:\\Users\\bigma\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe";
const TARGET = parseInt(process.argv[2] || "150");
const ARGS = ["--disable-gpu","--disable-dev-shm-usage","--disable-background-timer-throttling","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"];

function gbFree(){ return os.freemem()/1073741824; }
function gbUsed(){ return (os.totalmem()-os.freemem())/1073741824; }

(async () => {
  const browsers = [];
  const startFree = gbFree();
  console.log(`START: ${gbFree().toFixed(1)} GB free of ${(os.totalmem()/1073741824).toFixed(1)} GB`);
  console.log(`Ramping to ${TARGET} workers (headless chromium + context + page each)...`);
  let launched = 0;
  const t0 = Date.now();
  for (let i = 1; i <= TARGET; i++) {
    try {
      const b = await chromium.launch({ headless: true, executablePath: EXE, args: ARGS });
      const ctx = await b.newContext();
      const pg = await ctx.newPage();
      await pg.goto("about:blank", { timeout: 15000 });
      // load a little DOM to simulate a real page footprint
      await pg.setContent("<html><body>"+"<div>row</div>".repeat(500)+"</body></html>");
      browsers.push(b);
      launched++;
      if (i % 5 === 0 || i <= 5) {
        const freeMB = gbFree();
        console.log(`workers=${i}  free=${freeMB.toFixed(1)}GB  used=${gbUsed().toFixed(1)}GB  perWorker~${((startFree-freeMB)/i*1024).toFixed(0)}MB  loadavg=N/A`);
        if (freeMB < 3) { console.log(`!! FREE RAM under 3GB at ${i} workers ? stopping ramp for safety.`); break; }
      }
    } catch (e) {
      console.log(`!! FAILED to launch worker #${i}: ${e.message.slice(0,80)}`);
      break;
    }
  }
  const secs = ((Date.now()-t0)/1000).toFixed(0);
  console.log(`\n=== RESULT ===`);
  console.log(`launched=${launched} workers in ${secs}s`);
  console.log(`free RAM now: ${gbFree().toFixed(1)}GB  (started ${startFree.toFixed(1)}GB)`);
  console.log(`avg per worker: ${((startFree-gbFree())/launched*1024).toFixed(0)} MB`);
  console.log("closing all...");
  for (const b of browsers) { try { await b.close(); } catch(e){} }
  console.log("done.");
  process.exit(0);
})();
