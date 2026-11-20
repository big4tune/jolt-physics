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
    window.__lowerBodyTest.setWorldTargetMode('hip', config.worldTargets?.hip ?? false);
    window.__lowerBodyTest.setWorldTargetMode('ankle', config.worldTargets?.ankle ?? false);
    window.__lowerBodyTest.setJointTorqueScale('hip', config.scales?.hip ?? 1);
    window.__lowerBodyTest.setJointTorqueScale('knee', config.scales?.knee ?? 1);
    window.__lowerBodyTest.setJointTorqueScale('ankle', config.scales?.ankle ?? 1);
    window.__lowerBodyTest.setJointTorqueSign('hip', config.signs?.hip ?? 1);
    window.__lowerBodyTest.setJointTorqueSign('knee', config.signs?.knee ?? 1);
    window.__lowerBodyTest.setJointTorqueSign('ankle', config.signs?.ankle ?? 1);
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
  const anchorError = await page.evaluate(() => window.__lowerBodyAnchorError);
  assert.ok(Number.isFinite(anchorError), 'Anchor validation must run');

  const startupTrace = await page.evaluate(() => {
    window.__lowerBodyTest.reset();
    window.__lowerBodyTest.setMuscleStrength(1);
    window.__lowerBodyTest.setStiffness(1);
    const rows = [];
    let state = null;
    for (let i = 0; i < 90; i += 6) {
      state = window.__lowerBodyTest.step(6);
      rows.push({
        time: state.time,
        pelvisY: state.pelvisY,
        pelvisUp: state.pelvisUp,
        com: state.com,
        comVelocity: state.comVelocity,
        feet: state.feet,
        selfContacts: state.selfContacts,
        contactEvents: state.contactEvents,
        torque: state.torque,
        parts: state.parts,
        joints: state.joints
      });
    }
    return rows;
  });

  const passive = await runScenario(page, { strength: 0, stiffness: 1, duration: 5 });
  const baseline = await runScenario(page, { strength: 1, stiffness: 1, duration: 30 });
  const stronger = await runScenario(page, { strength: 1.6, stiffness: 1, duration: 20 });
  const hipDisabled = await runScenario(page, { strength: 1, stiffness: 1, duration: 4, scales: { hip: 0, knee: 1, ankle: 1 } });
  const kneeDisabled = await runScenario(page, { strength: 1, stiffness: 1, duration: 4, scales: { hip: 1, knee: 0, ankle: 1 } });
  const ankleDisabled = await runScenario(page, { strength: 1, stiffness: 1, duration: 4, scales: { hip: 1, knee: 1, ankle: 0 } });
  const hipWorldTarget = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, worldTargets: { hip: true, ankle: false } });
  const ankleWorldTarget = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, worldTargets: { hip: false, ankle: true } });
  const hipAnkleWorldTarget = await runScenario(page, { strength: 1, stiffness: 1, duration: 15, worldTargets: { hip: true, ankle: true } });
  const hipWorldTargetReversed = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, worldTargets: { hip: true }, signs: { hip: -1, knee: 1, ankle: 1 } });
  const ankleWorldTargetReversed = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, worldTargets: { ankle: true }, signs: { hip: 1, knee: 1, ankle: -1 } });
  const hipAnkleWorldTargetReversedHip = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, worldTargets: { hip: true, ankle: true }, signs: { hip: -1, knee: 1, ankle: 1 } });
  const hipAnkleWorldTargetReversedBoth = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, worldTargets: { hip: true, ankle: true }, signs: { hip: -1, knee: 1, ankle: -1 } });
  const impulse = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, impulse: [0, 0, 0.8] });

  const finalStates = [passive.final, baseline.final, stronger.final, hipDisabled.final, kneeDisabled.final, ankleDisabled.final, hipWorldTarget.final, ankleWorldTarget.final, hipAnkleWorldTarget.final, hipWorldTargetReversed.final, ankleWorldTargetReversed.final, hipAnkleWorldTargetReversedHip.final, hipAnkleWorldTargetReversedBoth.final, impulse.final];
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
    startupTrace: startupTrace,
    scenarios: {
      passive5s: passive,
      baseline30s: baseline,
      strength160_20s: stronger,
      hipDisabled4s: hipDisabled,
      kneeDisabled4s: kneeDisabled,
      ankleDisabled4s: ankleDisabled,
      hipWorldTarget8s: hipWorldTarget,
      ankleWorldTarget8s: ankleWorldTarget,
      hipAnkleWorldTarget15s: hipAnkleWorldTarget,
      hipWorldTargetReversed8s: hipWorldTargetReversed,
      ankleWorldTargetReversed8s: ankleWorldTargetReversed,
      hipAnkleWorldTargetReversedHip8s: hipAnkleWorldTargetReversedHip,
      hipAnkleWorldTargetReversedBoth8s: hipAnkleWorldTargetReversedBoth,
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