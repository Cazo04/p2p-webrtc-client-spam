const fs = require('fs');
const puppeteer = require('puppeteer');
const { setTimeout: sleep } = require('timers/promises'); // Promise-based timers [web:32]

const CONFIG = {
  videoUrl: 'https://192.168.5.20/video/watch/m-0196eca9-6f61-7387-9eb4-776d2ae1ce6d',
  minDelay: 200, // ms
  maxDelay: 300, // ms
};

const BROWSER_ARGS = [
  '--mute-audio',
  '--disable-setuid-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--ignore-certificate-errors',
];

function stripComments(line) {
  return line.split('//')[0].trim();
}

function parseAction(actionRaw) {
  const s = actionRaw.trim();

  // END
  if (/^END$/i.test(s)) return { type: 'END' };

  // Random delete: -N [a;b]
  // Example: -2 [0;10]
  let m = s.match(/^-(\d+)\s*\[\s*(\d+(?:\.\d+)?)\s*;\s*(\d+(?:\.\d+)?)\s*\]$/);
  if (m) {
    const count = Number(m[1]);
    const windowStartSec = Number(m[2]);
    const windowEndSec = Number(m[3]);
    if (windowEndSec < windowStartSec) throw new Error(`Invalid window: [${windowStartSec};${windowEndSec}]`);
    return { type: 'RANDOM_DELETE', count, windowStartSec, windowEndSec };
  }

  // TIMED_ADD: T - N
  // Example: 1 - 10  => add 10 tabs within 1s
  m = s.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+)$/);
  if (m) {
    const durationSec = Number(m[1]);
    const count = Number(m[2]);
    if (durationSec <= 0) throw new Error(`Invalid duration: ${durationSec}`);
    if (count <= 0) throw new Error(`Invalid count: ${count}`);
    return { type: 'TIMED_ADD', durationSec, count };
  }

  // Add N
  m = s.match(/^(\d+)$/);
  if (m) return { type: 'ADD', count: Number(m[1]) };

  throw new Error(`Unknown action: "${actionRaw}"`);
}

function parseScenario(text) {
  const lines = text.split(/\r?\n/);
  const steps = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComments(lines[i]);
    if (!raw) continue;

    const m = raw.match(/^(\d+(?:\.\d+)?)\s*:\s*(.+)$/);
    if (!m) throw new Error(`Invalid syntax at line ${i + 1}: "${lines[i]}"`);

    steps.push({
      delaySec: Number(m[1]),
      action: parseAction(m[2]),
      lineNo: i + 1,
    });
  }

  return steps;
}

// Build absolute schedule (ms from start) based only on delaySec
function buildSchedule(steps) {
  let t = 0;
  return steps.map((s, idx) => {
    t += s.delaySec * 1000;
    const nextStartMs = idx < steps.length - 1 ? t + steps[idx + 1].delaySec * 1000 : null;
    return { ...s, startMs: t, nextStartMs };
  });
}

async function sleepUntil(targetEpochMs) {
  const now = Date.now();
  const ms = Math.max(0, targetEpochMs - now);
  if (ms > 0) await sleep(ms); // Promise-based delay [web:32]
}

class TabManager {
  constructor(browser) {
    this.browser = browser;
    this.tabs = [];
    this.nextId = 1;
  }

  get count() {
    return this.tabs.length;
  }

  async addOneTab() {
    const id = this.nextId++;
    const page = await this.browser.newPage();
    this.tabs.push({ id, page });

    // Fire-and-forget: open + play
    this.startVideo(page, id).catch(err => {
      console.log(`Tab ${id}: startVideo failed: ${err.message}`);
    });

    console.log(`+ Created Tab ${id} (total=${this.count})`);
  }

