import fs from 'node:fs';

const path = new URL('./src/main.js', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error('Patch anchor not found: ' + label);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error('Patch anchor is not unique: ' + label);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  'let totalRagdollMass = 0;\nlet raycaster;',
  `let totalRagdollMass = 0;
let contactListener = null;
let floorBodyKey = null;
let contactTrackingReady = false;
const partNameByBodyKey = new Map();
const liveContactPairs = new Set();
const floorContactFeet = new Set();
const selfContactPairs = new Set();
const contactEventStats = { added: 0, persisted: 0, removed: 0 };
let raycaster;`,
  'contact state'
);

replaceOnce(
  'function setupJolt() {',
  `function contactPairKey(a, b) {
  return a < b ? (a + ':' + b) : (b + ':' + a);
}

function refreshContactMetadata() {
  floorContactFeet.clear();
  selfContactPairs.clear();
  for (const key of liveContactPairs) {
    const pairIds = key.split(':').map(Number);
    const a = pairIds[0];
    const b = pairIds[1];
    if (a === floorBodyKey || b === floorBodyKey) {
      const partKey = a === floorBodyKey ? b : a;
      const name = partNameByBodyKey.get(partKey);
      if (name && name.startsWith('foot_')) floorContactFeet.add(name);
      continue;
    }
    const nameA = partNameByBodyKey.get(a);
    const nameB = partNameByBodyKey.get(b);
    if (nameA && nameB) selfContactPairs.add([nameA, nameB].sort().join('<->'));
  }
}

function installJoltContactListener() {
  contactListener = new Jolt.ContactListenerJS();
  contactListener.OnContactValidate = () => Jolt.ValidateResult_AcceptAllContactsForThisBodyPair;
  const setPair = (body1Pointer, body2Pointer, active, kind) => {
    const body1 = Jolt.wrapPointer(body1Pointer, Jolt.Body);
    const body2 = Jolt.wrapPointer(body2Pointer, Jolt.Body);
    const id1 = body1.GetID().GetIndexAndSequenceNumber();
    const id2 = body2.GetID().GetIndexAndSequenceNumber();
    const key = contactPairKey(id1, id2);
    if (active) liveContactPairs.add(key);
    else liveContactPairs.delete(key);
    contactEventStats[kind] += 1;
  };
  contactListener.OnContactAdded = (body1, body2) => setPair(body1, body2, true, 'added');
  contactListener.OnContactPersisted = (body1, body2) => setPair(body1, body2, true, 'persisted');
  contactListener.OnContactRemoved = (pairPointer) => {
    const pair = Jolt.wrapPointer(pairPointer, Jolt.SubShapeIDPair);
    const id1 = pair.GetBody1ID().GetIndexAndSequenceNumber();
    const id2 = pair.GetBody2ID().GetIndexAndSequenceNumber();
    liveContactPairs.delete(contactPairKey(id1, id2));
    contactEventStats.removed += 1;
  };
  physicsSystem.SetContactListener(contactListener);
}

function setupJolt() {`,
  'listener helper'
);

replaceOnce(
  '  physicsSystem = joltInterface.GetPhysicsSystem();\n  bodyInterface = physicsSystem.GetBodyInterface();',
  '  physicsSystem = joltInterface.GetPhysicsSystem();\n  bodyInterface = physicsSystem.GetBodyInterface();\n  installJoltContactListener();',
  'listener registration'
);

replaceOnce(
  '  const body = bodyInterface.CreateBody(settings);\n  bodyInterface.AddBody(body.GetID(), Jolt.EActivation_DontActivate);',
  '  const body = bodyInterface.CreateBody(settings);\n  floorBodyKey = body.GetID().GetIndexAndSequenceNumber();\n  bodyInterface.AddBody(body.GetID(), Jolt.EActivation_DontActivate);',
  'floor body id'
);

replaceOnce(
  '    const bodyId = new Jolt.BodyID(body.GetID().GetIndexAndSequenceNumber());\n    bodyInterface.AddBody(bodyId, Jolt.EActivation_Activate);',
  '    const bodyId = new Jolt.BodyID(body.GetID().GetIndexAndSequenceNumber());\n    partNameByBodyKey.set(bodyId.GetIndexAndSequenceNumber(), descriptor.name);\n    bodyInterface.AddBody(bodyId, Jolt.EActivation_Activate);',
  'ragdoll body id'
);

