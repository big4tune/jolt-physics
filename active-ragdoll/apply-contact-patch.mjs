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

fs.writeFileSync(path, source);
console.log('Applied contact-driven support patch to src/main.js');
