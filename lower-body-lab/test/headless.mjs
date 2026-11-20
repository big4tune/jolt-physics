import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import process from 'node:process';
import fs from 'node:fs';

const root = process.cwd();
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4180'], {
  cwd: root,
  stdio: 'ignore'
});

const errors = [];
let browser;

async function openLab() {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:4180/?test=1', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__lowerBodyTest || !!document.querySelector('#error-overlay')?.textContent.trim(), {
    timeout: 30000
  });
  const boot = await page.evaluate(() => ({
    api: !!window.__lowerBodyTest,
    error: document.querySelector('#error-overlay')?.textContent || ''
  }));
  assert.ok(boot.api, 'Lower-body lab boot failed: ' + boot.error + '\n' + errors.join('\n'));
  return page;
}

async function runScenario(page, options) {
  await page.evaluate(config => {
    window.__lowerBodyTest.reset();
    window.__lowerBodyTest.setMuscleStrength(config.strength);
    window.__lowerBodyTest.setStiffness(config.stiffness);
    if (config.impulse) {
      window.__lowerBodyTest.applyImpulse('pelvis', config.impulse[0], config.impulse[1], config.impulse[2]);
    }
  }, options);

  return page.evaluate(config => {
    const samples = [];
    let state = null;
    const chunks = Math.ceil(config.duration / 0.5);
    for (let i = 0; i < chunks; i += 1) {
      state = window.__lowerBodyTest.step(30);
      if (i % Math.max(1, Math.floor(chunks / 12)) === 0) {
        samples.push({
          time: state.time,
          pelvisY: state.pelvisY,
          pelvisUp: state.pelvisUp,
          com: state.com,
          comVelocity: state.comVelocity,
          groundedFeet: state.groundedFeet,
          knees: state.joints.filter(j => j.type === 'knee').map(j => ({
            key: j.key,
            angle: j.angle,
            appliedTorque: j.appliedTorque
          })),
          torque: state.torque
        });
      }
    }
    return { final: state, samples };
  }, options);
}

try {
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      await fetch('http://127.0.0.1:4180');
      ready = true;
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  assert.ok(ready, 'Vite did not start');

  browser = await chromium.launch({ headless: true });
  const page = await openLab();

  const initial = await page.evaluate(() => window.__lowerBodyTest.snapshot());
  assert.equal(initial.parts.length, 7, 'Expected exactly 7 rigid bodies');
  assert.equal(initial.joints.length, 6, 'Expected exactly 6 joints');
  assert.ok(Number.isFinite(initial.pelvisY), 'Initial pelvis height must be finite');
  assert.ok(window.__lowerBodyAnchorError === undefined || Number.isFinite(window.__lowerBodyAnchorError), 'Anchor validation must run');

  const passive = await runScenario(page, { strength: 0, stiffness: 1, duration: 5 });
  const baseline = await runScenario(page, { strength: 1, stiffness: 1, duration: 30 });
  const stronger = await runScenario(page, { strength: 1.6, stiffness: 1, duration: 20 });
  const impulse = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, impulse: [0, 0, 0.8] });

  const finalStates = [passive.final, baseline.final, stronger.final, impulse.final];
  for (const state of finalStates) {
    assert.ok(Number.isFinite(state.pelvisY), 'Physics returned a non-finite pelvis position');
    assert.ok(state.parts.every(part => part.position.every(Number.isFinite)), 'Physics returned a non-finite body position');
    assert.ok(state.parts.every(part => part.velocity.every(Number.isFinite)), 'Physics returned a non-finite body velocity');
  }

  const report = {
    model: {
      rigidBodies: initial.parts.length,
      joints: initial.joints.length,
      totalMass: initial.totalMass,
      initialPelvisY: initial.pelvisY,
      initialPelvisUp: initial.pelvisUp,
      anchorError: await page.evaluate(() => window.__lowerBodyAnchorError),
      initialParts: initial.parts.map(part => ({
        name: part.name,
        position: part.position
      })),
      initialJoints: initial.joints.map(joint => ({
        key: joint.key,
        type: joint.type,
        angle: joint.angle,
        min: joint.min,
        max: joint.max
      }))
    },
    scenarios: {
      passive5s: passive,
      baseline30s: baseline,
      strength160_20s: stronger,
      pelvisImpulse08_8s: impulse
    },
    browserErrors: errors
  };

  fs.writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log('LOWER_BODY_REPORT=' + JSON.stringify(report));
  assert.equal(errors.length, 0, 'Browser errors: ' + errors.join('\n'));
  console.log('PASS: lower-body-only Jolt WASM scene created and simulated');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}