replaceOnce(
  "  if (ragdollGroupFilter && typeof ragdollGroupFilter.IsCollisionEnabled === 'function') {",
  "  if (!new URLSearchParams(window.location.search).has('no-self-collision') && ragdollGroupFilter && typeof ragdollGroupFilter.IsCollisionEnabled === 'function') {",
  'skip expected collision filter assertion in isolated A/B mode'
);

replaceOnce(
  '  descriptors.forEach((descriptor, index) => {',
  `  if (new URLSearchParams(window.location.search).has('no-self-collision')) {
    for (let a = 0; a < descriptors.length; a += 1) {
      for (let b = a + 1; b < descriptors.length; b += 1) ragdollGroupFilter.DisableCollision(a, b);
    }
  }
  descriptors.forEach((descriptor, index) => {`,
  'A/B no self collision switch'
);

const oldGrounding = [
  '  // A foot is considered planted only while its sole is near the floor and',
  '  // its vertical speed is low. This is a lightweight contact estimator; the',
  '  // Jolt collision solver remains responsible for the actual ground reaction.',
  '  balanceAI.groundedCount = 0;',
].join('\n');
const newGrounding = [
  '  // Jolt contact callbacks provide the actual foot-floor support state.',
  '  refreshContactMetadata();',
  '  balanceAI.groundedCount = 0;',
].join('\n');
replaceOnce(oldGrounding, newGrounding, 'contact measurement header');

replaceOnce(
  '    foot.grounded = foot.bottomY < 0.035 && Math.abs(v.y) < 0.75;',
  `    foot.grounded = contactTrackingReady
      ? floorContactFeet.has(foot.name)
      : foot.bottomY < 0.035 && Math.abs(v.y) < 0.75;`,
  'contact based grounded'
);

replaceOnce(
  '    setMuscleStrength: updateMuscleStrength,',
  `    setMuscleStrength: updateMuscleStrength,
    setBalanceAIEnabled(enabled) {
      balanceAI.enabled = !!enabled;
      balanceAI.step = null;
      restoreBaselineActivations();
    },`,
  'headless AI enable switch'
);

replaceOnce(
  '    if (jointTorqueA.lengthSq() < 1e-10) continue;',
  `    if (new URLSearchParams(window.location.search).has('reverse-muscle-torque')) jointTorqueA.negate();
    if (jointTorqueA.lengthSq() < 1e-10) continue;`,
  'experimental reverse torque sign switch'
);

replaceOnce(
  '    torqueStats.maxRequested = Math.max(torqueStats.maxRequested, Math.abs(requestedTorque));',
  '    joint.requestedTorque = requestedTorque;\n    torqueStats.maxRequested = Math.max(torqueStats.maxRequested, Math.abs(requestedTorque));',
  'store requested torque on joint'
);

replaceOnce(
  '      torque: joint.appliedTorque ?? 0,',
  `      torque: joint.appliedTorque ?? 0,
      requestedTorque: joint.requestedTorque ?? 0,
      targetRelative: joint.targetRelative.toArray(),
      relativeErrorRad: (() => {
        const desired = joint.parent.worldRotation.clone().multiply(joint.targetRelative);
        const error = desired.multiply(joint.child.worldRotation.clone().invert()).normalize();
        return 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(error.w), -1, 1));
      })(),`,
  'requested torque and relative angle telemetry'
);

replaceOnce(
  '  joltInterface.Step(FIXED_DT, 1);\n  testStepCount += 1;',
  '  joltInterface.Step(FIXED_DT, 1);\n  contactTrackingReady = true;\n  testStepCount += 1;',
  'contact tracking activation'
);

replaceOnce(
  '    torque: { ...torqueStats },\n    parts: ragdollParts.map((part) => ({',
  `    torque: { ...torqueStats },
    contacts: {
      trackingReady: contactTrackingReady,
      groundedFeet: [...floorContactFeet],
      selfPairs: [...selfContactPairs],
      livePairCount: liveContactPairs.size,
      events: { ...contactEventStats },
    },
    getUpTimer: balanceAI.getUpTimer,
    fallTimer: balanceAI.fallTimer,
    aiScores: { ...balanceAI.scores },
    stepPlan: balanceAI.step ? {
      side: balanceAI.step.side,
      elapsed: balanceAI.step.elapsed,
      duration: balanceAI.step.duration,
      start: balanceAI.step.start.toArray(),
      target: balanceAI.step.target.toArray(),
    } : null,
    totalMass: totalRagdollMass,
    parts: ragdollParts.map((part) => ({`,
  'contact telemetry'
);