  async startVideo(page, id) {
    await page.goto(CONFIG.videoUrl, { waitUntil: 'networkidle2' });

    // const randomDelay = Math.floor(Math.random() * (CONFIG.maxDelay - CONFIG.minDelay + 1)) + CONFIG.minDelay;
    // console.log(`Tab ${id}: Waiting ${randomDelay}ms before interaction`);
    // await page.waitForTimeout(randomDelay);

    await page.bringToFront();
    // await page.waitForTimeout(300);

    await page.waitForSelector('video', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('video')?.play());
    console.log(`Tab ${id}: playing`);
  }

  async closeRandomTabs(n) {
    for (let i = 0; i < n; i++) {
      if (this.count === 0) return;
      const idx = Math.floor(Math.random() * this.count);
      const tab = this.tabs.splice(idx, 1)[0];
      if (!tab) continue;
      try {
        if (!tab.page.isClosed()) await tab.page.close();
      } catch (_) {}
      console.log(`- Closed Tab ${tab.id} (total=${this.count})`);
    }
  }

  async closeAll() {
    const toClose = this.tabs.splice(0);
    await Promise.all(
      toClose.map(async ({ id, page }) => {
        try {
          if (!page.isClosed()) await page.close();
        } catch (_) {}
        console.log(`- Closed Tab ${id}`);
      })
    );
  }
}

async function runScenario(rawSteps) {
  const steps = buildSchedule(rawSteps);
  const scenarioStart = Date.now();

  const browser = await puppeteer.launch({
    headless: false,
    args: BROWSER_ARGS,
  });

  const tm = new TabManager(browser);

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStartEpoch = scenarioStart + step.startMs;
      const nextStepStartEpoch = step.nextStartMs == null ? null : scenarioStart + step.nextStartMs;

      // Wait until the scheduled start time of this step (absolute timeline)
      await sleepUntil(stepStartEpoch);

      const a = step.action;

      if (a.type === 'ADD') {
        for (let k = 0; k < a.count; k++) await tm.addOneTab();
        continue;
      }

      if (a.type === 'TIMED_ADD') {
        const durationMs = a.durationSec * 1000;

        // Hard pre-check against next step start
        if (nextStepStartEpoch != null && stepStartEpoch + durationMs > nextStepStartEpoch) {
          throw new Error(
            `Line ${step.lineNo}: TIMED_ADD duration ${a.durationSec}s exceeds time until next step`
          );
        }

        // Spread N adds evenly in [start, start+duration]
        for (let k = 0; k < a.count; k++) {
          const offset = Math.floor((k * durationMs) / a.count);
          const scheduledAddTime = stepStartEpoch + offset;

          await sleepUntil(scheduledAddTime);

          // Runtime check: if execution already crossed the next step start, fail
          if (nextStepStartEpoch != null && Date.now() > nextStepStartEpoch) {
            throw new Error(`Line ${step.lineNo}: TIMED_ADD overran next step start time`);
          }

          await tm.addOneTab();
        }

        // Ensure end boundary too (optional strictness)
        if (Date.now() > stepStartEpoch + durationMs + 50) {
          throw new Error(`Line ${step.lineNo}: TIMED_ADD could not finish within ${a.durationSec}s`);
        }

        continue;
      }

      if (a.type === 'RANDOM_DELETE') {
        // (giữ nguyên logic cũ)
        const tasks = Array.from({ length: a.count }, async () => {
          const offset =
            a.windowStartSec + Math.random() * (a.windowEndSec - a.windowStartSec);
          await sleep(Math.round(offset * 1000));
          await tm.closeRandomTabs(1);
        });
        await Promise.all(tasks);
        continue;
      }

      if (a.type === 'END') {
        await tm.closeAll();
        break;
      }
    }
  } finally {
    await tm.closeAll().catch(() => {});
    await browser.close();
  }
}

function main() {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error('Usage: node script.js scenario.txt');
    process.exit(1);
  }

  const text = fs.readFileSync(scenarioPath, 'utf8');
  const steps = parseScenario(text);

  return runScenario(steps);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
