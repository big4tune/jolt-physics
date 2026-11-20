import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import process from 'node:process';

const root = process.cwd();
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4173'], { cwd: root, stdio: 'ignore' });
const errors = [];
let browser;
try {
  const deadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < deadline) {
    try { await fetch('http://127.0.0.1:4173'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  assert.ok(ready, 'Vite did not start');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:4173/?test=1', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__ragdollTest || !!document.querySelector('#error-overlay')?.textContent.trim(), { timeout: 30000 });
  const boot = await page.evaluate(() => ({ api: !!window.__ragdollTest, error: document.querySelector('#error-overlay')?.textContent ?? '' }));
  assert.ok(boot.api, 'Ragdoll boot failed: ' + boot.error + '\n' + errors.join('\n'));
  const initial = await page.evaluate(() => window.__ragdollTest.snapshot());
  assert.equal(initial.parts.length, 19);
  assert.equal(initial.joints.length, 18);
  console.log('RAGDOLL_INITIAL=' + JSON.stringify(initial));

  await page.evaluate(() => { window.__ragdollTest.reset(); window.__ragdollTest.setMuscleStrength(1); });
  const startupTrace = [];
  for (let i = 0; i < 10; i++) {
    const s = await page.evaluate(() => window.__ragdollTest.step(12));
    startupTrace.push({
      time:s.time, mode:s.mode, action:s.action, uprightness:s.uprightness, groundedCount:s.groundedCount,
      pelvisY:s.pelvisY, torsoY:s.torsoY, com:s.com, comVelocity:s.comVelocity, capture:s.capture,
      outsideDistance:s.outsideDistance, stepPlan:s.stepPlan, contacts:s.contacts,
      parts:s.parts.filter(p=>['head','spine_4','pelvis','thigh_L','shin_L','foot_L','thigh_R','shin_R','foot_R'].includes(p.name)).map(p=>({name:p.name,y:p.position[1],vy:p.velocity[1],vz:p.velocity[2],grounded:p.grounded,rotation:p.rotation})),
      joints:s.joints.map(j=>({key:j.key,angle:j.angle,target:j.target,torque:j.torque,activation:j.activation}))
    });
  }
  console.log('STARTUP_TRACE=' + JSON.stringify(startupTrace));

  // Motor-only baseline: leave the anatomical target pose fixed and disable Utility AI decisions.
  await page.evaluate(() => { window.__ragdollTest.reset(); window.__ragdollTest.setBalanceAIEnabled(false); });
  const motorOnlyTrace = [];
  for (let i = 0; i < 10; i++) {
    const s = await page.evaluate(() => window.__ragdollTest.step(12));
    motorOnlyTrace.push({
      time:s.time, uprightness:s.uprightness, pelvisY:s.pelvisY, torsoY:s.torsoY,
      com:s.com, comVelocity:s.comVelocity, groundedCount:s.groundedCount,
      action:s.action, torque:s.torque,
      joints:s.joints.map(j=>({key:j.key,type:j.type,angle:j.angle,target:j.target,torque:j.torque,requested:j.requestedTorque,relativeErrorRad:j.relativeErrorRad,activation:j.activation}))
    });
  }
  console.log('MOTOR_ONLY_TRACE=' + JSON.stringify(motorOnlyTrace));

  // A/B damping-only experiment: same initial pose, muscles, physics and no Utility AI; Kd is 30%.
  const lowDampingPage = await browser.newPage();
  lowDampingPage.on('pageerror', e => errors.push(String(e)));
  lowDampingPage.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await lowDampingPage.goto('http://127.0.0.1:4173/?test=1&low-damping=1', { waitUntil: 'networkidle' });
  await lowDampingPage.waitForFunction(() => !!window.__ragdollTest, { timeout: 30000 });
  await lowDampingPage.evaluate(() => {
    window.__ragdollTest.setBalanceAIEnabled(false);
    window.__ragdollTest.setMuscleStrength(1);
  });
  const lowDampingTrace = [];
  for (let i = 0; i < 10; i++) {
    const s = await lowDampingPage.evaluate(() => window.__ragdollTest.step(12));
    lowDampingTrace.push({
      time:s.time, uprightness:s.uprightness, pelvisY:s.pelvisY, torsoY:s.torsoY,
      comVelocity:s.comVelocity, groundedCount:s.groundedCount,
      torque:s.torque,
      joints:s.joints.map(j=>({
        key:j.key,angle:j.angle,target:j.target,requested:j.requestedTorque,applied:j.torque,
        spring:j.springTorque,damping:j.dampingTorque,error:j.orientationErrorAngle,
        angularSpeed:j.relativeAngularSpeed,activation:j.activation
      }))
    });
  }
  console.log('LOW_DAMPING_TRACE=' + JSON.stringify(lowDampingTrace));
  await lowDampingPage.close();

  // A/B diagnostic: reverse the sign of every PD torque to validate actuator convention.
  const reversePage = await browser.newPage();
  reversePage.on('pageerror', e => errors.push(String(e)));
  reversePage.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await reversePage.goto('http://127.0.0.1:4173/?test=1&reverse-muscle-torque=1', { waitUntil: 'networkidle' });
  await reversePage.waitForFunction(() => !!window.__ragdollTest, { timeout: 30000 });
  const reverseTrace = [];
  for (let i = 0; i < 10; i++) {
    const s = await reversePage.evaluate(() => window.__ragdollTest.step(12));
    reverseTrace.push({
      time:s.time, uprightness:s.uprightness, pelvisY:s.pelvisY, torsoY:s.torsoY,
      com:s.com, comVelocity:s.comVelocity, groundedCount:s.groundedCount,
      action:s.action, torque:s.torque
    });
  }
  console.log('REVERSE_TORQUE_TRACE=' + JSON.stringify(reverseTrace));
  await reversePage.close();

  // A/B isolate: same initial pose and controller, all self-collision pairs disabled.
  const noCollisionPage = await browser.newPage();
  noCollisionPage.on('pageerror', e => errors.push(String(e)));
  noCollisionPage.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await noCollisionPage.goto('http://127.0.0.1:4173/?test=1&no-self-collision=1', { waitUntil: 'networkidle' });
  await noCollisionPage.waitForFunction(() => !!window.__ragdollTest, { timeout: 30000 });
  const noCollisionInitial = await noCollisionPage.evaluate(() => window.__ragdollTest.snapshot());
  const noCollisionTrace = [];
  for (let i = 0; i < 10; i++) {
    const s = await noCollisionPage.evaluate(() => window.__ragdollTest.step(12));
    noCollisionTrace.push({
      time:s.time, uprightness:s.uprightness, pelvisY:s.pelvisY, torsoY:s.torsoY,
      com:s.com, comVelocity:s.comVelocity, groundedFeet:s.contacts?.groundedFeet,
      selfPairs:s.contacts?.selfPairs, selfContactEvents:s.contacts?.events,
      action:s.action, stepPlan:s.stepPlan
    });
  }
  console.log('NO_SELF_COLLISION_INITIAL=' + JSON.stringify(noCollisionInitial));
  console.log('NO_SELF_COLLISION_TRACE=' + JSON.stringify(noCollisionTrace));
  await noCollisionPage.close();

  const pairs = await page.evaluate(() => ({
    footShin: window.__ragdollTest.collisionFilterEnabled(0,1),
    footHead: window.__ragdollTest.collisionFilterEnabled(0,12),
    upperArmSpine: window.__ragdollTest.collisionFilterEnabled(13,9),
    thighOppositeFoot: window.__ragdollTest.collisionFilterEnabled(2,3)
  }));
  console.log('COLLISION_FILTERS=' + JSON.stringify({filters:pairs,contacts:(await page.evaluate(()=>window.__ragdollTest.snapshot().contacts))}));

  const muscle = [];
  for (const strength of [0, 0.5, 1, 1.6]) {
    const s = await page.evaluate(async v => { window.__ragdollTest.reset(); window.__ragdollTest.setMuscleStrength(v); return window.__ragdollTest.step(180); }, strength);
    muscle.push({ strength, torque:s.torque, pelvisY:s.pelvisY, mode:s.mode, action:s.action, uprightness:s.uprightness });
  }
  console.log('MUSCLE_SWEEP=' + JSON.stringify(muscle));

  const stability = [];
  for (const strength of [0.5, 1, 1.6]) {
    await page.evaluate(v => { window.__ragdollTest.reset(); window.__ragdollTest.setMuscleStrength(v); }, strength);
    let state = await page.evaluate(() => window.__ragdollTest.snapshot());
    let fallTime = null;
    for (let elapsed = 0; elapsed < 1800; elapsed += 60) {
      state = await page.evaluate(() => window.__ragdollTest.step(60));
      if (fallTime === null && (state.pelvisY < 0.9 || state.uprightness < 0.65)) fallTime = state.time;
    }
    stability.push({strength,fallTime,final:{time:state.time,mode:state.mode,action:state.action,pelvisY:state.pelvisY,torsoY:state.torsoY,uprightness:state.uprightness,groundedCount:state.groundedCount,com:state.com,comVelocity:state.comVelocity,stepPlan:state.stepPlan,aiScores:state.aiScores,contacts:state.contacts},maxAppliedTorque:state.torque.maxApplied});
  }
  console.log('STABILITY_30S=' + JSON.stringify(stability));

  await page.evaluate(() => { window.__ragdollTest.reset(); window.__ragdollTest.setMuscleStrength(1); window.__ragdollTest.applyImpulse('spine_4', 0, 0, -8); });
  const recovery=[];
  for (let i=0;i<12;i++) {
    const s=await page.evaluate(()=>window.__ragdollTest.step(60));
    recovery.push({time:s.time,mode:s.mode,action:s.action,pelvisY:s.pelvisY,groundedCount:s.groundedCount,knees:s.joints.filter(j=>j.key.includes('shin_')).map(j=>j.angle),stepPlan:s.stepPlan,torque:s.torque.maxApplied});
  }
  console.log('RECOVERY_12S=' + JSON.stringify(recovery));

  const final = await page.evaluate(() => window.__ragdollTest.snapshot());
  const hingeViolations = final.joints.filter(j => j.type === 'hinge' && (j.angle < j.min - 0.14 || j.angle > j.max + 0.14));
  console.log('FINAL=' + JSON.stringify({errors,hingeViolations}));
  assert.equal(hingeViolations.length,0,'Hinge joint exceeded hard limits');
  assert.equal(errors.length,0,'Browser errors: ' + errors.join('\n'));
  console.log('PASS: real Jolt WASM + actual Three.js ragdoll ran in headless Chromium');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