replaceOnce(
  '    const kp = joint.baseKp * kpScale;',
  `    const motorGain = Number(new URLSearchParams(window.location.search).get('motor-gain') || 1);
    const kp = joint.baseKp * kpScale * motorGain;`,
  'motor gain A/B scale'
);

replaceOnce(
  '    const kd = joint.baseKd * kdScale;',
  '    const kd = joint.baseKd * kdScale * Math.sqrt(motorGain) * (new URLSearchParams(window.location.search).has("low-damping") ? 0.3 : 1);',
  'experimental low damping scale'
);

replaceOnce(
  '      requestedTorque = pd.requested;',
  `      requestedTorque = pd.requested;
      joint.orientationErrorAngle = Math.abs(joint.targetHingeAngle - angle);
      joint.relativeAngularSpeed = Math.abs(angularSpeed);
      joint.springTorque = Math.abs(kp * (joint.targetHingeAngle - angle));
      joint.dampingTorque = Math.abs(kd * angularSpeed);`,
  'hinge spring-damping telemetry'
);

replaceOnce(
  '      jointTorqueA.copy(tempErrorAxis).multiplyScalar(kp).addScaledVector(relativeAngularVelocity, -kd);',
  `      const springTorqueVector = tempErrorAxis.clone().multiplyScalar(kp);
      const dampingTorqueVector = relativeAngularVelocity.clone().multiplyScalar(-kd);
      joint.orientationErrorAngle = angle;
      joint.relativeAngularSpeed = relativeAngularVelocity.length();
      joint.springTorque = springTorqueVector.length();
      joint.dampingTorque = dampingTorqueVector.length();
      jointTorqueA.copy(springTorqueVector).add(dampingTorqueVector);`,
  'swing twist spring-damping telemetry'
);

replaceOnce(
  '      requestedTorque: joint.requestedTorque ?? 0,',
  `      requestedTorque: joint.requestedTorque ?? 0,
      springTorque: joint.springTorque ?? 0,
      dampingTorque: joint.dampingTorque ?? 0,
      orientationErrorAngle: joint.orientationErrorAngle ?? 0,
      relativeAngularSpeed: joint.relativeAngularSpeed ?? 0,`,
  'snapshot spring damping and velocity telemetry'
);

replaceOnce(
  '  const target = start.clone().add(direction);',
  `  const target = start.clone().add(direction);
  if (new URLSearchParams(window.location.search).has('wide-step')) {
    const sideOffset = side === 'L' ? -0.18 : 0.18;
    const errorX = balanceAI.capture.x - balanceAI.supportCenter.x;
    const errorZ = balanceAI.capture.z - balanceAI.supportCenter.z;
    target.x = clamp(balanceAI.capture.x + sideOffset, -0.72, 0.72);
    target.z = clamp(balanceAI.capture.z + Math.sign(errorZ || 1) * 0.045, -0.62, 0.78);
    const delta = target.clone().sub(start);
    if (delta.length() > 0.32) target.copy(start).add(delta.setLength(0.32));
  }`,
  'A/B preserve stance width and place step beyond capture point'
);

replaceOnce(
  '  const ankleTargets = computeAnkleBalanceTargets(errorX, errorZ, 2.4, 0.42);',
  `  const ankleTargets = computeAnkleBalanceTargets(errorX, errorZ, 2.4, 0.42);
  if (new URLSearchParams(window.location.search).has('reverse-ankle-pitch')) ankleTargets.pitch *= -1;`,
  'A/B reverse ankle pitch command'
);

replaceOnce(
  '  const hipPitch = clamp(-Math.atan2(errorZ, height) * 0.48, -0.18, 0.18);',
  "  const hipPitch = clamp(-Math.atan2(errorZ, height) * 0.48, -0.18, 0.18) * (new URLSearchParams(window.location.search).has('reverse-hip-pitch') ? -1 : 1);",
  'A/B reverse hip pitch command'
);

