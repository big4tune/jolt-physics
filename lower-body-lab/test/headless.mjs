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

async function openLab(query = '') {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:4180/?test=1' + query, { waitUntil: 'networkidle' });
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

async function captureStartup(page, config = {}) {
  await page.evaluate(options => {
    const api = window.__lowerBodyTest;
    api.reset();
    api.setMuscleStrength(options.strength ?? 1);
    api.setStiffness(options.stiffness ?? 1);
    api.setDamping(options.damping ?? 1);
    api.setWorldTargetMode('hip', false);
    api.setWorldTargetMode('ankle', false);
    api.setJointTorqueScale('hip', options.scales?.hip ?? 1);
    api.setJointTorqueScale('knee', options.scales?.knee ?? 1);
    api.setJointTorqueScale('ankle', options.scales?.ankle ?? 1);
    api.setRootUprightController(false, 1, 35, 8, 70);
    if (options.rebase === 'all') api.rebaseJointTargets();
    else if (options.rebase === 'ankle') api.rebaseJointTargets('ankle');
  }, config);

  return page.evaluate(() => {
    const rows = [];
    const initial = window.__lowerBodyTest.snapshot();
    const initialState = {
      pelvisY: initial.pelvisY,
      pelvisUp: initial.pelvisUp,
      comVelocity: initial.comVelocity,
      feet: initial.parts.filter(part => part.name.startsWith('foot_')).map(part => ({
        name: part.name, position: part.position, rotation: part.rotation, velocity: part.velocity
      })),
      shins: initial.parts.filter(part => part.name.startsWith('shin_')).map(part => ({
        name: part.name, position: part.position, rotation: part.rotation, velocity: part.velocity
      })),
      joints: initial.joints.map(joint => ({
        key: joint.key, type: joint.type, measuredError: joint.measuredError,
        parentRotation: joint.parentRotation, childRotation: joint.childRotation,
        targetRelative: joint.targetRelative, currentRelative: joint.currentRelative,
        lastServoInput: joint.lastServoInput
      }))
    };
    for (let frame = 1; frame <= 60; frame += 1) {
      const state = window.__lowerBodyTest.step(1);
      if (frame <= 12 || frame % 3 === 0) {
        const pelvis = state.parts.find(part => part.name === 'pelvis');
        const feet = state.parts.filter(part => part.name.startsWith('foot_'));
        const shins = state.parts.filter(part => part.name.startsWith('shin_'));
        rows.push({
          frame,
          time: state.time,
          pelvisY: state.pelvisY,
          pelvisUp: state.pelvisUp,
          com: state.com,
          comVelocity: state.comVelocity,
          pelvisVelocity: pelvis.velocity,
          pelvisAngularVelocity: pelvis.angularVelocity,
          feet: feet.map(part => ({
            name: part.name,
            position: part.position,
            velocity: part.velocity,
            angularVelocity: part.angularVelocity,
            rotation: part.rotation,
            grounded: part.grounded
          })),
          shins: shins.map(part => ({
            name: part.name,
            position: part.position,
            rotation: part.rotation,
            angularVelocity: part.angularVelocity
          })),
          joints: state.joints.map(joint => ({
            key: joint.key,
            type: joint.type,
            error: joint.error,
            measuredError: joint.measuredError,
            requestedTorque: joint.requestedTorque,
            appliedTorque: joint.appliedTorque,
            lastServoInput: joint.lastServoInput,
            parentRotation: joint.parentRotation,
            childRotation: joint.childRotation,
            targetRelative: joint.targetRelative,
            currentRelative: joint.currentRelative
          })),
          contacts: state.contactEvents,
          selfContacts: state.selfContacts
        });
      }
    }
    return { initial: initialState, samples: rows };
  });
}

async function runScenario(page, options) {
  await page.evaluate(config => {
    window.__lowerBodyTest.reset();
    window.__lowerBodyTest.setMuscleStrength(config.strength);
    window.__lowerBodyTest.setStiffness(config.stiffness);
    window.__lowerBodyTest.setDamping(config.damping ?? 1);
    window.__lowerBodyTest.setWorldTargetMode('hip', config.worldTargets?.hip ?? false);
    window.__lowerBodyTest.setWorldTargetMode('ankle', config.worldTargets?.ankle ?? false);
    window.__lowerBodyTest.setJointTorqueScale('hip', config.scales?.hip ?? 1);
    window.__lowerBodyTest.setJointTorqueScale('knee', config.scales?.knee ?? 1);
    window.__lowerBodyTest.setJointTorqueScale('ankle', config.scales?.ankle ?? 1);
    window.__lowerBodyTest.setJointTorqueSign('hip', config.signs?.hip ?? 1);
    window.__lowerBodyTest.setJointTorqueSign('knee', config.signs?.knee ?? 1);
    window.__lowerBodyTest.setJointTorqueSign('ankle', config.signs?.ankle ?? 1);
    const delayRoot = Number(config.rootUprightDelaySeconds || 0) > 0;
    window.__lowerBodyTest.setRootUprightController(
      !delayRoot && (config.rootUpright?.enabled ?? false),
      config.rootUpright?.sign ?? 1,
      config.rootUpright?.kp ?? 140,
      config.rootUpright?.kd ?? 18,
      config.rootUpright?.maxMoment ?? 240
    );
    if (config.impulse) {
      window.__lowerBodyTest.applyImpulse(config.impulseBody || 'pelvis', config.impulse[0], config.impulse[1], config.impulse[2]);
    }
  }, options);

  return page.evaluate(config => {
    const samples = [];
    let state = null;
    const chunks = Math.ceil(config.duration / 0.5);
    let lateImpulseApplied = false;
    let delayedRootActivated = false;
    for (let i = 0; i < chunks; i += 1) {
      state = window.__lowerBodyTest.step(30);
      if (config.rootUprightDelaySeconds && !delayedRootActivated && state.time >= config.rootUprightDelaySeconds) {
        const root = config.rootUpright || {};
        window.__lowerBodyTest.setRootUprightController(
          root.enabled ?? true,
          root.sign ?? 1,
          root.kp ?? 140,
          root.kd ?? 18,
          root.maxMoment ?? 240
        );
        delayedRootActivated = true;
      }
      if (config.impulseAtSeconds && !lateImpulseApplied && state.time >= config.impulseAtSeconds) {
        const impulse = config.lateImpulse || [0, 0, 0.8];
        window.__lowerBodyTest.applyImpulse(config.impulseBody || 'pelvis', impulse[0], impulse[1], impulse[2]);
        lateImpulseApplied = true;
      }
      if (i % Math.max(1, Math.floor(chunks / 24)) === 0) {
        const pelvis = state.parts.find(part => part.name === 'pelvis');
        samples.push({
          time: state.time,
          pelvisY: state.pelvisY,
          pelvisUp: state.pelvisUp,
          pelvisVelocity: pelvis.velocity,
          pelvisAngularVelocity: pelvis.angularVelocity,
          com: state.com,
          rigCom: state.rigCom,
          comVelocity: state.comVelocity,
          pelvisAngularVelocity: state.parts.find(part => part.name === 'pelvis').angularVelocity,
          dynamicMass: state.dynamicMass,
          rootUpright: state.rootUpright,
          groundedFeet: state.groundedFeet,
          stanceDiagnostics: state.stanceDiagnostics,
          footPlantStates: state.parts.filter(part => part.name.startsWith('foot_')).map(part => ({
            name: part.name,
            grounded: part.grounded,
            plantActive: part.footPlantActive,
            lostContactSubsteps: part.footPlantLostContactSubsteps,
            plantCount: part.footPlantPlantCount,
            releaseCount: part.footPlantReleaseCount,
            footUpDot: part.footUpDot,
            position: part.position,
            rotation: part.rotation,
            velocity: part.velocity
          })),
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

  const startupTrace = await captureStartup(page, { strength: 1 });
  const firstStartupFrame = startupTrace.samples[0];
  const startupMotorErrors = firstStartupFrame.joints
    .filter(joint => joint.type !== 'knee')
    .filter(joint => !joint.lastServoInput
      || joint.lastServoInput.errorAngle > 0.001
      || joint.appliedTorque > 0.1);
  assert.equal(
    startupMotorErrors.length,
    0,
    'Initial pose must not produce non-zero hip/ankle PD torque: ' + JSON.stringify(startupMotorErrors)
  );

  const passiveStartupTrace = await captureStartup(page, { strength: 0 });
  const ankleOnlyStartupTrace = await captureStartup(page, { strength: 1, scales: { hip: 0, knee: 0, ankle: 1 } });
  const kneeOnlyStartupTrace = await captureStartup(page, { strength: 1, scales: { hip: 0, knee: 1, ankle: 0 } });
  const hipOnlyStartupTrace = await captureStartup(page, { strength: 1, scales: { hip: 1, knee: 0, ankle: 0 } });
  const rebasedAnkleStartupTrace = await captureStartup(page, { strength: 1, rebase: 'ankle' });
  const rebasedAllStartupTrace = await captureStartup(page, { strength: 1, rebase: 'all' });
  const rebasedAnkleOnlyStartupTrace = await captureStartup(page, { strength: 1, rebase: 'ankle', scales: { hip: 0, knee: 0, ankle: 1 } });

  const noSelfPage = await openLab('&no-self-collision=1');
  const noSelfStartupTrace = await captureStartup(noSelfPage, { strength: 1 });
  await noSelfPage.close();

  const noFloorPage = await openLab('&no-floor-contact=1');
  const noFloorStartupTrace = await captureStartup(noFloorPage, { strength: 1 });
  await noFloorPage.close();

  const footGapPage = await openLab('&foot-gap=0.025');
  const footGapStartupTrace = await captureStartup(footGapPage, { strength: 1 });
  await footGapPage.close();

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
  const rootUpright15s = await runScenario(page, { strength: 1, stiffness: 1, duration: 15, rootUpright: { enabled: true } });
  const rootUprightReversed8s = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, rootUpright: { enabled: true, sign: -1 } });
  const rootUprightStrong15s = await runScenario(page, { strength: 1, stiffness: 1, duration: 15, rootUpright: { enabled: true, kp: 220, kd: 24 } });
  const rootUprightPlusAnkle15s = await runScenario(page, { strength: 1, stiffness: 1, duration: 15, rootUpright: { enabled: true }, worldTargets: { ankle: true } });
  const impulse = await runScenario(page, { strength: 1, stiffness: 1, duration: 8, impulse: [0, 0, 0.8] });

  const lowGainStartup = await captureStartup(page, { strength: 1, stiffness: 0.25, damping: 0.1 });

  const dynamicFeetRoot35_8_70LowGain = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 35, kd: 8, maxMoment: 70 }
  });
  const dynamicFeetRoot60_12_100LowGain = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 60, kd: 12, maxMoment: 100 }
  });
  const dynamicFeetRoot90_18_140LowGain = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 90, kd: 18, maxMoment: 140 }
  });
  const dynamicFeetRoot120_24_180LowGain = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 120, kd: 24, maxMoment: 180 }
  });
  const dynamicFeetRoot60_12_100HipWorld = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 60, kd: 12, maxMoment: 100 },
    worldTargets: { hip: true }
  });
  const dynamicFeetRoot60_12_100AnkleWorld = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 60, kd: 12, maxMoment: 100 },
    worldTargets: { ankle: true }
  });
  const dynamicFeetRoot60_12_100BothWorld = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 60, kd: 12, maxMoment: 100 },
    worldTargets: { hip: true, ankle: true }
  });
  const dynamicFeetRootDisturbance = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 15,
    rootUpright: { enabled: true, kp: 90, kd: 18, maxMoment: 140 },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 0.8]
  });

  const substepPage2 = await openLab('&substeps=2');
  const substeps2Root60AnkleWorld = await runScenario(substepPage2, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 60, kd: 12, maxMoment: 100 },
    worldTargets: { ankle: true }
  });
  const substeps2Root90AnkleWorld = await runScenario(substepPage2, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 90, kd: 18, maxMoment: 140 },
    worldTargets: { ankle: true }
  });
  await substepPage2.close();

  const substepPage4 = await openLab('&substeps=4');
  const substeps4Root60AnkleWorld = await runScenario(substepPage4, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 60, kd: 12, maxMoment: 100 },
    worldTargets: { ankle: true }
  });
  const substeps4Root90AnkleWorld = await runScenario(substepPage4, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 90, kd: 18, maxMoment: 140 },
    worldTargets: { ankle: true }
  });
  await substepPage4.close();

  const substepPage8 = await openLab('&substeps=8');
  const substeps8Root60AnkleWorld = await runScenario(substepPage8, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 60, kd: 12, maxMoment: 100 },
    worldTargets: { ankle: true }
  });
  const substeps8Root180_22 = await runScenario(substepPage8, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 180, kd: 22, maxMoment: 220 },
    worldTargets: { ankle: true }
  });
  const substeps8Root300_30 = await runScenario(substepPage8, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true }
  });
  const substeps8Root450_40 = await runScenario(substepPage8, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 450, kd: 40, maxMoment: 240 },
    worldTargets: { ankle: true }
  });
  const substeps8Root300_30Disturbance = await runScenario(substepPage8, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 15,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 0.8]
  });
  await substepPage8.close();

  const footPlantPage = await openLab('&substeps=8&foot-plant=1');
  const footPlantRoot180_22 = await runScenario(footPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 180, kd: 22, maxMoment: 220 },
    worldTargets: { ankle: true }
  });
  const footPlantRoot300_30 = await runScenario(footPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true }
  });
  const footPlantRoot450_40 = await runScenario(footPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 450, kd: 40, maxMoment: 240 },
    worldTargets: { ankle: true }
  });
  const footPlantRoot300_30Disturbance = await runScenario(footPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 15,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 0.8]
  });
  const footPlantRoot300_30_60s = await runScenario(footPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 60,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true }
  });
  const footPlantRoot300_30Forward2Ns = await runScenario(footPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 2.0]
  });
  const footPlantRoot300_30Side2Ns = await runScenario(footPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [2.0, 0, 0]
  });
  const footPlantRoot300_30Forward4Ns = await runScenario(footPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 4.0]
  });
  await footPlantPage.close();

  const softFootPlantPage = await openLab('&substeps=8&foot-plant=1&foot-plant-kp=2500&foot-plant-kd=110&foot-plant-max=1000');
  const footPlant2500_110 = await runScenario(softFootPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true }
  });
  const footPlant2500_110Forward2Ns = await runScenario(softFootPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 2.0]
  });
  await softFootPlantPage.close();

  const freeFeetNoPlantPage = await openLab('&substeps=8');
  const freeFeetNoPlantRoot300 = await runScenario(freeFeetNoPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true }
  });
  await freeFeetNoPlantPage.close();

  const contactPlantPage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact');
  const contactPlantStable60s = await runScenario(contactPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 60,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true }
  });
  const contactPlantPush2Ns = await runScenario(contactPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 2]
  });
  const contactPlantPush4Ns = await runScenario(contactPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 4]
  });
  const contactPlantFootLift = await runScenario(contactPlantPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    impulseBody: 'foot_L',
    lateImpulse: [0, 1.5, 0]
  });
  await contactPlantPage.close();

  const contactPlantSoftPage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&foot-plant-kp=2500&foot-plant-kd=110&foot-plant-max=1000');
  const contactPlantSoft20s = await runScenario(contactPlantSoftPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 30, maxMoment: 220 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 2]
  });
  await contactPlantSoftPage.close();

  const contactAnkleSwing035Page = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-swing=0.35&ankle-plane-swing=0.35');
  const contactAnkleSwing035 = await runScenario(contactAnkleSwing035Page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await contactAnkleSwing035Page.close();

  const contactAnkleSwing070Page = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-swing=0.70&ankle-plane-swing=0.70');
  const contactAnkleSwing070 = await runScenario(contactAnkleSwing070Page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await contactAnkleSwing070Page.close();

  const contactAnkleSwing120Page = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-swing=1.20&ankle-plane-swing=1.20');
  const contactAnkleSwing120 = await runScenario(contactAnkleSwing120Page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await contactAnkleSwing120Page.close();

  const contactAnkleSwing165Page = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-swing=1.65&ankle-plane-swing=1.65');
  const contactAnkleSwing165 = await runScenario(contactAnkleSwing165Page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const contactAnkleSwing165StrongRoot = await runScenario(contactAnkleSwing165Page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 500, kd: 50, maxMoment: 400 },
    worldTargets: { ankle: true }
  });
  await contactAnkleSwing165Page.close();

  const pinnedPage = await openLab('&pin-feet=1');
  const pinnedInitial = await pinnedPage.evaluate(() => window.__lowerBodyTest.snapshot());
  const pinnedFeetBaseline = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 15 });
  const pinnedFeetRootUpright = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 15, rootUpright: { enabled: true, kp: 220, kd: 24 } });
  const pinnedFeetRoot220_40_30s = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 220, kd: 40 } });
  const pinnedFeetRoot300_60_30s = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 300, kd: 60 } });
  const pinnedFeetRoot140_36_30s = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 140, kd: 36 } });
  const pinnedFeetRoot20_5_50_30s = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 20, kd: 5, maxMoment: 50 } });
  const pinnedFeetRoot35_8_70_30s = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 35, kd: 8, maxMoment: 70 } });
  const pinnedFeetRoot60_12_100_30s = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 60, kd: 12, maxMoment: 100 } });
  const pinnedFeetRoot35_8_70Delayed30s = await runScenario(pinnedPage, { strength: 1, stiffness: 1, duration: 30, rootUprightDelaySeconds: 1.5, rootUpright: { enabled: true, kp: 35, kd: 8, maxMoment: 70 } });
  const pinnedFeetRoot35_8_70Disturbance15s = await runScenario(pinnedPage, {
    strength: 1, stiffness: 1, duration: 15,
    rootUpright: { enabled: true, kp: 35, kd: 8, maxMoment: 70 },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 0.8]
  });
  const freeFeetRoot20_5_50_30s = await runScenario(page, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 20, kd: 5, maxMoment: 50 } });
  const freeFeetRoot35_8_70_30s = await runScenario(page, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 35, kd: 8, maxMoment: 70 } });
  const freeFeetRoot35_8_70AnkleWorld30s = await runScenario(page, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 35, kd: 8, maxMoment: 70 }, worldTargets: { ankle: true } });
  const freeFeetRoot35_8_70HipAnkleWorld30s = await runScenario(page, { strength: 1, stiffness: 1, duration: 30, rootUpright: { enabled: true, kp: 35, kd: 8, maxMoment: 70 }, worldTargets: { hip: true, ankle: true } });
  const dynamicFeetStiffness050Damping01030s = await runScenario(page, { strength: 1, stiffness: 0.5, damping: 0.1, duration: 30 });
  const dynamicFeetStiffness025Damping01030s = await runScenario(page, { strength: 1, stiffness: 0.25, damping: 0.1, duration: 30 });
  const dynamicFeetStiffness025Damping00530s = await runScenario(page, { strength: 1, stiffness: 0.25, damping: 0.05, duration: 30 });
  const dynamicFeetStiffness010Damping00530s = await runScenario(page, { strength: 1, stiffness: 0.1, damping: 0.05, duration: 30 });
  const dynamicFeetStiffness025Damping010Root20_5_30s = await runScenario(page, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 30,
    rootUpright: { enabled: true, kp: 20, kd: 5, maxMoment: 50 }
  });
  const pinnedFeetRootImpulseAt5s = await runScenario(pinnedPage, {
    strength: 1,
    stiffness: 1,
    duration: 15,
    rootUpright: { enabled: true, kp: 220, kd: 40 },
    impulseAtSeconds: 5,
    lateImpulse: [0, 0, 0.8]
  });
  await pinnedPage.close();

  const finalStates = [passive.final, baseline.final, stronger.final, hipDisabled.final, kneeDisabled.final, ankleDisabled.final, hipWorldTarget.final, ankleWorldTarget.final, hipAnkleWorldTarget.final, hipWorldTargetReversed.final, ankleWorldTargetReversed.final, hipAnkleWorldTargetReversedHip.final, hipAnkleWorldTargetReversedBoth.final, rootUpright15s.final, rootUprightReversed8s.final, rootUprightStrong15s.final, rootUprightPlusAnkle15s.final, impulse.final, pinnedFeetBaseline.final, pinnedFeetRootUpright.final, pinnedFeetRoot220_40_30s.final, pinnedFeetRoot300_60_30s.final, pinnedFeetRoot140_36_30s.final, pinnedFeetRoot20_5_50_30s.final, pinnedFeetRoot35_8_70_30s.final, pinnedFeetRoot60_12_100_30s.final, pinnedFeetRoot35_8_70Delayed30s.final, pinnedFeetRoot35_8_70Disturbance15s.final, freeFeetRoot20_5_50_30s.final, freeFeetRoot35_8_70_30s.final, freeFeetRoot35_8_70AnkleWorld30s.final, freeFeetRoot35_8_70HipAnkleWorld30s.final, pinnedFeetRootImpulseAt5s.final, dynamicFeetStiffness050Damping01030s.final, dynamicFeetStiffness025Damping01030s.final, dynamicFeetStiffness025Damping00530s.final, dynamicFeetStiffness010Damping00530s.final, dynamicFeetStiffness025Damping010Root20_5_30s.final, dynamicFeetRoot35_8_70LowGain.final, dynamicFeetRoot60_12_100LowGain.final, dynamicFeetRoot90_18_140LowGain.final, dynamicFeetRoot120_24_180LowGain.final, dynamicFeetRoot60_12_100HipWorld.final, dynamicFeetRoot60_12_100AnkleWorld.final, dynamicFeetRoot60_12_100BothWorld.final, dynamicFeetRootDisturbance.final, substeps2Root60AnkleWorld.final, substeps2Root90AnkleWorld.final, substeps4Root60AnkleWorld.final, substeps4Root90AnkleWorld.final, substeps8Root60AnkleWorld.final, substeps8Root180_22.final, substeps8Root300_30.final, substeps8Root450_40.final, substeps8Root300_30Disturbance.final, footPlantRoot180_22.final, footPlantRoot300_30.final, footPlantRoot450_40.final, footPlantRoot300_30Disturbance.final, footPlantRoot300_30_60s.final, footPlantRoot300_30Forward2Ns.final, footPlantRoot300_30Side2Ns.final, footPlantRoot300_30Forward4Ns.final, footPlant2500_110.final, footPlant2500_110Forward2Ns.final, freeFeetNoPlantRoot300.final, contactPlantStable60s.final, contactPlantPush2Ns.final, contactPlantPush4Ns.final, contactPlantFootLift.final, contactPlantSoft20s.final, contactAnkleSwing035.final, contactAnkleSwing070.final, contactAnkleSwing120.final, contactAnkleSwing165.final, contactAnkleSwing165StrongRoot.final];
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
      collisionDiagnostics: initial.collisionDiagnostics,
      initialParts: initial.parts.map(part => ({
        name: part.name,
        isDynamic: part.isDynamic,
        position: part.position,
        rotation: part.rotation
      })),
      pinnedFeetModel: pinnedInitial.parts.filter(part => part.name.startsWith('foot_')).map(part => ({
        name: part.name,
        isDynamic: part.isDynamic,
        isKinematic: part.isKinematic
      })),
      initialJoints: initial.joints.map(joint => ({
        key: joint.key,
        type: joint.type,
        angle: joint.angle,
        min: joint.min,
        max: joint.max
      }))
    },
    startupDiagnostics: {
      lowGainStartup: lowGainStartup,
      baselineFullMuscles: startupTrace,
      passiveNoMuscles: passiveStartupTrace,
      ankleOnly: ankleOnlyStartupTrace,
      kneeOnly: kneeOnlyStartupTrace,
      hipOnly: hipOnlyStartupTrace,
      rebasedAnkles: rebasedAnkleStartupTrace,
      rebasedAllJoints: rebasedAllStartupTrace,
      rebasedAnkleOnlyMotor: rebasedAnkleOnlyStartupTrace,
      noSelfCollisions: noSelfStartupTrace,
      noFloorContact: noFloorStartupTrace,
      footStartGap25mm: footGapStartupTrace
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
      rootUpright15s: rootUpright15s,
      rootUprightReversed8s: rootUprightReversed8s,
      rootUprightStrong15s: rootUprightStrong15s,
      rootUprightPlusAnkle15s: rootUprightPlusAnkle15s,
      pelvisImpulse08_8s: impulse,
      pinnedFeetBaseline15s: pinnedFeetBaseline,
      pinnedFeetRootUpright220_24_15s: pinnedFeetRootUpright,
      pinnedFeetRoot220_40_30s: pinnedFeetRoot220_40_30s,
      pinnedFeetRoot300_60_30s: pinnedFeetRoot300_60_30s,
      pinnedFeetRoot140_36_30s: pinnedFeetRoot140_36_30s,
      pinnedFeetRoot20_5_50_30s: pinnedFeetRoot20_5_50_30s,
      pinnedFeetRoot35_8_70_30s: pinnedFeetRoot35_8_70_30s,
      pinnedFeetRoot60_12_100_30s: pinnedFeetRoot60_12_100_30s,
      pinnedFeetRoot35_8_70Delayed30s: pinnedFeetRoot35_8_70Delayed30s,
      pinnedFeetRoot35_8_70Disturbance15s: pinnedFeetRoot35_8_70Disturbance15s,
      freeFeetRoot20_5_50_30s: freeFeetRoot20_5_50_30s,
      freeFeetRoot35_8_70_30s: freeFeetRoot35_8_70_30s,
      freeFeetRoot35_8_70AnkleWorld30s: freeFeetRoot35_8_70AnkleWorld30s,
      freeFeetRoot35_8_70HipAnkleWorld30s: freeFeetRoot35_8_70HipAnkleWorld30s,
      dynamicFeetStiffness050Damping01030s: dynamicFeetStiffness050Damping01030s,
      dynamicFeetStiffness025Damping01030s: dynamicFeetStiffness025Damping01030s,
      dynamicFeetStiffness025Damping00530s: dynamicFeetStiffness025Damping00530s,
      dynamicFeetStiffness010Damping00530s: dynamicFeetStiffness010Damping00530s,
      dynamicFeetStiffness025Damping010Root20_5_30s: dynamicFeetStiffness025Damping010Root20_5_30s,
      dynamicFeetRoot35_8_70LowGain: dynamicFeetRoot35_8_70LowGain,
      dynamicFeetRoot60_12_100LowGain: dynamicFeetRoot60_12_100LowGain,
      dynamicFeetRoot90_18_140LowGain: dynamicFeetRoot90_18_140LowGain,
      dynamicFeetRoot120_24_180LowGain: dynamicFeetRoot120_24_180LowGain,
      dynamicFeetRoot60_12_100HipWorld: dynamicFeetRoot60_12_100HipWorld,
      dynamicFeetRoot60_12_100AnkleWorld: dynamicFeetRoot60_12_100AnkleWorld,
      dynamicFeetRoot60_12_100BothWorld: dynamicFeetRoot60_12_100BothWorld,
      dynamicFeetRootDisturbance: dynamicFeetRootDisturbance,
      substeps2Root60AnkleWorld: substeps2Root60AnkleWorld,
      substeps2Root90AnkleWorld: substeps2Root90AnkleWorld,
      substeps4Root60AnkleWorld: substeps4Root60AnkleWorld,
      substeps4Root90AnkleWorld: substeps4Root90AnkleWorld,
      substeps8Root60AnkleWorld: substeps8Root60AnkleWorld,
      substeps8Root180_22: substeps8Root180_22,
      substeps8Root300_30: substeps8Root300_30,
      substeps8Root450_40: substeps8Root450_40,
      substeps8Root300_30Disturbance: substeps8Root300_30Disturbance,
      footPlantRoot180_22: footPlantRoot180_22,
      footPlantRoot300_30: footPlantRoot300_30,
      footPlantRoot450_40: footPlantRoot450_40,
      footPlantRoot300_30Disturbance: footPlantRoot300_30Disturbance,
      footPlantRoot300_30_60s: footPlantRoot300_30_60s,
      footPlantRoot300_30Forward2Ns: footPlantRoot300_30Forward2Ns,
      footPlantRoot300_30Side2Ns: footPlantRoot300_30Side2Ns,
      footPlantRoot300_30Forward4Ns: footPlantRoot300_30Forward4Ns,
      footPlant2500_110: footPlant2500_110,
      footPlant2500_110Forward2Ns: footPlant2500_110Forward2Ns,
      freeFeetNoPlantRoot300: freeFeetNoPlantRoot300,
      contactPlantStable60s: contactPlantStable60s,
      contactPlantPush2Ns: contactPlantPush2Ns,
      contactPlantPush4Ns: contactPlantPush4Ns,
      contactPlantFootLift: contactPlantFootLift,
      contactPlantSoft20s: contactPlantSoft20s,
      contactAnkleSwing035: contactAnkleSwing035,
      contactAnkleSwing070: contactAnkleSwing070,
      contactAnkleSwing120: contactAnkleSwing120,
      contactAnkleSwing165: contactAnkleSwing165,
      contactAnkleSwing165StrongRoot: contactAnkleSwing165StrongRoot,
      pinnedFeetRootImpulseAt5s: pinnedFeetRootImpulseAt5s
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