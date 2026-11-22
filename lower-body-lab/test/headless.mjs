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

async function runHighFrequencyScenario(page, options) {
  await page.evaluate(config => {
    const api = window.__lowerBodyTest;
    api.reset();
    api.setMuscleStrength(config.strength ?? 1);
    api.setStiffness(config.stiffness ?? 1);
    api.setDamping(config.damping ?? 1);
    api.setWorldTargetMode('hip', false);
    api.setWorldTargetMode('ankle', config.worldTargets?.ankle ?? true);
    api.setRootUprightController(
      config.rootUpright?.enabled ?? true,
      config.rootUpright?.sign ?? 1,
      config.rootUpright?.kp ?? 400,
      config.rootUpright?.kd ?? 40,
      config.rootUpright?.maxMoment ?? 380
    );
  }, options);

  return page.evaluate(config => {
    const api = window.__lowerBodyTest;
    const samples = [];
    const totalFrames = Math.max(1, Math.floor(config.duration * 60));
    const impulseFrame = config.impulseAtSeconds == null ? -1 : Math.round(config.impulseAtSeconds * 60);
    const targetFrame = config.jointTargetAtSeconds == null ? -1 : Math.round(config.jointTargetAtSeconds * 60);
    const stanceHipTargetFrame = config.stanceHipTargetAtSeconds == null
      ? targetFrame
      : Math.round(config.stanceHipTargetAtSeconds * 60);
    const targetRampFrames = Math.max(1, Math.round((config.jointTargetRampSeconds || 0) * 60));
    const returnFrame = config.returnTargetAtSeconds == null
      ? -1
      : Math.round(config.returnTargetAtSeconds * 60);
    const returnRampFrames = Math.max(1, Math.round((config.returnTargetRampSeconds || 0.5) * 60));
    const traceStart = config.traceStartSeconds ?? Math.max(0, (config.impulseAtSeconds ?? config.stanceHipTargetAtSeconds ?? config.jointTargetAtSeconds ?? 0) - 0.5);
    const traceEnd = config.traceEndSeconds ?? Math.min(config.duration, (config.impulseAtSeconds ?? config.jointTargetAtSeconds ?? 0) + 1.5);
    let state = null;

    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (frame === stanceHipTargetFrame && config.stanceHipTarget != null) {
        api.setJointTargetRelativeRotation(
          config.stanceHipKey || 'pelvis->thigh_R',
          config.stanceHipAxis || [0, 0, 1],
          config.stanceHipTarget
        );
      }
      if (targetFrame >= 0 && frame >= targetFrame && frame < targetFrame + targetRampFrames) {
        const linearRamp = Math.min(1, (frame - targetFrame + 1) / targetRampFrames);
        const ramp = linearRamp * linearRamp * (3 - 2 * linearRamp);
        if (config.kneeTarget != null) {
          api.setJointTargetHingeAngle(config.kneeKey || 'thigh_L->shin_L', config.kneeTarget * ramp);
        }
        if (config.hipTarget != null) {
          api.setJointTargetRelativeRotation(
            config.hipKey || 'pelvis->thigh_L',
            config.hipAxis || [1, 0, 0],
            config.hipTarget * ramp
          );
        }
        if (config.swingHipTarget != null) {
          api.setJointTargetRelativeRotation(
            config.swingHipKey || 'pelvis->thigh_L',
            config.swingHipAxis || [1, 0, 0],
            config.swingHipTarget * ramp
          );
        }
      }
      if (frame === returnFrame) {
        // Return the swing leg to neutral after the lift phase. Interpolate
        // from the commanded swing angles instead of snapping targets.
        if (config.hipTarget != null) {
          api.setJointTargetRelativeRotation(
            config.swingHipKey || 'pelvis->thigh_L',
            config.swingHipAxis || [1, 0, 0],
            Number(config.hipTarget)
          );
        }
        if (config.kneeTarget != null) {
          api.setJointTargetHingeAngle(
            config.kneeKey || 'thigh_L->shin_L',
            Number(config.kneeTarget)
          );
        }
      }
      if (returnFrame >= 0 && frame > returnFrame && frame < returnFrame + returnRampFrames) {
        const linearRamp = Math.min(1, (frame - returnFrame + 1) / returnRampFrames);
        const ramp = linearRamp * linearRamp * (3 - 2 * linearRamp);
        if (config.hipTarget != null) {
          const endAngle = Number(config.returnHipTarget ?? 0);
          const angle = Number(config.hipTarget) + (endAngle - Number(config.hipTarget)) * ramp;
          api.setJointTargetRelativeRotation(
            config.swingHipKey || 'pelvis->thigh_L',
            config.swingHipAxis || [1, 0, 0],
            angle
          );
        }
        if (config.kneeTarget != null) {
          const endAngle = Number(config.returnKneeTarget ?? 0);
          const angle = Number(config.kneeTarget) + (endAngle - Number(config.kneeTarget)) * ramp;
          api.setJointTargetHingeAngle(config.kneeKey || 'thigh_L->shin_L', angle);
        }
      }
      if (frame === impulseFrame) {
        const impulse = config.impulse || [0, 0, 0];
        if (config.impulseOffset) {
          const offset = config.impulseOffset;
          api.applyImpulseAtOffset(
            config.impulseBody || 'pelvis',
            impulse[0], impulse[1], impulse[2],
            offset[0], offset[1], offset[2]
          );
        } else {
          api.applyImpulse(config.impulseBody || 'pelvis', impulse[0], impulse[1], impulse[2]);
        }
      }

      state = api.step(1);
      if (state.time >= traceStart && state.time <= traceEnd) {
        const leftFoot = state.parts.find(part => part.name === 'foot_L');
        const rightFoot = state.parts.find(part => part.name === 'foot_R');
        const leftThigh = state.parts.find(part => part.name === 'thigh_L');
        const leftShin = state.parts.find(part => part.name === 'shin_L');
        const leftKnee = state.joints.find(joint => joint.key === 'thigh_L->shin_L');
        const leftHip = state.joints.find(joint => joint.key === 'pelvis->thigh_L');
        const rightHip = state.joints.find(joint => joint.key === 'pelvis->thigh_R');
        const pelvisPart = state.parts.find(part => part.name === 'pelvis');
        samples.push({
          time: state.time,
          pelvisY: state.pelvisY,
          pelvisUp: state.pelvisUp,
          pelvisPosition: pelvisPart.position,
          pelvisAngularVelocity: pelvisPart.angularVelocity,
          com: state.com,
          comVelocity: state.comVelocity,
          balanceDiagnostics: state.balanceDiagnostics,
          groundedFeet: state.groundedFeet,
          rootUpright: state.rootUpright,
          leftFoot: {
            position: leftFoot.position,
            velocity: leftFoot.velocity,
            grounded: leftFoot.grounded,
            footUpDot: leftFoot.footUpDot
          },
          rightFoot: {
            position: rightFoot.position,
            velocity: rightFoot.velocity,
            grounded: rightFoot.grounded,
            footUpDot: rightFoot.footUpDot
          },
          leftThigh: { position: leftThigh.position, rotation: leftThigh.rotation },
          leftShin: { position: leftShin.position, rotation: leftShin.rotation },
          leftKnee: {
            angle: leftKnee.angle,
            measuredError: leftKnee.measuredError,
            appliedTorque: leftKnee.appliedTorque
          },
          leftHip: {
            measuredError: leftHip.measuredError,
            appliedTorque: leftHip.appliedTorque,
            targetRelative: leftHip.targetRelative
          },
          rightHip: {
            measuredError: rightHip.measuredError,
            appliedTorque: rightHip.appliedTorque,
            targetRelative: rightHip.targetRelative
          },
          torque: state.torque
        });
      }
    }
    return { final: state, samples };
  }, options);
}