replaceOnce(
  '  const torsoPitch = clamp(-Math.atan2(errorZ, height) * 0.62, -0.24, 0.24);',
  "  const torsoPitch = clamp(-Math.atan2(errorZ, height) * 0.62, -0.24, 0.24) * (new URLSearchParams(window.location.search).has('reverse-spine-pitch') ? -1 : 1);",
  'A/B reverse spine pitch command'
);

replaceOnce("    addCapsuleDescriptor(descriptors, `shin_${suffix}`, [x, 0.18, -0.015], [x, 0.66, 0], 0.067, 2.3, 0x779c91, 'legs');\n    addCapsuleDescriptor(descriptors, `thigh_${suffix}`, [x, 0.66, 0], [x, 1.055, 0], 0.088, 4.3, 0x648778, 'legs');\n\n    joints.push({ a: `shin_${suffix}`, b: `foot_${suffix}`, anchor: [x, 0.13, -0.08], type: 'ankle' });", "    // The shin endpoint and foot pivot must be the same point. The previous\n    // version had a 9.2 cm offset here, causing a large startup constraint impulse.\n    const ankle = [x, 0.13, -0.08];\n    addCapsuleDescriptor(descriptors, `shin_${suffix}`, ankle, [x, 0.66, 0], 0.067, 2.3, 0x779c91, 'legs');\n    addCapsuleDescriptor(descriptors, `thigh_${suffix}`, [x, 0.66, 0], [x, 1.055, 0], 0.088, 4.3, 0x648778, 'legs');\n\n    joints.push({ a: `shin_${suffix}`, b: `foot_${suffix}`, anchor: ankle, type: 'ankle' });", 'align ankle capsule and joint anchor');
replaceOnce("    const shoulder = [sign * 0.13, 1.70, 0];\n    const elbow = [sign * 0.24, 1.39, 0.015];\n    const wrist = [sign * 0.27, 1.10, 0.10];\n    addCapsuleDescriptor(descriptors, `upperarm_${suffix}`, shoulder, elbow, 0.062, 1.55, 0xc89a75, 'arms');\n    addCapsuleDescriptor(descriptors, `forearm_${suffix}`, elbow, wrist, 0.053, 1.15, 0xb98967, 'arms');\n    addBoxDescriptor(descriptors, `fist_${suffix}`, [sign * 0.27, 1.045, 0.16], [0.062, 0.065, 0.085], 0.72, 0x9e785f, 'arms');", "    // Neutral arms hang outside the torso and thighs instead of intersecting them.\n    const shoulder = [sign * 0.18, 1.70, 0];\n    const elbow = [sign * 0.33, 1.39, 0.015];\n    const wrist = [sign * 0.34, 1.10, 0.10];\n    addCapsuleDescriptor(descriptors, `upperarm_${suffix}`, shoulder, elbow, 0.052, 1.55, 0xc89a75, 'arms');\n    addCapsuleDescriptor(descriptors, `forearm_${suffix}`, elbow, wrist, 0.046, 1.15, 0xb98967, 'arms');\n    addBoxDescriptor(descriptors, `fist_${suffix}`, [sign * 0.34, 1.045, 0.16], [0.052, 0.055, 0.075], 0.72, 0x9e785f, 'arms');", 'remove neutral-pose arm self intersections');
replaceOnce("  const target = start.clone().add(direction);\n  if (new URLSearchParams(window.location.search).has('wide-step')) {", "  const target = start.clone().add(direction);\n  // A sagittal recovery step must preserve the lateral stance lane. Only move\n  // the foot sideways when the capture point has a real lateral error.\n  if (!new URLSearchParams(window.location.search).has('wide-step')) {\n    const lateralError = balanceAI.capture.x - balanceAI.supportCenter.x;\n    const forwardError = balanceAI.capture.z - balanceAI.supportCenter.z;\n    const sideSign = side === 'L' ? -1 : 1;\n    const stanceLane = balanceAI.groundedCount === 1\n      ? supportFoot.worldPosition.x + sideSign * 0.36\n      : balanceAI.supportCenter.x + sideSign * 0.18;\n    target.x = clamp(stanceLane + clamp(lateralError * 0.45, -0.09, 0.09), -0.72, 0.72);\n    target.z = clamp(start.z + clamp(forwardError * 0.72, -0.24, 0.24), -0.62, 0.78);\n  }\n  if (new URLSearchParams(window.location.search).has('wide-step')) {", 'preserve lateral lane during sagittal step');
fs.writeFileSync(path, source);

const testPath = new URL('./test/headless.mjs', import.meta.url);
let testSource = fs.readFileSync(testPath, 'utf8');
function replaceTestOnce(before, after, label) {
  const first = testSource.indexOf(before);
  if (first < 0) throw new Error('Test patch anchor not found: ' + label);
  if (testSource.indexOf(before, first + before.length) >= 0) throw new Error('Test patch anchor is not unique: ' + label);
  testSource = testSource.slice(0, first) + after + testSource.slice(first + before.length);
}
replaceTestOnce("  for (const strength of [0.5, 1, 1.6]) {\n    await page.evaluate(v => { window.__ragdollTest.reset(); window.__ragdollTest.setMuscleStrength(v); }, strength);", "  for (const strength of [0.5, 1, 1.6]) {\n    await page.evaluate(v => {\n      window.__ragdollTest.reset();\n      window.__ragdollTest.setBalanceAIEnabled(true);\n      window.__ragdollTest.setMuscleStrength(v);\n    }, strength);", 'enable AI in the 30 second stability test');
replaceTestOnce("    for (let elapsed = 0; elapsed < 1800; elapsed += 60) {\n      state = await page.evaluate(() => window.__ragdollTest.step(60));", "    // Sample every 0.5 s: 1-second sampling hid the early collapse time.\n    for (let elapsed = 0; elapsed < 1800; elapsed += 30) {\n      state = await page.evaluate(() => window.__ragdollTest.step(30));", 'increase stability sampling rate');
replaceTestOnce("  await page.evaluate(() => { window.__ragdollTest.reset(); window.__ragdollTest.setMuscleStrength(1); window.__ragdollTest.applyImpulse('spine_4', 0, 0, -8); });\n  const recovery=[];\n  for (let i=0;i<12;i++) {\n    const s=await page.evaluate(()=>window.__ragdollTest.step(60));", "  await page.evaluate(() => {\n    window.__ragdollTest.reset();\n    window.__ragdollTest.setBalanceAIEnabled(true);\n    window.__ragdollTest.setMuscleStrength(1);\n    window.__ragdollTest.applyImpulse('spine_4', 0, 0, -4);\n  });\n  const recovery=[];\n  for (let i=0;i<24;i++) {\n    const s=await page.evaluate(()=>window.__ragdollTest.step(30));", 'enable AI during recovery test');
replaceTestOnce("  console.log('RECOVERY_12S=' + JSON.stringify(recovery));\n\n  const final = await page.evaluate(() => window.__ragdollTest.snapshot());", "  console.log('RECOVERY_12S=' + JSON.stringify(recovery));\n\n  // Separate impulse test: record actual foot displacement and any selected step.\n  const stepResponsePage = await browser.newPage();\n  stepResponsePage.on('pageerror', e => errors.push(String(e)));\n  stepResponsePage.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });\n  await stepResponsePage.goto('http://127.0.0.1:4173/?test=1', { waitUntil: 'networkidle' });\n  await stepResponsePage.waitForFunction(() => !!window.__ragdollTest, { timeout: 30000 });\n  await stepResponsePage.evaluate(() => {\n    window.__ragdollTest.setBalanceAIEnabled(true);\n    window.__ragdollTest.setMuscleStrength(1);\n    window.__ragdollTest.applyImpulse('spine_4', 0, 0, 1.5);\n  });\n  const stepResponse = [];\n  for (let i = 0; i < 20; i++) {\n    const s = await stepResponsePage.evaluate(() => window.__ragdollTest.step(12));\n    stepResponse.push({time:s.time,mode:s.mode,action:s.action,uprightness:s.uprightness,stepPlan:s.stepPlan,pelvisY:s.pelvisY,feet:s.parts.filter(p=>p.name.startsWith('foot_')).map(p=>({name:p.name,position:p.position,velocity:p.velocity,grounded:p.grounded}))});\n  }\n  console.log('STEP_RESPONSE=' + JSON.stringify(stepResponse));\n  await stepResponsePage.close();\n\n  const final = await page.evaluate(() => window.__ragdollTest.snapshot());", 'add observable step response test');
fs.writeFileSync(testPath, testSource);

console.log('Applied geometry, step and headless-test patches');