async function runFootSwingScenario(page, options) {
  await page.evaluate(config => {
    const api = window.__lowerBodyTest;
    api.reset();
    api.setMuscleStrength(config.strength ?? 1);
    api.setStiffness(config.stiffness ?? 2);
    api.setDamping(config.damping ?? 0.8);
    api.setWorldTargetMode('hip', false);
    api.setWorldTargetMode('ankle', true);
    api.setRootUprightController(true, 1,
      config.rootUpright?.kp ?? 400,
      config.rootUpright?.kd ?? 40,
      config.rootUpright?.maxMoment ?? 380);
  }, options);

  return page.evaluate(config => {
    const api = window.__lowerBodyTest;
    const samples = [];
    const totalFrames = Math.max(1, Math.floor(config.durationSeconds * 60));
    const shiftFrame = Math.round((config.weightShiftAtSeconds ?? 2) * 60);
    const swingFrame = Math.round((config.swingAtSeconds ?? 4) * 60);
    const clearShiftFrame = Math.round((config.clearWeightShiftAtSeconds ?? 7) * 60);
    const impulseFrame = config.impulseAtSeconds == null ? -1 : Math.round(config.impulseAtSeconds * 60);
    let state = null;
    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (frame === shiftFrame) api.setJointTargetRelativeRotation(
        config.stanceHipKey ?? 'pelvis->thigh_R', [0, 0, 1], config.stanceHipAngle ?? -0.24);
      if (frame === swingFrame) api.configureFootSwing({
        side: config.swingSide ?? 'L', startTime: frame / 60,
        duration: config.swingDuration ?? 1.2,
        offset: config.stepOffset ?? [0, 0, -0.10],
        lift: config.lift ?? 0.10, kp: config.kp ?? 500,
        kd: config.kd ?? 60, maxForce: config.maxForce ?? 90,
        landingTolerance: config.landingTolerance ?? 0.055,
        landingSpeedTolerance: config.landingSpeedTolerance ?? 0.45,
        requiredTouchdownSubsteps: config.requiredTouchdownSubsteps ?? 4
      });
      if (frame === clearShiftFrame) api.setJointTargetRelativeRotation(
        config.stanceHipKey ?? 'pelvis->thigh_R', [0, 0, 1], 0);
      if (frame === impulseFrame) {
        const impulse = config.impulse ?? [0, 0, 0];
        const offset = config.impulseOffset ?? [0, 0.10, 0];
        api.applyImpulseAtOffset(config.impulseBody ?? 'pelvis',
          impulse[0], impulse[1], impulse[2], offset[0], offset[1], offset[2]);
      }
      state = api.step(1);
      if (frame % 2 === 0 || frame === totalFrames - 1) {
        const leftFoot = state.parts.find(part => part.name === 'foot_L');
        const rightFoot = state.parts.find(part => part.name === 'foot_R');
        const pelvis = state.parts.find(part => part.name === 'pelvis');
        samples.push({
          time: state.time, pelvisY: state.pelvisY, pelvisUp: state.pelvisUp,
          pelvisPosition: pelvis.position, pelvisAngularVelocity: pelvis.angularVelocity,
          com: state.com, comVelocity: state.comVelocity,
          balanceDiagnostics: state.balanceDiagnostics, groundedFeet: state.groundedFeet,
          rootUpright: state.rootUpright,
          leftFoot: { position: leftFoot.position, velocity: leftFoot.velocity, grounded: leftFoot.grounded, footUpDot: leftFoot.footUpDot },
          rightFoot: { position: rightFoot.position, velocity: rightFoot.velocity, grounded: rightFoot.grounded, footUpDot: rightFoot.footUpDot },
          knees: state.joints.filter(joint => joint.type === 'knee').map(joint => ({key:joint.key,angle:joint.angle,appliedTorque:joint.appliedTorque})),
          footSwing: state.footSwing, torque: state.torque
        });
      }
    }
    return { final: state, samples };
  }, options);
}


async function runPreflexThenSwingScenario(page, options) {
  await page.evaluate(config => {
    const api = window.__lowerBodyTest;
    api.reset();
    api.setMuscleStrength(config.strength ?? 1);
    api.setStiffness(config.stiffness ?? 2);
    api.setDamping(config.damping ?? 0.8);
    api.setWorldTargetMode('hip', false);
    api.setWorldTargetMode('ankle', true);
    api.setRootUprightController(true, 1, 400, 40, 380);
  }, options);

  return page.evaluate(config => {
    const api = window.__lowerBodyTest;
    const samples = [];
    const totalFrames = Math.round((config.durationSeconds ?? 10) * 60);
    const shiftFrame = Math.round((config.shiftStartSeconds ?? 2) * 60);
    const preflexFrame = Math.round((config.preflexStartSeconds ?? 4) * 60);
    const rampFrames = Math.max(1, Math.round((config.preflexRampSeconds ?? 1) * 60));
    const swingDuration = config.swingDuration ?? 1.8;
    const requiredStableFrames = config.stableFramesRequired ?? 18;
    const minimumCaptureMargin = config.minimumCaptureMargin ?? 0.04;
    const hipTarget = config.swingHipTarget ?? -0.35;
    const kneeTarget = config.swingKneeTarget ?? 0.90;

    let state = api.snapshot();
    let stableFrames = 0;
    let swingStarted = false;
    let swingStartTime = null;

    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (frame === shiftFrame) {
        api.setJointTargetRelativeRotation('pelvis->thigh_R', [0, 0, 1], config.stanceHipTarget ?? -0.24);
      }

      if (frame >= preflexFrame && frame < preflexFrame + rampFrames) {
        const linear = Math.min(1, (frame - preflexFrame + 1) / rampFrames);
        const ramp = linear * linear * (3 - 2 * linear);
        api.setJointTargetRelativeRotation('pelvis->thigh_L', [1, 0, 0], hipTarget * ramp);
        api.setJointTargetHingeAngle('thigh_L->shin_L', kneeTarget * ramp);
      }

      if (!swingStarted && frame >= preflexFrame + rampFrames) {
        const rightSupport = state.balanceDiagnostics.footSupport.foot_R;
        const knee = state.joints.find(joint => joint.key === 'thigh_L->shin_L');
        const bothGrounded = state.groundedFeet.includes('foot_L') && state.groundedFeet.includes('foot_R');
        const safePosture = state.pelvisY > 1.0 && state.pelvisUp > 0.96;
        const kneePrepared = Number.isFinite(knee?.angle) && knee.angle >= kneeTarget * 0.80;
        const margin = rightSupport?.capturePointMargin;

        if (bothGrounded && safePosture && kneePrepared && Number.isFinite(margin) && margin >= minimumCaptureMargin) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }

        if (stableFrames >= requiredStableFrames) {
          api.configureFootSwing({
            side: 'L',
            startTime: frame / 60,
            duration: swingDuration,
            offset: config.stepOffset ?? [0, 0, -0.06],
            lift: config.lift ?? 0.06,
            kp: config.swingKp ?? 450,
            kd: config.swingKd ?? 55,
            maxForce: config.swingMaxForce ?? 75,
            landingTolerance: 0.055,
            landingSpeedTolerance: 0.45,
            requiredTouchdownSubsteps: 4
          });
          swingStarted = true;
          swingStartTime = frame / 60;
        }
      }

      state = api.step(1);
      if (frame % 2 === 0 || frame === totalFrames - 1) {
        const knee = state.joints.find(joint => joint.key === 'thigh_L->shin_L');
        const rightSupport = state.balanceDiagnostics.footSupport.foot_R;
        const leftFoot = state.parts.find(part => part.name === 'foot_L');
        samples.push({
          time: state.time,
          pelvisY: state.pelvisY,
          pelvisUp: state.pelvisUp,
          groundedFeet: state.groundedFeet,
          leftKneeAngle: knee?.angle ?? null,
          leftFootPosition: leftFoot?.position ?? null,
          rightCaptureMargin: rightSupport?.capturePointMargin ?? null,
          stableFrames,
          swingStarted,
          footSwing: state.footSwing,
          rootUpright: state.rootUpright
        });
      }
    }

    return { final: state, samples, stableFrames, swingStarted, swingStartTime, hipTarget, kneeTarget };
  }, options);
}


async function runClosedLoopUnloadScenario(page, options) {
  await page.evaluate(config => {
    const api = window.__lowerBodyTest;
    api.reset();
    api.setMuscleStrength(config.strength ?? 1);
    api.setStiffness(config.stiffness ?? 2);
    api.setDamping(config.damping ?? 0.8);
    api.setWorldTargetMode('hip', false);
    api.setWorldTargetMode('ankle', true);
    api.setRootUprightController(true, 1, 400, 40, 380);
  }, options);

  return page.evaluate(config => {
    const api = window.__lowerBodyTest;
    const samples = [];
    const shiftStart = Math.round((config.shiftStartSeconds ?? 2) * 60);
    const swingDuration = config.swingDuration ?? 1.5;
    const maxAngle = config.maxAngle ?? -0.27;
    const targetMargin = config.targetCaptureMargin ?? 0.065;
    const stableFramesRequired = config.stableFramesRequired ?? 18;
    const maxAngleRate = config.maxAngleRate ?? 0.45;
    const totalFrames = Math.round((config.durationSeconds ?? 10) * 60);
    let targetAngle = 0;
    let stableFrames = 0;
    let swingStarted = false;
    let swingStartTime = null;
    let abortReason = null;
    let state = api.snapshot();

    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (frame >= shiftStart && !abortReason) {
        const rightSupport = state.balanceDiagnostics.footSupport.foot_R;
        const bothGrounded = state.groundedFeet.includes('foot_L') && state.groundedFeet.includes('foot_R');
        const safePosture = state.pelvisY > 0.98 && state.pelvisUp > 0.96;
        const margin = rightSupport?.capturePointMargin;

        if (!swingStarted) {
          if (!bothGrounded || !safePosture || !Number.isFinite(margin)) {
            abortReason = !bothGrounded ? 'double-support-lost-during-unload'
              : !safePosture ? 'posture-degraded-during-unload' : 'capture-point-unavailable';
          } else {
            const error = targetMargin - margin;
            const desiredAngle = Math.max(maxAngle, Math.min(0, targetAngle - error * 0.55));
            const maxDelta = maxAngleRate / 60;
            targetAngle += Math.max(-maxDelta, Math.min(maxDelta, desiredAngle - targetAngle));
            api.setJointTargetRelativeRotation('pelvis->thigh_R', [0, 0, 1], targetAngle);
            if (margin >= targetMargin && state.pelvisY > 1.0 && state.pelvisUp > 0.98) {
              stableFrames += 1;
            } else {
              stableFrames = 0;
            }
            if (stableFrames >= stableFramesRequired) {
              api.configureFootSwing({
                side: 'L', startTime: frame / 60, duration: swingDuration,
                offset: config.stepOffset ?? [0, 0, -0.10],
                lift: config.lift ?? 0.08,
                kp: config.swingKp ?? 450, kd: config.swingKd ?? 55,
                maxForce: config.swingMaxForce ?? 75,
                landingTolerance: 0.055, landingSpeedTolerance: 0.45,
                requiredTouchdownSubsteps: 4
              });
              swingStarted = true;
              swingStartTime = frame / 60;
            }
          }
        } else if (config.continueStanceFeedback && Number.isFinite(margin) && safePosture) {
          // Keep regulating the stance leg after swing initiation; the previous
          // experiment froze this target exactly when single support began.
          const error = targetMargin - margin;
          const desiredAngle = Math.max(maxAngle, Math.min(0, targetAngle - error * 0.55));
          const maxDelta = maxAngleRate / 60;
          targetAngle += Math.max(-maxDelta, Math.min(maxDelta, desiredAngle - targetAngle));
          api.setJointTargetRelativeRotation('pelvis->thigh_R', [0, 0, 1], targetAngle);
        }
      }

      state = api.step(1);
      if (frame % 2 === 0 || frame === totalFrames - 1) {
        const support = state.balanceDiagnostics.footSupport.foot_R;
        samples.push({
          time: state.time, targetAngle, stableFrames, swingStarted, abortReason,
          pelvisY: state.pelvisY, pelvisUp: state.pelvisUp,
          com: state.com, comVelocity: state.comVelocity,
          rightCaptureMargin: support?.capturePointMargin ?? null,
          rightComMargin: support?.comProjectionMargin ?? null,
          groundedFeet: state.groundedFeet,
          rootUpright: state.rootUpright,
          pelvisAngularVelocity: state.parts.find(part => part.name === 'pelvis')?.angularVelocity,
          rightFootPosition: state.parts.find(part => part.name === 'foot_R')?.position,
          leftFootPosition: state.parts.find(part => part.name === 'foot_L')?.position,
          footSwing: state.footSwing
        });
      }
    }
    return {
      final: state, samples, targetAngle, stableFrames, swingStarted,
      swingStartTime, abortReason, maxAngle, targetCaptureMargin: targetMargin
    };
  }, options);
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
          balanceDiagnostics: state.balanceDiagnostics,
          supportContactPoints: state.balanceDiagnostics.supportPolygonXZ,
          limbAlignment: state.parts.filter(part => part.limbAxisUpDot !== null).map(part => ({
            name: part.name,
            axisUpDot: part.limbAxisUpDot,
            position: part.position
          })),
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

  const contactAnkleTwistMediumPage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-1.2&ankle-twist-max=1.2');
  const contactAnkleTwistMedium = await runScenario(contactAnkleTwistMediumPage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await contactAnkleTwistMediumPage.close();

  const contactAnkleTwistWidePage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4');
  const contactAnkleTwistWide = await runScenario(contactAnkleTwistWidePage, {
    strength: 1, stiffness: 0.25, damping: 0.1, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const contactAnkleTwistWideStrongPD = await runScenario(contactAnkleTwistWidePage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await contactAnkleTwistWidePage.close();

  const freeAnkleTwistWidePage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4');
  const freeAnkleTwistWideStrongPD = await runScenario(freeAnkleTwistWidePage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await freeAnkleTwistWidePage.close();

  const contactHipSwing095Page = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4&hip-swing=0.95');
  const contactHipSwing095 = await runScenario(contactHipSwing095Page, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await contactHipSwing095Page.close();

  const contactHipSwing125Page = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4&hip-swing=1.25');
  const contactHipSwing125 = await runScenario(contactHipSwing125Page, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await contactHipSwing125Page.close();

  const contactHipSwing125BothPage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4&hip-swing=1.25&hip-plane-swing=1.0');
  const contactHipSwing125Both = await runScenario(contactHipSwing125BothPage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await contactHipSwing125BothPage.close();

  const hipWorldAnkleWorldContactPage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4');
  const hipWorldAnkleWorldContactNoRoot = await runScenario(hipWorldAnkleWorldContactPage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    worldTargets: { hip: true, ankle: true }
  });
  const hipWorldAnkleWorldContactRoot = await runScenario(hipWorldAnkleWorldContactPage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { hip: true, ankle: true }
  });
  const hipLocalAnkleWorldContactNoRoot = await runScenario(hipWorldAnkleWorldContactPage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    worldTargets: { hip: false, ankle: true }
  });
  await hipWorldAnkleWorldContactPage.close();

  const directRootContactPage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=direct&hip-swing=1.25');
  const directRootContact = await runScenario(directRootContactPage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const directRootContactLowPD = await runScenario(directRootContactPage, {
    strength: 1, stiffness: 0.35, damping: 0.15, duration: 20,
    rootUpright: { enabled: true, kp: 300, kd: 35, maxMoment: 300 },
    worldTargets: { ankle: true }
  });
  await directRootContactPage.close();

  const directRootFreePage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=direct&hip-swing=1.25');
  const directRootFree = await runScenario(directRootFreePage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await directRootFreePage.close();

  const hipFreeContact066Page = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=hip-free');
  const hipFreeContact066 = await runScenario(hipFreeContact066Page, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await hipFreeContact066Page.close();

  const hipFreeContact095Page = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4&hip-swing=0.95&root-mode=hip-free');
  const hipFreeContact095 = await runScenario(hipFreeContact095Page, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const hipFreeContact095LowerRoot = await runScenario(hipFreeContact095Page, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 250, kd: 30, maxMoment: 240 },
    worldTargets: { ankle: true }
  });
  await hipFreeContact095Page.close();

  const hipFreeNoPlantPage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&hip-swing=0.95&root-mode=hip-free');
  const hipFreeNoPlant = await runScenario(hipFreeNoPlantPage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await hipFreeNoPlantPage.close();

  const hipWorldAnkleWorldFreePage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4');
  const hipWorldAnkleWorldFreeNoRoot = await runScenario(hipWorldAnkleWorldFreePage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    worldTargets: { hip: true, ankle: true }
  });
  const hipWorldAnkleWorldFreeRoot = await runScenario(hipWorldAnkleWorldFreePage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { hip: true, ankle: true }
  });
  await hipWorldAnkleWorldFreePage.close();

  const ankleLocalContactWidePage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4');
  const ankleLocalContactWide = await runScenario(ankleLocalContactWidePage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    worldTargets: { hip: false, ankle: false }
  });
  const ankleLocalContactWideStrongPD = await runScenario(ankleLocalContactWidePage, {
    strength: 1, stiffness: 1.5, damping: 0.6, duration: 20,
    worldTargets: { hip: false, ankle: false }
  });
  const ankleLocalContactWideMaxPD = await runScenario(ankleLocalContactWidePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    worldTargets: { hip: false, ankle: false }
  });
  const ankleWorldContactWideControl = await runScenario(ankleLocalContactWidePage, {
    strength: 1, stiffness: 0.75, damping: 0.3, duration: 20,
    worldTargets: { hip: false, ankle: true }
  });
  await ankleLocalContactWidePage.close();

  const ankleLocalFreeWidePage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4');
  const ankleLocalFreeWideStrongPD = await runScenario(ankleLocalFreeWidePage, {
    strength: 1, stiffness: 1.5, damping: 0.6, duration: 20,
    worldTargets: { hip: false, ankle: false }
  });
  await ankleLocalFreeWidePage.close();

  const directRootContactStrongPDPage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=direct&hip-swing=1.25');
  const directRootContactStrongPD = await runScenario(directRootContactStrongPDPage, {
    strength: 1, stiffness: 1.5, damping: 0.6, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const directRootContactMaxPD = await runScenario(directRootContactStrongPDPage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  await directRootContactStrongPDPage.close();

  const anklePairFreePage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=ankle-pair&hip-swing=1.25');
  const anklePairFreeMaxPD = await runScenario(anklePairFreePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const anklePairFreeStable60s = await runScenario(anklePairFreePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 60,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const anklePairFreePush2Ns = await runScenario(anklePairFreePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 2.0]
  });
  const anklePairFreePush4Ns = await runScenario(anklePairFreePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 4.0]
  });
  const anklePairFreeSide2Ns = await runScenario(anklePairFreePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [2.0, 0, 0]
  });
  const anklePairFreeFootLift2Ns = await runScenario(anklePairFreePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    impulseBody: 'foot_L',
    impulseAtSeconds: 8,
    lateImpulse: [0, 2.0, 0]
  });
  await anklePairFreePage.close();

  const anklePairLiftProbePage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=ankle-pair&hip-swing=1.25');
  const anklePairFootLift4NsTrace = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 10,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    impulseBody: 'foot_L',
    impulseAtSeconds: 8,
    impulse: [0, 4, 0],
    traceStartSeconds: 7.5,
    traceEndSeconds: 9.5
  });
  const anklePairStepHipNegative = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 8,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    jointTargetAtSeconds: 3,
    hipTarget: -0.35,
    kneeTarget: 0.9,
    traceStartSeconds: 2.5,
    traceEndSeconds: 8
  });
  const anklePairStepHipPositive = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 8,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    jointTargetAtSeconds: 3,
    hipTarget: 0.35,
    kneeTarget: 0.9,
    traceStartSeconds: 2.5,
    traceEndSeconds: 8
  });

  // Regression: a new run after a commanded knee bend must return to the
  // neutral two-foot stance rather than inheriting the old hinge target.
  const anklePairStepResetAfterTarget = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    traceStartSeconds: 0,
    traceEndSeconds: 6
  });

  // Isolate frontal-plane stance-hip targets. The right leg is the candidate
  // support leg; these probes measure which sign shifts the COM over it
  // before attempting a swing-leg command.
  const anklePairLateralHipZPlus008 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    jointTargetAtSeconds: 2,
    stanceHipTarget: 0.08,
    traceStartSeconds: 1.5,
    traceEndSeconds: 6
  });
  const anklePairLateralHipZMinus008 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    jointTargetAtSeconds: 2,
    stanceHipTarget: -0.08,
    traceStartSeconds: 1.5,
    traceEndSeconds: 6
  });
  const anklePairLateralHipZPlus016 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    jointTargetAtSeconds: 2,
    stanceHipTarget: 0.16,
    traceStartSeconds: 1.5,
    traceEndSeconds: 6
  });
  const anklePairLateralHipZMinus016 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    jointTargetAtSeconds: 2,
    stanceHipTarget: -0.16,
    traceStartSeconds: 1.5,
    traceEndSeconds: 6
  });
  const anklePairLateralHipZMinus024 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    jointTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    traceStartSeconds: 1.5,
    traceEndSeconds: 6
  });
  const anklePairLateralHipZMinus032 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    jointTargetAtSeconds: 2,
    stanceHipTarget: -0.32,
    traceStartSeconds: 1.5,
    traceEndSeconds: 6
  });

  // Two-phase transition: load the right support leg first, then request a
  // left swing. The 2 s gap separates weight transfer from leg lift.
  const anklePairWeightShiftStep024 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 10,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    hipTarget: 0.35,
    kneeTarget: 0.9,
    traceStartSeconds: 1.5,
    traceEndSeconds: 10
  });
  const anklePairWeightShiftStep032 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 10,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.32,
    jointTargetAtSeconds: 4,
    hipTarget: 0.35,
    kneeTarget: 0.9,
    traceStartSeconds: 1.5,
    traceEndSeconds: 10
  });

  // Sweep swing-hip direction/magnitude and smooth actuator activation while
  // the right leg maintains the measured -0.24 rad weight-shift target.
  const anklePairStepHipNeg020Ramp05 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 8,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 0.5,
    hipTarget: -0.20,
    kneeTarget: 0.9,
    traceStartSeconds: 1.5,
    traceEndSeconds: 8
  });
  const anklePairStepKneeOnlyRamp05 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 8,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 0.5,
    kneeTarget: 0.9,
    traceStartSeconds: 1.5,
    traceEndSeconds: 8
  });
  const anklePairStepHipNeg035Ramp05 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 8,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 0.5,
    hipTarget: -0.35,
    kneeTarget: 0.9,
    traceStartSeconds: 1.5,
    traceEndSeconds: 8
  });
  const anklePairStepHipPos020Ramp05 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 8,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 0.5,
    hipTarget: 0.20,
    kneeTarget: 0.9,
    traceStartSeconds: 1.5,
    traceEndSeconds: 8
  });
  const anklePairStepHipNeg035Ramp10 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 8,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 1.0,
    hipTarget: -0.35,
    kneeTarget: 0.9,
    traceStartSeconds: 1.5,
    traceEndSeconds: 8
  });
  const anklePairPitchImpulse14Offset = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 12,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    impulseBody: 'pelvis',
    impulseAtSeconds: 8,
    impulse: [0, 0, 1.4],
    impulseOffset: [0, 0.10, 0],
    traceStartSeconds: 7.5,
    traceEndSeconds: 12
  });
  const anklePairRollImpulse14Offset = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 12,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    impulseBody: 'pelvis',
    impulseAtSeconds: 8,
    impulse: [1.4, 0, 0],
    impulseOffset: [0, 0.10, 0],
    traceStartSeconds: 7.5,
    traceEndSeconds: 12
  });

  // One-leg unloading sweep: first shift the pelvis over the right support leg,
  // then flex and swing the left leg, and finally command a controlled re-plant.
  const anklePairSwingKnee110 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 10,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 0.75,
    hipTarget: -0.35,
    kneeTarget: 1.10,
    returnTargetAtSeconds: 7,
    returnTargetRampSeconds: 0.75,
    traceStartSeconds: 1.5,
    traceEndSeconds: 10
  });
  const anklePairSwingKnee130 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 10,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 0.75,
    hipTarget: -0.35,
    kneeTarget: 1.30,
    returnTargetAtSeconds: 7,
    returnTargetRampSeconds: 0.75,
    traceStartSeconds: 1.5,
    traceEndSeconds: 10
  });
  const anklePairSwingKnee145 = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 10,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 0.75,
    hipTarget: -0.35,
    kneeTarget: 1.45,
    returnTargetAtSeconds: 7,
    returnTargetRampSeconds: 0.75,
    traceStartSeconds: 1.5,
    traceEndSeconds: 10
  });
  const anklePairSwingLongerReach = await runHighFrequencyScenario(anklePairLiftProbePage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 10,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2,
    stanceHipTarget: -0.24,
    jointTargetAtSeconds: 4,
    jointTargetRampSeconds: 0.75,
    hipTarget: -0.48,
    kneeTarget: 1.30,
    returnTargetAtSeconds: 7,
    returnTargetRampSeconds: 0.75,
    traceStartSeconds: 1.5,
    traceEndSeconds: 10
  });
  await anklePairLiftProbePage.close();

  const weightShiftPage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=ankle-pair&hip-swing=1.25');
  const weightShiftMinus024 = await runHighFrequencyScenario(weightShiftPage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2, stanceHipTarget: -0.24,
    traceStartSeconds: 1.5, traceEndSeconds: 6
  });
  const weightShiftMinus032 = await runHighFrequencyScenario(weightShiftPage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2, stanceHipTarget: -0.32,
    traceStartSeconds: 1.5, traceEndSeconds: 6
  });
  const weightShiftMinus040 = await runHighFrequencyScenario(weightShiftPage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 6,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    stanceHipTargetAtSeconds: 2, stanceHipTarget: -0.40,
    traceStartSeconds: 1.5, traceEndSeconds: 6
  });
  await weightShiftPage.close();

  const footSwingPage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=ankle-pair&hip-swing=1.25&ankle-max-torque=180');
  const footSwingLiftOnly = await runFootSwingScenario(footSwingPage, {
    durationSeconds: 10, stanceHipAngle: -0.32, clearWeightShiftAtSeconds: 12,
    swingDuration: 1.4, stepOffset: [0, 0, 0], lift: 0.08,
    kp: 450, kd: 55, maxForce: 70
  });
  const footSwingForwardShort = await runFootSwingScenario(footSwingPage, {
    durationSeconds: 10, stanceHipAngle: -0.32, clearWeightShiftAtSeconds: 12,
    swingDuration: 1.4, stepOffset: [0, 0, -0.10], lift: 0.08,
    kp: 450, kd: 55, maxForce: 75
  });
  const footSwingForwardMedium = await runFootSwingScenario(footSwingPage, {
    durationSeconds: 10, stanceHipAngle: -0.36, clearWeightShiftAtSeconds: 12,
    swingDuration: 1.5, stepOffset: [0, 0, -0.14], lift: 0.10,
    kp: 500, kd: 60, maxForce: 85
  });
  await footSwingPage.close();


  const closedLoopUnloadPage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=ankle-pair&hip-swing=1.25&ankle-max-torque=180');
  const closedLoopUnloadStep = await runClosedLoopUnloadScenario(closedLoopUnloadPage, {
    durationSeconds: 10, shiftStartSeconds: 2, maxAngle: -0.27,
    targetCaptureMargin: 0.065, stableFramesRequired: 18,
    maxAngleRate: 0.45, swingDuration: 1.5,
    stepOffset: [0, 0, -0.10], lift: 0.08
  });
  const closedLoopUnloadStep300 = await runClosedLoopUnloadScenario(closedLoopUnloadPage, {
    durationSeconds: 10, shiftStartSeconds: 2, maxAngle: -0.30,
    targetCaptureMargin: 0.065, stableFramesRequired: 18,
    maxAngleRate: 0.45, swingDuration: 1.5,
    stepOffset: [0, 0, -0.10], lift: 0.08
  });
  const closedLoopUnloadStep320 = await runClosedLoopUnloadScenario(closedLoopUnloadPage, {
    durationSeconds: 10, shiftStartSeconds: 2, maxAngle: -0.32,
    targetCaptureMargin: 0.065, stableFramesRequired: 18,
    maxAngleRate: 0.45, swingDuration: 1.5,
    stepOffset: [0, 0, -0.10], lift: 0.08
  });
  const closedLoopUnloadStep320Adaptive = await runClosedLoopUnloadScenario(closedLoopUnloadPage, {
    durationSeconds: 10, shiftStartSeconds: 2, maxAngle: -0.32,
    targetCaptureMargin: 0.065, stableFramesRequired: 18,
    maxAngleRate: 0.45, swingDuration: 1.5,
    stepOffset: [0, 0, -0.10], lift: 0.08,
    continueStanceFeedback: true
  });
  const closedLoopUnloadStep320Conservative = await runClosedLoopUnloadScenario(closedLoopUnloadPage, {
    durationSeconds: 10, shiftStartSeconds: 2, maxAngle: -0.32,
    targetCaptureMargin: 0.065, stableFramesRequired: 18,
    maxAngleRate: 0.45, swingDuration: 2.4,
    stepOffset: [0, 0, -0.06], lift: 0.04,
    swingKp: 300, swingKd: 45, swingMaxForce: 60,
    continueStanceFeedback: true
  });
  const preflexSwingPage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=ankle-pair&hip-swing=1.25&ankle-max-torque=180');
  const preflexSwingShort = await runPreflexThenSwingScenario(preflexSwingPage, {
    durationSeconds: 10, shiftStartSeconds: 2, preflexStartSeconds: 4,
    preflexRampSeconds: 1, stanceHipTarget: -0.24,
    swingHipTarget: -0.35, swingKneeTarget: 0.90,
    minimumCaptureMargin: 0.04, stableFramesRequired: 18,
    swingDuration: 1.8, stepOffset: [0, 0, -0.06], lift: 0.06
  });
  const preflexSwingMedium = await runPreflexThenSwingScenario(preflexSwingPage, {
    durationSeconds: 10, shiftStartSeconds: 2, preflexStartSeconds: 4,
    preflexRampSeconds: 1, stanceHipTarget: -0.24,
    swingHipTarget: -0.35, swingKneeTarget: 0.90,
    minimumCaptureMargin: 0.04, stableFramesRequired: 18,
    swingDuration: 1.8, stepOffset: [0, 0, -0.10], lift: 0.06
  });
  await preflexSwingPage.close();

  await closedLoopUnloadPage.close();

  const footSwingLowTorquePage = await openLab('&substeps=8&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=ankle-pair&hip-swing=1.25&ankle-max-torque=105');
  const footSwingForwardMediumLowTorque = await runFootSwingScenario(footSwingLowTorquePage, {
    durationSeconds: 10, stanceHipAngle: -0.36, clearWeightShiftAtSeconds: 12,
    swingDuration: 1.5, stepOffset: [0, 0, -0.14], lift: 0.10,
    kp: 500, kd: 60, maxForce: 85
  });
  await footSwingLowTorquePage.close();

  const anklePairContactPage = await openLab('&substeps=8&foot-plant=1&foot-plant-mode=contact&ankle-twist-min=-2.4&ankle-twist-max=2.4&root-mode=ankle-pair&hip-swing=1.25');
  const anklePairContactStrongPD = await runScenario(anklePairContactPage, {
    strength: 1, stiffness: 1.5, damping: 0.6, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const anklePairContactMaxPD = await runScenario(anklePairContactPage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const anklePairContactLocalAnkle = await runScenario(anklePairContactPage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: false }
  });
  const anklePairContactMaxPD60s = await runScenario(anklePairContactPage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 60,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true }
  });
  const anklePairContactDisturbance = await runScenario(anklePairContactPage, {
    strength: 1, stiffness: 2.0, damping: 0.8, duration: 20,
    rootUpright: { enabled: true, kp: 400, kd: 40, maxMoment: 380 },
    worldTargets: { ankle: true },
    impulseAtSeconds: 8,
    lateImpulse: [0, 0, 0.8]
  });
  await anklePairContactPage.close();

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

  const finalStates = [footSwingLiftOnly.final, footSwingForwardShort.final, footSwingForwardMedium.final, footSwingForwardMediumLowTorque.final, closedLoopUnloadStep.final, closedLoopUnloadStep320Adaptive.final, closedLoopUnloadStep320Conservative.final, preflexSwingShort.final, preflexSwingMedium.final, weightShiftMinus024.final, weightShiftMinus032.final, weightShiftMinus040.final, anklePairPitchImpulse14Offset.final, anklePairRollImpulse14Offset.final, anklePairSwingKnee110.final, anklePairSwingKnee130.final, anklePairSwingKnee145.final, anklePairSwingLongerReach.final, passive.final, baseline.final, stronger.final, hipDisabled.final, kneeDisabled.final, ankleDisabled.final, hipWorldTarget.final, ankleWorldTarget.final, hipAnkleWorldTarget.final, hipWorldTargetReversed.final, ankleWorldTargetReversed.final, hipAnkleWorldTargetReversedHip.final, hipAnkleWorldTargetReversedBoth.final, rootUpright15s.final, rootUprightReversed8s.final, rootUprightStrong15s.final, rootUprightPlusAnkle15s.final, impulse.final, pinnedFeetBaseline.final, pinnedFeetRootUpright.final, pinnedFeetRoot220_40_30s.final, pinnedFeetRoot300_60_30s.final, pinnedFeetRoot140_36_30s.final, pinnedFeetRoot20_5_50_30s.final, pinnedFeetRoot35_8_70_30s.final, pinnedFeetRoot60_12_100_30s.final, pinnedFeetRoot35_8_70Delayed30s.final, pinnedFeetRoot35_8_70Disturbance15s.final, freeFeetRoot20_5_50_30s.final, freeFeetRoot35_8_70_30s.final, freeFeetRoot35_8_70AnkleWorld30s.final, freeFeetRoot35_8_70HipAnkleWorld30s.final, pinnedFeetRootImpulseAt5s.final, dynamicFeetStiffness050Damping01030s.final, dynamicFeetStiffness025Damping01030s.final, dynamicFeetStiffness025Damping00530s.final, dynamicFeetStiffness010Damping00530s.final, dynamicFeetStiffness025Damping010Root20_5_30s.final, dynamicFeetRoot35_8_70LowGain.final, dynamicFeetRoot60_12_100LowGain.final, dynamicFeetRoot90_18_140LowGain.final, dynamicFeetRoot120_24_180LowGain.final, dynamicFeetRoot60_12_100HipWorld.final, dynamicFeetRoot60_12_100AnkleWorld.final, dynamicFeetRoot60_12_100BothWorld.final, dynamicFeetRootDisturbance.final, substeps2Root60AnkleWorld.final, substeps2Root90AnkleWorld.final, substeps4Root60AnkleWorld.final, substeps4Root90AnkleWorld.final, substeps8Root60AnkleWorld.final, substeps8Root180_22.final, substeps8Root300_30.final, substeps8Root450_40.final, substeps8Root300_30Disturbance.final, footPlantRoot180_22.final, footPlantRoot300_30.final, footPlantRoot450_40.final, footPlantRoot300_30Disturbance.final, footPlantRoot300_30_60s.final, footPlantRoot300_30Forward2Ns.final, footPlantRoot300_30Side2Ns.final, footPlantRoot300_30Forward4Ns.final, footPlant2500_110.final, footPlant2500_110Forward2Ns.final, freeFeetNoPlantRoot300.final, contactPlantStable60s.final, contactPlantPush2Ns.final, contactPlantPush4Ns.final, contactPlantFootLift.final, contactPlantSoft20s.final, contactAnkleSwing035.final, contactAnkleSwing070.final, contactAnkleSwing120.final, contactAnkleSwing165.final, contactAnkleSwing165StrongRoot.final, contactAnkleTwistMedium.final, contactAnkleTwistWide.final, contactAnkleTwistWideStrongPD.final, freeAnkleTwistWideStrongPD.final, contactHipSwing095.final, contactHipSwing125.final, contactHipSwing125Both.final, hipWorldAnkleWorldContactNoRoot.final, hipWorldAnkleWorldContactRoot.final, hipLocalAnkleWorldContactNoRoot.final, hipWorldAnkleWorldFreeNoRoot.final, hipWorldAnkleWorldFreeRoot.final, directRootContact.final, directRootContactLowPD.final, directRootFree.final, hipFreeContact066.final, hipFreeContact095.final, hipFreeContact095LowerRoot.final, hipFreeNoPlant.final, ankleLocalContactWide.final, ankleLocalContactWideStrongPD.final, ankleLocalContactWideMaxPD.final, ankleWorldContactWideControl.final, ankleLocalFreeWideStrongPD.final, directRootContactStrongPD.final, directRootContactMaxPD.final, anklePairFreeMaxPD.final, anklePairContactStrongPD.final, anklePairContactMaxPD.final, anklePairContactLocalAnkle.final, anklePairContactMaxPD60s.final, anklePairContactDisturbance.final, anklePairFreeStable60s.final, anklePairFreePush2Ns.final, anklePairFreePush4Ns.final, anklePairFreeSide2Ns.final, anklePairFreeFootLift2Ns.final, anklePairFootLift4NsTrace.final, anklePairStepHipNegative.final, anklePairStepHipPositive.final, anklePairStepResetAfterTarget.final, anklePairLateralHipZPlus008.final, anklePairLateralHipZMinus008.final, anklePairLateralHipZPlus016.final, anklePairLateralHipZMinus016.final, anklePairLateralHipZMinus024.final, anklePairLateralHipZMinus032.final, anklePairWeightShiftStep024.final, anklePairWeightShiftStep032.final, anklePairStepHipNeg020Ramp05.final, anklePairStepKneeOnlyRamp05.final, anklePairStepHipNeg035Ramp05.final, anklePairStepHipPos020Ramp05.final, anklePairStepHipNeg035Ramp10.final];
  for (const state of finalStates) {
    assert.ok(Number.isFinite(state.pelvisY), 'Physics returned a non-finite pelvis position');
    assert.ok(state.parts.every(part => part.position.every(Number.isFinite)), 'Physics returned a non-finite body position');
    assert.ok(state.parts.every(part => part.velocity.every(Number.isFinite)), 'Physics returned a non-finite body velocity');
    assert.ok(Number.isFinite(state.balanceDiagnostics.captureOmega), 'Capture-point frequency must be finite');
    assert.ok(state.balanceDiagnostics.supportPolygonXZ.every(point => point.every(Number.isFinite)), 'Support polygon must contain finite coordinates');
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
      contactAnkleTwistMedium: contactAnkleTwistMedium,
      contactAnkleTwistWide: contactAnkleTwistWide,
      contactAnkleTwistWideStrongPD: contactAnkleTwistWideStrongPD,
      freeAnkleTwistWideStrongPD: freeAnkleTwistWideStrongPD,
      contactHipSwing095: contactHipSwing095,
      contactHipSwing125: contactHipSwing125,
      contactHipSwing125Both: contactHipSwing125Both,
      hipWorldAnkleWorldContactNoRoot: hipWorldAnkleWorldContactNoRoot,
      hipWorldAnkleWorldContactRoot: hipWorldAnkleWorldContactRoot,
      hipLocalAnkleWorldContactNoRoot: hipLocalAnkleWorldContactNoRoot,
      hipWorldAnkleWorldFreeNoRoot: hipWorldAnkleWorldFreeNoRoot,
      hipWorldAnkleWorldFreeRoot: hipWorldAnkleWorldFreeRoot,
      directRootContact: directRootContact,
      directRootContactLowPD: directRootContactLowPD,
      directRootFree: directRootFree,
      hipFreeContact066: hipFreeContact066,
      hipFreeContact095: hipFreeContact095,
      hipFreeContact095LowerRoot: hipFreeContact095LowerRoot,
      hipFreeNoPlant: hipFreeNoPlant,
      ankleLocalContactWide: ankleLocalContactWide,
      ankleLocalContactWideStrongPD: ankleLocalContactWideStrongPD,
      ankleLocalContactWideMaxPD: ankleLocalContactWideMaxPD,
      ankleWorldContactWideControl: ankleWorldContactWideControl,
      ankleLocalFreeWideStrongPD: ankleLocalFreeWideStrongPD,
      directRootContactStrongPD: directRootContactStrongPD,
      directRootContactMaxPD: directRootContactMaxPD,
      anklePairFreeMaxPD: anklePairFreeMaxPD,
      anklePairContactStrongPD: anklePairContactStrongPD,
      anklePairContactMaxPD: anklePairContactMaxPD,
      anklePairContactLocalAnkle: anklePairContactLocalAnkle,
      anklePairContactMaxPD60s: anklePairContactMaxPD60s,
      anklePairContactDisturbance: anklePairContactDisturbance,
      anklePairFreeStable60s: anklePairFreeStable60s,
      anklePairFreePush2Ns: anklePairFreePush2Ns,
      anklePairFreePush4Ns: anklePairFreePush4Ns,
      anklePairFreeSide2Ns: anklePairFreeSide2Ns,
      anklePairFreeFootLift2Ns: anklePairFreeFootLift2Ns,
      anklePairFootLift4NsTrace: anklePairFootLift4NsTrace,
      anklePairStepHipNegative: anklePairStepHipNegative,
      anklePairStepHipPositive: anklePairStepHipPositive,
      anklePairStepResetAfterTarget: anklePairStepResetAfterTarget,
      anklePairLateralHipZPlus008: anklePairLateralHipZPlus008,
      anklePairLateralHipZMinus008: anklePairLateralHipZMinus008,
      anklePairLateralHipZPlus016: anklePairLateralHipZPlus016,
      anklePairLateralHipZMinus016: anklePairLateralHipZMinus016,
      anklePairLateralHipZMinus024: anklePairLateralHipZMinus024,
      anklePairLateralHipZMinus032: anklePairLateralHipZMinus032,
      anklePairWeightShiftStep024: anklePairWeightShiftStep024,
      anklePairWeightShiftStep032: anklePairWeightShiftStep032,
      anklePairStepHipNeg020Ramp05: anklePairStepHipNeg020Ramp05,
      anklePairStepKneeOnlyRamp05: anklePairStepKneeOnlyRamp05,
      anklePairStepHipNeg035Ramp05: anklePairStepHipNeg035Ramp05,
      anklePairStepHipPos020Ramp05: anklePairStepHipPos020Ramp05,
      anklePairStepHipNeg035Ramp10: anklePairStepHipNeg035Ramp10,
      anklePairPitchImpulse14Offset: anklePairPitchImpulse14Offset,
      anklePairRollImpulse14Offset: anklePairRollImpulse14Offset,
      anklePairSwingKnee110: anklePairSwingKnee110,
      anklePairSwingKnee130: anklePairSwingKnee130,
      anklePairSwingKnee145: anklePairSwingKnee145,
      anklePairSwingLongerReach: anklePairSwingLongerReach,
      weightShiftMinus024: weightShiftMinus024,
      weightShiftMinus032: weightShiftMinus032,
      weightShiftMinus040: weightShiftMinus040,
      footSwingLiftOnly: footSwingLiftOnly,
      footSwingForwardShort: footSwingForwardShort,
      footSwingForwardMedium: footSwingForwardMedium,
      footSwingForwardMediumLowTorque: footSwingForwardMediumLowTorque,
      closedLoopUnloadStep: closedLoopUnloadStep,
      closedLoopUnloadStep300: closedLoopUnloadStep300,
      closedLoopUnloadStep320: closedLoopUnloadStep320,
      closedLoopUnloadStep320Adaptive: closedLoopUnloadStep320Adaptive,
      closedLoopUnloadStep320Conservative: closedLoopUnloadStep320Conservative,
      preflexSwingShort: preflexSwingShort,
      preflexSwingMedium: preflexSwingMedium,
      pinnedFeetRootImpulseAt5s: pinnedFeetRootImpulseAt5s
    },
    browserErrors: errors
  };

  const supportProbe = report.scenarios.directRootContactMaxPD.final.balanceDiagnostics;
  assert.ok(supportProbe.contactPointCount > 0, 'Jolt floor manifold did not expose any foot contact points');
  assert.ok(supportProbe.supportPolygonXZ.length >= 3, 'Expected a 2D convex support polygon from both feet');
  assert.ok(Number.isFinite(supportProbe.comProjectionMargin), 'COM support margin should be finite');
  assert.ok(Number.isFinite(supportProbe.capturePointMargin), 'Capture-point support margin should be finite');
  for (const probe of [
    report.scenarios.anklePairPitchImpulse14Offset,
    report.scenarios.anklePairRollImpulse14Offset
  ]) {
    const peakOmega = Math.max(...probe.samples.map(sample =>
      Math.hypot(...sample.pelvisAngularVelocity)
    ));
    assert.ok(peakOmega > 0.1, 'Off-centre impulse must produce measurable pelvis angular velocity');
  }
  for (const name of ['footSwingLiftOnly', 'footSwingForwardShort', 'footSwingForwardMedium', 'footSwingForwardMediumLowTorque']) {
    const probe = report.scenarios[name];
    assert.ok(probe.samples.some(sample => sample.footSwing && sample.footSwing.active), name + ' must activate Cartesian foot control');
    assert.ok(probe.samples.every(sample => Number.isFinite(sample.footSwing.positionError ?? 0)), name + ' must expose finite target error');
    if (probe.final.footSwing.completed) {
      assert.ok(probe.final.footSwing.landingError <= 0.055, name + ' must complete only near its landing target');
      assert.ok(probe.final.footSwing.landingSpeed <= 0.45, name + ' must complete only at low landing speed');
    }
  }

  for (const name of ['closedLoopUnloadStep', 'closedLoopUnloadStep300', 'closedLoopUnloadStep320', 'closedLoopUnloadStep320Adaptive', 'closedLoopUnloadStep320Conservative']) {
    const unloadProbe = report.scenarios[name];
    assert.ok(unloadProbe.samples.length > 0, name + ' must emit control samples');
    assert.ok(unloadProbe.samples.every(sample =>
      Number.isFinite(sample.targetAngle) && Number.isFinite(sample.pelvisY)
    ), name + ' diagnostics must remain finite');
    assert.ok(unloadProbe.samples.every(sample =>
      sample.targetAngle >= unloadProbe.maxAngle - 0.000001 && sample.targetAngle <= 0.000001
    ), name + ' must respect its configured bounded hip target');
  }

  for (const name of ['preflexSwingShort', 'preflexSwingMedium']) {
    const probe = report.scenarios[name];
    assert.ok(probe.samples.length > 0, name + ' must emit preflex/swing samples');
    assert.ok(probe.samples.every(sample => Number.isFinite(sample.pelvisY) && Number.isFinite(sample.pelvisUp)), name + ' posture samples must remain finite');
    assert.ok(probe.samples.every(sample => sample.leftFootPosition && sample.leftFootPosition.every(Number.isFinite)), name + ' must report finite swing-foot positions');
  }

  const anklePairProbe = report.scenarios.anklePairContactMaxPD.final;
  assert.equal(anklePairProbe.rootUpright.mode, 'ankle-pair', 'Ankle-pair experiment should use its requested actuator route');
  assert.ok(anklePairProbe.joints.filter(joint => joint.type === 'ankle').every(joint => Number.isFinite(joint.appliedTorque)), 'Ankle-pair torques must be finite');
  assert.ok(anklePairProbe.balanceDiagnostics.contactPointCount > 0, 'Ankle-pair experiment must retain floor contact points');
  const freeStandProbe = report.scenarios.anklePairFreeStable60s.final;
  assert.equal(freeStandProbe.stanceDiagnostics.footPlantEnabled, false, 'Free-stand regression must not use foot-plant');
  assert.ok(freeStandProbe.pelvisY > 1.0, 'Free ankle-pair stance must keep the pelvis near standing height');
  assert.ok(freeStandProbe.pelvisUp > 0.98, 'Free ankle-pair stance must keep the pelvis upright');
  assert.equal(freeStandProbe.groundedFeet.length, 2, 'Both feet must remain in contact during the free-stand regression');
  assert.ok(freeStandProbe.balanceDiagnostics.comProjectionMargin > 0.1, 'COM must remain safely inside the support polygon');
  assert.equal(freeStandProbe.rootUpright.supportAnkles.length, 2, 'Double support should route correction through both ankles');
  const resetProbe = report.scenarios.anklePairStepResetAfterTarget.final;
  const resetKnees = resetProbe.joints.filter(joint => joint.type === 'knee');
  assert.ok(resetProbe.pelvisY > 1.0 && resetProbe.pelvisUp > 0.98, 'Reset after a commanded knee bend must return to a standing pose');
  assert.equal(resetProbe.groundedFeet.length, 2, 'Reset after a commanded knee bend must restore double support');
  assert.ok(resetKnees.every(joint => Math.abs(joint.targetHingeAngle) < 1e-8), 'Reset must restore neutral hinge targets');
  const preLiftShift = report.scenarios.anklePairWeightShiftStep024.samples.find(sample => Math.abs(sample.time - 4.0) < 0.01);
  assert.ok(preLiftShift, 'Expected a pre-lift weight-shift sample');
  assert.ok(preLiftShift.balanceDiagnostics.footSupport.foot_R.capturePointMargin > 0.02, 'Right-foot capture-point margin must be positive before left-foot toe-off');
  const shiftPlus = report.scenarios.anklePairLateralHipZPlus016.final.com[0];
  const shiftMinus = report.scenarios.anklePairLateralHipZMinus016.final.com[0];
  assert.ok(shiftPlus < -0.05 && shiftMinus > 0.05, 'Right stance-hip frontal target must have a measured, sign-consistent COM shift');
  for (const probe of [
    report.scenarios.anklePairFootLift4NsTrace,
    report.scenarios.anklePairStepHipNegative,
    report.scenarios.anklePairStepHipPositive,
    report.scenarios.anklePairStepResetAfterTarget,
    report.scenarios.anklePairLateralHipZPlus008,
    report.scenarios.anklePairLateralHipZMinus008,
    report.scenarios.anklePairLateralHipZPlus016,
    report.scenarios.anklePairLateralHipZMinus016,
    report.scenarios.anklePairLateralHipZMinus024,
    report.scenarios.anklePairLateralHipZMinus032,
    report.scenarios.anklePairWeightShiftStep024,
    report.scenarios.anklePairWeightShiftStep032,
    report.scenarios.anklePairStepHipNeg020Ramp05,
    report.scenarios.anklePairStepKneeOnlyRamp05,
    report.scenarios.anklePairStepHipNeg035Ramp05,
    report.scenarios.anklePairStepHipPos020Ramp05,
    report.scenarios.anklePairStepHipNeg035Ramp10,
    report.scenarios.anklePairPitchImpulse14Offset,
    report.scenarios.anklePairRollImpulse14Offset,
    report.scenarios.anklePairSwingKnee110,
    report.scenarios.anklePairSwingKnee130,
    report.scenarios.anklePairSwingKnee145,
    report.scenarios.anklePairSwingLongerReach,
    report.scenarios.footSwingLiftOnly,
    report.scenarios.footSwingForwardShort,
    report.scenarios.footSwingForwardMedium,
    report.scenarios.footSwingForwardMediumLowTorque
  ]) {
    assert.ok(probe.samples.length > 0, 'High-frequency probe must return samples');
    assert.ok(probe.samples.every(sample => Number.isFinite(sample.leftFoot.position[1])), 'Probe positions must be finite');
  }

  fs.writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log('LOWER_BODY_REPORT=' + JSON.stringify(report));
  assert.equal(errors.length, 0, 'Browser errors: ' + errors.join('\n'));
  console.log('PASS: lower-body-only Jolt WASM scene created and simulated');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}