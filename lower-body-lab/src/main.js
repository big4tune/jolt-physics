import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import initJolt from '../../jolt-physics.wasm-compat.js';
import './style.css';

const FIXED_DT = 1 / 60;
const TEST_MODE = new URLSearchParams(window.location.search).get('test') === '1';
const QUERY = new URLSearchParams(window.location.search);
const PIN_FEET = QUERY.has('pin-feet');
const DISABLE_SELF_COLLISIONS = QUERY.has('no-self-collision');
const DISABLE_FLOOR_COLLISIONS = QUERY.has('no-floor-contact');
const FOOT_START_GAP = Math.max(0, Math.min(0.08, Number(QUERY.get('foot-gap') || 0)));
const LAYER_NON_MOVING = 0;
const LAYER_MOVING = 1;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const CAPSULE_UP = new THREE.Vector3(0, 1, 0);

const viewport = document.querySelector('#viewport');
const engineState = document.querySelector('#engine-state');
const stateLabel = document.querySelector('#state-label');
const errorOverlay = document.querySelector('#error-overlay');
const muscleSlider = document.querySelector('#muscle-strength');
const muscleValue = document.querySelector('#muscle-value');
const stiffnessSlider = document.querySelector('#controller-stiffness');
const stiffnessValue = document.querySelector('#stiffness-value');
const resetButton = document.querySelector('#reset-button');
const impulseButton = document.querySelector('#impulse-button');

const metricPelvis = document.querySelector('#pelvis-height');
const metricUpright = document.querySelector('#uprightness');
const metricGrounded = document.querySelector('#grounded-feet');
const metricTorque = document.querySelector('#max-torque');
const diagnostics = document.querySelector('#controller-diagnostics');

let Jolt = null;
let joltInterface = null;
let physicsSystem = null;
let bodyInterface = null;
let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let floorBodyKey = null;
let contactListener = null;
let ragdollGroupFilter = null;
let contactTrackingReady = false;
let simulationReady = false;
let accumulator = 0;
let lastFrameTime = 0;
let testStepCount = 0;
let currentMuscleStrength = Number(muscleSlider.value) / 100;
let controllerStiffness = Number(stiffnessSlider.value) / 100;

const parts = [];
const partByName = new Map();
const shapes = [];
const joints = [];
const liveContactPairs = new Set();
const bodyNameById = new Map();
const floorContactFeet = new Set();
const selfContactPairs = new Set();
const contactEventStats = { added: 0, persisted: 0, removed: 0 };
const torqueStats = { maxRequested: 0, maxApplied: 0, saturated: 0, active: 0 };
const jointTorqueScale = { hip: 1, knee: 1, ankle: 1 };
const jointTorqueSign = { hip: 1, knee: 1, ankle: 1 };
const worldTargetMode = { hip: false, ankle: false };
let rootUprightEnabled = false;
let rootUprightSign = 1;
let rootUprightKp = 140;
let rootUprightKd = 18;
let rootUprightMaxMoment = 240;
let lastRootUprightTorque = new THREE.Vector3();
const torqueChildJolt = null;
const torqueParentJolt = null;

function setStatus(message, state) {
  stateLabel.textContent = message;
  engineState.classList.toggle('ready', state === 'ready');
  engineState.classList.toggle('error', state === 'error');
}

function showError(error) {
  console.error(error);
  const message = error instanceof Error ? error.stack || error.message : String(error);
  errorOverlay.textContent = 'Ошибка запуска лаборатории:\n' + message;
  errorOverlay.classList.remove('hidden');
  setStatus('Ошибка запуска', 'error');
}

function makeJoltVec3(x, y, z) {
  return new Jolt.Vec3(x, y, z);
}

function makeJoltRVec3(x, y, z) {
  return new Jolt.RVec3(x, y, z);
}

function makeJoltQuat(q) {
  return new Jolt.Quat(q.x, q.y, q.z, q.w);
}

function addCapsuleDescriptor(list, name, start, end, radius, mass, color, group) {
  const a = new THREE.Vector3(start[0], start[1], start[2]);
  const b = new THREE.Vector3(end[0], end[1], end[2]);
  const direction = b.clone().sub(a);
  const length = direction.length();
  const halfCylinder = Math.max(0.012, (length - radius * 2) * 0.5);
  const position = a.clone().add(b).multiplyScalar(0.5);
  const rotation = new THREE.Quaternion().setFromUnitVectors(CAPSULE_UP, direction.normalize());
  list.push({
    name: name,
    shape: { type: 'capsule', radius: radius, halfCylinder: halfCylinder },
    position: position,
    rotation: rotation,
    mass: mass,
    color: color,
    group: group
  });
}

function addBoxDescriptor(list, name, position, halfExtents, mass, color, group) {
  list.push({
    name: name,
    shape: { type: 'box', halfExtents: new THREE.Vector3(halfExtents[0], halfExtents[1], halfExtents[2]) },
    position: new THREE.Vector3(position[0], position[1], position[2]),
    rotation: new THREE.Quaternion(),
    mass: mass,
    color: color,
    group: group
  });
}

function buildLowerBodyDescriptors() {
  const descriptors = [];
  const jointDefs = [];
  addBoxDescriptor(descriptors, 'pelvis', [0, 1.145, 0], [0.20, 0.13, 0.12], 7.0, 0x54738a, 'core');

  const sides = [
    { suffix: 'L', sign: -1 },
    { suffix: 'R', sign: 1 }
  ];

  for (const side of sides) {
    const x = side.sign * 0.18;

    addCapsuleDescriptor(descriptors, 'thigh_' + side.suffix, [x, 0.66, 0], [x, 1.055, 0], 0.088, 4.3, 0x648778, 'legs');
    addCapsuleDescriptor(descriptors, 'shin_' + side.suffix, [x, 0.13, -0.08], [x, 0.66, 0], 0.067, 2.3, 0x779c91, 'legs');
    addBoxDescriptor(descriptors, 'foot_' + side.suffix, [x, 0.065 + FOOT_START_GAP, 0.075], [0.115, 0.065, 0.215], 1.25, 0x647b88, 'feet');

    jointDefs.push({ a: 'pelvis', b: 'thigh_' + side.suffix, anchor: [x, 1.055, 0], type: 'hip' });
    jointDefs.push({ a: 'thigh_' + side.suffix, b: 'shin_' + side.suffix, anchor: [x, 0.66, 0], type: 'knee' });
    jointDefs.push({ a: 'shin_' + side.suffix, b: 'foot_' + side.suffix, anchor: [x, 0.13, -0.08], type: 'ankle' });
  }

  return { descriptors: descriptors, joints: jointDefs };
}

function makeContactPairKey(a, b) {
  return a < b ? String(a) + ':' + String(b) : String(b) + ':' + String(a);
}

function installContactListener() {
  contactListener = new Jolt.ContactListenerJS();
  contactListener.OnContactValidate = function () {
    return Jolt.ValidateResult_AcceptAllContactsForThisBodyPair;
  };

  function setPair(body1Pointer, body2Pointer, active, kind) {
    const body1 = Jolt.wrapPointer(body1Pointer, Jolt.Body);
    const body2 = Jolt.wrapPointer(body2Pointer, Jolt.Body);
    const id1 = body1.GetID().GetIndexAndSequenceNumber();
    const id2 = body2.GetID().GetIndexAndSequenceNumber();
    const key = makeContactPairKey(id1, id2);
    if (active) liveContactPairs.add(key);
    else liveContactPairs.delete(key);
    contactEventStats[kind] += 1;
  }

  contactListener.OnContactAdded = function (a, b) {
    setPair(a, b, true, 'added');
  };
  contactListener.OnContactPersisted = function (a, b) {
    setPair(a, b, true, 'persisted');
  };
  contactListener.OnContactRemoved = function (pairPointer) {
    const pair = Jolt.wrapPointer(pairPointer, Jolt.SubShapeIDPair);
    const id1 = pair.GetBody1ID().GetIndexAndSequenceNumber();
    const id2 = pair.GetBody2ID().GetIndexAndSequenceNumber();
    liveContactPairs.delete(makeContactPairKey(id1, id2));
    contactEventStats.removed += 1;
  };

  physicsSystem.SetContactListener(contactListener);
}

function refreshContactMetadata() {
  floorContactFeet.clear();
  selfContactPairs.clear();

  for (const key of liveContactPairs) {
    const ids = key.split(':').map(Number);
    const a = ids[0];
    const b = ids[1];

    if (a === floorBodyKey || b === floorBodyKey) {
      const other = a === floorBodyKey ? b : a;
      const name = bodyNameById.get(other);
      if (name && name.indexOf('foot_') === 0) floorContactFeet.add(name);
      continue;
    }

    const nameA = bodyNameById.get(a);
    const nameB = bodyNameById.get(b);
    if (nameA && nameB) selfContactPairs.add([nameA, nameB].sort().join('<->'));
  }
}

function setupJolt() {
  const settings = new Jolt.JoltSettings();
  settings.mMaxWorkerThreads = 2;

  const objectFilter = new Jolt.ObjectLayerPairFilterTable(2);
  if (!DISABLE_FLOOR_COLLISIONS) objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
  objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);

  const staticLayer = new Jolt.BroadPhaseLayer(0);
  const movingLayer = new Jolt.BroadPhaseLayer(1);
  const broadPhase = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
  broadPhase.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, staticLayer);
  broadPhase.MapObjectToBroadPhaseLayer(LAYER_MOVING, movingLayer);
  Jolt.destroy(staticLayer);
  Jolt.destroy(movingLayer);

  settings.mObjectLayerPairFilter = objectFilter;
  settings.mBroadPhaseLayerInterface = broadPhase;
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    broadPhase, 2, objectFilter, 2
  );

  joltInterface = new Jolt.JoltInterface(settings);
  Jolt.destroy(settings);
  physicsSystem = joltInterface.GetPhysicsSystem();
  bodyInterface = physicsSystem.GetBodyInterface();
  installContactListener();
}

function createJoltShape(descriptor) {
  if (descriptor.shape.type === 'box') {
    const half = descriptor.shape.halfExtents;
    const halfExtents = makeJoltVec3(half.x, half.y, half.z);
    const shape = new Jolt.BoxShape(halfExtents, 0.02, null);
    Jolt.destroy(halfExtents);
    shapes.push(shape);
    return shape;
  }

  const shape = new Jolt.CapsuleShape(descriptor.shape.halfCylinder, descriptor.shape.radius, null);
  shapes.push(shape);
  return shape;
}

function createVisual(descriptor) {
  let geometry;
  if (descriptor.shape.type === 'box') {
    const h = descriptor.shape.halfExtents;
    geometry = new THREE.BoxGeometry(h.x * 2, h.y * 2, h.z * 2);
  } else {
    geometry = new THREE.CapsuleGeometry(
      descriptor.shape.radius,
      descriptor.shape.halfCylinder * 2,
      8,
      16
    );
  }

  const material = new THREE.MeshStandardMaterial({
    color: descriptor.color,
    roughness: 0.76,
    metalness: 0.025
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.partName = descriptor.name;
  return mesh;
}

function addFloor() {
  const halfExtents = makeJoltVec3(8, 0.25, 8);
  const shape = new Jolt.BoxShape(halfExtents, 0.02, null);
  const position = makeJoltRVec3(0, -0.25, 0);
  const rotation = new Jolt.Quat(0, 0, 0, 1);
  const settings = new Jolt.BodyCreationSettings(
    shape,
    position,
    rotation,
    Jolt.EMotionType_Static,
    LAYER_NON_MOVING
  );
  settings.mFriction = 1.0;
  settings.mRestitution = 0.0;

  const body = bodyInterface.CreateBody(settings);
  floorBodyKey = body.GetID().GetIndexAndSequenceNumber();
  bodyInterface.AddBody(body.GetID(), Jolt.EActivation_DontActivate);

  Jolt.destroy(settings);
  Jolt.destroy(position);
  Jolt.destroy(rotation);
  Jolt.destroy(halfExtents);
  shapes.push(shape);

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(16, 0.5, 16),
    new THREE.MeshStandardMaterial({ color: 0x29343d, roughness: 0.88 })
  );
  mesh.position.set(0, -0.25, 0);
  mesh.receiveShadow = true;
  scene.add(mesh);

  const grid = new THREE.GridHelper(16, 32, 0x40505d, 0x2d3a44);
  grid.position.y = 0.004;
  grid.material.transparent = true;
  grid.material.opacity = 0.42;
  scene.add(grid);
}

const JOINT_CONFIG = {
  hip: {
    kind: 'swing-twist',
    swing: 0.66,
    planeSwing: 0.50,
    twistMin: -0.52,
    twistMax: 0.52,
    kp: 92,
    kd: 15,
    maxTorque: 230,
    twistAxis: [0, 1, 0],
    planeAxis: [1, 0, 0]
  },
  knee: {
    kind: 'hinge',
    swing: 0.035,
    planeSwing: 0.035,
    twistMin: -0.08,
    twistMax: 2.25,
    kp: 95,
    kd: 14,
    maxTorque: 190,
    twistAxis: [1, 0, 0],
    planeAxis: [0, 1, 0]
  },
  ankle: {
    kind: 'swing-twist',
    swing: 0.12,
    planeSwing: 0.10,
    twistMin: -0.42,
    twistMax: 0.30,
    kp: 58,
    kd: 10,
    maxTorque: 105,
    twistAxis: [1, 0, 0],
    planeAxis: [0, 1, 0]
  }
};

function createLowerBody() {
  const built = buildLowerBodyDescriptors();
  const descriptors = built.descriptors;
  const jointDefs = built.joints;
  const descriptorIndex = new Map(descriptors.map(function (item, index) {
    return [item.name, index];
  }));

  const groupFilter = new Jolt.GroupFilterTable(descriptors.length);
  if (DISABLE_SELF_COLLISIONS) {
    for (let a = 0; a < descriptors.length; a += 1) {
      for (let b = a + 1; b < descriptors.length; b += 1) {
        groupFilter.DisableCollision(a, b);
      }
    }
  } else {
    for (const def of jointDefs) {
      const a = descriptorIndex.get(def.a);
      const b = descriptorIndex.get(def.b);
      if (a === undefined || b === undefined) throw new Error('Missing joint body: ' + def.a + ' -> ' + def.b);
      groupFilter.DisableCollision(Math.min(a, b), Math.max(a, b));
    }
  }

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    const shape = createJoltShape(descriptor);
    const position = makeJoltRVec3(descriptor.position.x, descriptor.position.y, descriptor.position.z);
    const rotation = makeJoltQuat(descriptor.rotation);
    const motionType = PIN_FEET && descriptor.group === 'feet'
      ? Jolt.EMotionType_Kinematic
      : Jolt.EMotionType_Dynamic;
    const settings = new Jolt.BodyCreationSettings(
      shape,
      position,
      rotation,
      motionType,
      LAYER_MOVING
    );

    settings.mFriction = descriptor.group === 'feet' ? 1.35 : 0.68;
    settings.mRestitution = 0.0;
    settings.mLinearDamping = 0.025;
    settings.mAngularDamping = 0.075;
    settings.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
    const massProperties = settings.mMassPropertiesOverride;
    massProperties.mMass = descriptor.mass;
    settings.mMassPropertiesOverride = massProperties;
    settings.mCollisionGroup.SetGroupFilter(groupFilter);
    settings.mCollisionGroup.SetGroupID(1);
    settings.mCollisionGroup.SetSubGroupID(index);

    const body = bodyInterface.CreateBody(settings);
    const bodyId = new Jolt.BodyID(body.GetID().GetIndexAndSequenceNumber());
    bodyInterface.AddBody(bodyId, Jolt.EActivation_Activate);

    const mesh = createVisual(descriptor);
    mesh.position.copy(descriptor.position);
    mesh.quaternion.copy(descriptor.rotation);
    scene.add(mesh);

    const part = {
      name: descriptor.name,
      mass: descriptor.mass,
      isDynamic: motionType === Jolt.EMotionType_Dynamic,
      isKinematic: motionType === Jolt.EMotionType_Kinematic,
      descriptor: descriptor,
      body: body,
      bodyId: bodyId,
      mesh: mesh,
      initialPosition: descriptor.position.clone(),
      initialRotation: descriptor.rotation.clone(),
      worldPosition: descriptor.position.clone(),
      worldRotation: descriptor.rotation.clone(),
      worldVelocity: new THREE.Vector3(),
      worldAngularVelocity: new THREE.Vector3(),
      grounded: false
    };
    parts.push(part);
    partByName.set(part.name, part);
    bodyNameById.set(bodyId.GetIndexAndSequenceNumber(), part.name);

    Jolt.destroy(settings);
    Jolt.destroy(position);
    Jolt.destroy(rotation);
  }

  for (const def of jointDefs) {
    const parent = partByName.get(def.a);
    const child = partByName.get(def.b);
    const cfg = JOINT_CONFIG[def.type];
    const anchor = new THREE.Vector3(def.anchor[0], def.anchor[1], def.anchor[2]);

    const parentInv = parent.initialRotation.clone().invert();
    const childInv = child.initialRotation.clone().invert();
    const localAnchor1 = anchor.clone().sub(parent.initialPosition).applyQuaternion(parentInv);
    const localAnchor2 = anchor.clone().sub(child.initialPosition).applyQuaternion(childInv);

    const worldTwist = new THREE.Vector3(cfg.twistAxis[0], cfg.twistAxis[1], cfg.twistAxis[2]);
    const worldPlane = new THREE.Vector3(cfg.planeAxis[0], cfg.planeAxis[1], cfg.planeAxis[2]);
    const localTwist1 = worldTwist.clone().applyQuaternion(parentInv).normalize();
    const localTwist2 = worldTwist.clone().applyQuaternion(childInv).normalize();
    const localPlane1 = worldPlane.clone().applyQuaternion(parentInv).normalize();
    const localPlane2 = worldPlane.clone().applyQuaternion(childInv).normalize();

    let settings;
    let constraint;
    const isHinge = cfg.kind === 'hinge';

    if (isHinge) {
      settings = new Jolt.HingeConstraintSettings();
      settings.mSpace = Jolt.EConstraintSpace_LocalToBodyCOM;
      settings.mNumVelocityStepsOverride = 16;
      settings.mNumPositionStepsOverride = 10;
      settings.mPoint1 = makeJoltRVec3(localAnchor1.x, localAnchor1.y, localAnchor1.z);
      settings.mPoint2 = makeJoltRVec3(localAnchor2.x, localAnchor2.y, localAnchor2.z);
      settings.mHingeAxis1 = makeJoltVec3(localTwist1.x, localTwist1.y, localTwist1.z);
      settings.mHingeAxis2 = makeJoltVec3(localTwist2.x, localTwist2.y, localTwist2.z);
      settings.mNormalAxis1 = makeJoltVec3(localPlane1.x, localPlane1.y, localPlane1.z);
      settings.mNormalAxis2 = makeJoltVec3(localPlane2.x, localPlane2.y, localPlane2.z);
      settings.mLimitsMin = cfg.twistMin;
      settings.mLimitsMax = cfg.twistMax;
      settings.mMaxFrictionTorque = 0.0;
      constraint = Jolt.castObject(settings.Create(parent.body, child.body), Jolt.HingeConstraint);
    } else {
      settings = new Jolt.SwingTwistConstraintSettings();
      settings.mSpace = Jolt.EConstraintSpace_LocalToBodyCOM;
      settings.mNumVelocityStepsOverride = 16;
      settings.mNumPositionStepsOverride = 10;
      settings.mPosition1 = makeJoltRVec3(localAnchor1.x, localAnchor1.y, localAnchor1.z);
      settings.mPosition2 = makeJoltRVec3(localAnchor2.x, localAnchor2.y, localAnchor2.z);
      settings.mTwistAxis1 = makeJoltVec3(localTwist1.x, localTwist1.y, localTwist1.z);
      settings.mTwistAxis2 = makeJoltVec3(localTwist2.x, localTwist2.y, localTwist2.z);
      settings.mPlaneAxis1 = makeJoltVec3(localPlane1.x, localPlane1.y, localPlane1.z);
      settings.mPlaneAxis2 = makeJoltVec3(localPlane2.x, localPlane2.y, localPlane2.z);
      settings.mNormalHalfConeAngle = cfg.swing;
      settings.mPlaneHalfConeAngle = cfg.planeSwing;
      settings.mTwistMinAngle = cfg.twistMin;
      settings.mTwistMaxAngle = cfg.twistMax;
      constraint = Jolt.castObject(settings.Create(parent.body, child.body), Jolt.SwingTwistConstraint);
    }

    physicsSystem.AddConstraint(constraint);
    if (typeof constraint.SetMaxFrictionTorque === 'function') constraint.SetMaxFrictionTorque(0.0);

    const defaultRelative = parent.initialRotation.clone().invert().multiply(child.initialRotation).normalize();
    const joint = {
      key: def.a + '->' + def.b,
      a: def.a,
      b: def.b,
      type: def.type,
      parent: parent,
      child: child,
      constraint: constraint,
      isHinge: isHinge,
      hingeAxisParentLocal: localTwist1.clone(),
      targetRelative: defaultRelative.clone(),
      defaultRelative: defaultRelative.clone(),
      targetHingeAngle: 0,
      min: cfg.twistMin,
      max: cfg.twistMax,
      baseKp: cfg.kp,
      baseKd: cfg.kd,
      baseMaxTorque: cfg.maxTorque,
      appliedTorque: 0,
      requestedTorque: 0,
      orientationError: 0,
      lastServoInput: null,
      extraWorldTorque: new THREE.Vector3()
    };
    joints.push(joint);
    Jolt.destroy(settings);
  }

  validateInitialAnchors(jointDefs);
  return groupFilter;
}

function validateInitialAnchors(jointDefs) {
  const byName = new Map(jointDefs.map(function (def) {
    return [def.a + '->' + def.b, def];
  }));
  let maximum = 0;

  for (const joint of joints) {
    const def = byName.get(joint.key);
    const localA = new THREE.Vector3(def.anchor[0], def.anchor[1], def.anchor[2])
      .sub(joint.parent.initialPosition)
      .applyQuaternion(joint.parent.initialRotation.clone().invert());
    const localB = new THREE.Vector3(def.anchor[0], def.anchor[1], def.anchor[2])
      .sub(joint.child.initialPosition)
      .applyQuaternion(joint.child.initialRotation.clone().invert());
    const pA = joint.parent.initialPosition.clone().add(localA.applyQuaternion(joint.parent.initialRotation));
    const pB = joint.child.initialPosition.clone().add(localB.applyQuaternion(joint.child.initialRotation));
    maximum = Math.max(maximum, pA.distanceTo(pB));
  }
  if (maximum > 0.001) throw new Error('Initial joint anchor mismatch: ' + maximum);
  window.__lowerBodyAnchorError = maximum;
}

function readBodyRotation(bodyId) {
  const q = bodyInterface.GetRotation(bodyId);
  return new THREE.Quaternion(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
}

function readBodyAngularVelocity(bodyId) {
  const w = bodyInterface.GetAngularVelocity(bodyId);
  return new THREE.Vector3(w.GetX(), w.GetY(), w.GetZ());
}

function readBodyPosition(bodyId) {
  const p = bodyInterface.GetPosition(bodyId);
  return new THREE.Vector3(p.GetX(), p.GetY(), p.GetZ());
}

function readBodyLinearVelocity(bodyId) {
  const v = bodyInterface.GetLinearVelocity(bodyId);
  return new THREE.Vector3(v.GetX(), v.GetY(), v.GetZ());
}

function addTorquePair(joint, torque) {
  if (torque.lengthSq() < 1e-10) return;
  const childTorque = makeJoltVec3(torque.x, torque.y, torque.z);
  const parentTorque = makeJoltVec3(-torque.x, -torque.y, -torque.z);
  if (joint.child.isDynamic) bodyInterface.AddTorque(joint.child.bodyId, childTorque, Jolt.EActivation_Activate);
  if (joint.parent.isDynamic) bodyInterface.AddTorque(joint.parent.bodyId, parentTorque, Jolt.EActivation_Activate);
  Jolt.destroy(childTorque);
  Jolt.destroy(parentTorque);
  torqueStats.active += 1;
}

function rebaseJointTargets(type = null) {
  for (const joint of joints) {
    if (type && joint.type !== type) continue;
    // Copy each WASM return immediately. Some Jolt bindings reuse temporary
    // return storage, so keeping two wrappers alive can make both read as the
    // second body's transform.
    const parentQ = readBodyRotation(joint.parent.bodyId);
    const childQ = readBodyRotation(joint.child.bodyId);
    const relative = parentQ.clone().invert().multiply(childQ).normalize();
    joint.defaultRelative.copy(relative);
    joint.targetRelative.copy(relative);
    if (joint.isHinge) joint.targetHingeAngle = joint.constraint.GetCurrentAngle();
  }
}

function updateWorldReferencedTargets() {
  const uprightWorld = new THREE.Quaternion();

  for (const joint of joints) {
    const useWorldReference = (joint.type === 'hip' && worldTargetMode.hip)
      || (joint.type === 'ankle' && worldTargetMode.ankle);
    if (!useWorldReference) continue;

    const parentQ = readBodyRotation(joint.parent.bodyId);
    joint.targetRelative.copy(parentQ.invert().multiply(uprightWorld)).normalize();
  }
}

function updateRootUprightMoment() {
  for (const joint of joints) joint.extraWorldTorque.set(0, 0, 0);
  lastRootUprightTorque.set(0, 0, 0);
  if (!rootUprightEnabled) return;

  const pelvis = partByName.get('pelvis');
  const pelvisQ = readBodyRotation(pelvis.bodyId);
  // Correct only pitch and roll. Heading about world-up is deliberately free.
  const currentUp = WORLD_UP.clone().applyQuaternion(pelvisQ).normalize();
  const correctionQ = new THREE.Quaternion().setFromUnitVectors(currentUp, WORLD_UP);
  if (correctionQ.w < 0) correctionQ.set(-correctionQ.x, -correctionQ.y, -correctionQ.z, -correctionQ.w);

  const angle = 2 * Math.acos(THREE.MathUtils.clamp(correctionQ.w, -1, 1));
  const sinHalf = Math.sqrt(Math.max(0, 1 - correctionQ.w * correctionQ.w));
  const axis = sinHalf < 1e-6
    ? new THREE.Vector3()
    : new THREE.Vector3(correctionQ.x / sinHalf, correctionQ.y / sinHalf, correctionQ.z / sinHalf);
  const omegaJ = bodyInterface.GetAngularVelocity(pelvis.bodyId);
  const omega = new THREE.Vector3(omegaJ.GetX(), omegaJ.GetY(), omegaJ.GetZ());
  const tiltOmega = omega.addScaledVector(WORLD_UP, -omega.dot(WORLD_UP));
  const pelvisTorque = axis.multiplyScalar(rootUprightKp * angle)
    .addScaledVector(tiltOmega, -rootUprightKd)
    .multiplyScalar(rootUprightSign);

  const magnitude = pelvisTorque.length();
  if (magnitude > rootUprightMaxMoment) {
    pelvisTorque.multiplyScalar(rootUprightMaxMoment / Math.max(magnitude, 1e-8));
  }
  lastRootUprightTorque.copy(pelvisTorque);

  // The requested moment acts on the pelvis; equal/opposite moments act on
  // both thighs through the two hip actuators, preserving angular momentum.
  const hips = joints.filter(function (joint) { return joint.type === 'hip'; });
  for (const hip of hips) hip.extraWorldTorque.copy(pelvisTorque).multiplyScalar(-1 / Math.max(1, hips.length));
}

function applyJointMuscleTorques() {
  torqueStats.maxRequested = 0;
  torqueStats.maxApplied = 0;
  torqueStats.saturated = 0;
  torqueStats.active = 0;

  const strength = currentMuscleStrength;
  if (strength <= 1e-6) return;

  const kpScale = controllerStiffness;
  const kdScale = Math.sqrt(controllerStiffness);

  for (const joint of joints) {
    const parentQj = bodyInterface.GetRotation(joint.parent.bodyId);
    const childQj = bodyInterface.GetRotation(joint.child.bodyId);
    const parentQ = new THREE.Quaternion(parentQj.GetX(), parentQj.GetY(), parentQj.GetZ(), parentQj.GetW());
    const childQ = new THREE.Quaternion(childQj.GetX(), childQj.GetY(), childQj.GetZ(), childQj.GetW());

    const parentWorldW = readBodyAngularVelocity(joint.parent.bodyId);
    const childWorldW = readBodyAngularVelocity(joint.child.bodyId);
    const relativeW = childWorldW.clone().sub(parentWorldW);
    const usesWorldTarget = (joint.type === 'hip' && worldTargetMode.hip)
      || (joint.type === 'ankle' && worldTargetMode.ankle);
    // For a world-fixed target, its angular error derivative is the child's
    // absolute world angular velocity, not velocity relative to the parent.
    const dampingW = usesWorldTarget ? childWorldW : relativeW;

    let torque = new THREE.Vector3();
    if (joint.isHinge) {
      const angle = joint.constraint.GetCurrentAngle();
      const axisWorld = joint.hingeAxisParentLocal.clone().applyQuaternion(parentQ).normalize();
      const speed = relativeW.dot(axisWorld);
      const requested = joint.baseKp * kpScale * (joint.targetHingeAngle - angle)
        - joint.baseKd * kdScale * speed;
      const maxTorque = joint.baseMaxTorque * strength * jointTorqueScale[joint.type];
      const applied = Math.max(-maxTorque, Math.min(maxTorque, requested));
      joint.orientationError = Math.abs(joint.targetHingeAngle - angle);
      joint.requestedTorque = Math.abs(requested);
      joint.appliedTorque = Math.abs(applied);
      if (Math.abs(requested) > maxTorque) torqueStats.saturated += 1;
      torque.copy(axisWorld).multiplyScalar(applied);
    } else {
      const desiredChild = parentQ.clone().multiply(joint.targetRelative);
      const errorQ = desiredChild.multiply(childQ.clone().invert()).normalize();
      if (errorQ.w < 0) errorQ.set(-errorQ.x, -errorQ.y, -errorQ.z, -errorQ.w);
      const angle = 2 * Math.acos(THREE.MathUtils.clamp(errorQ.w, -1, 1));
      const sinHalf = Math.sqrt(Math.max(0, 1 - errorQ.w * errorQ.w));
      const axis = sinHalf < 1e-6
        ? new THREE.Vector3()
        : new THREE.Vector3(errorQ.x / sinHalf, errorQ.y / sinHalf, errorQ.z / sinHalf);
      joint.lastServoInput = {
        parentRotation: [parentQ.x, parentQ.y, parentQ.z, parentQ.w],
        childRotation: [childQ.x, childQ.y, childQ.z, childQ.w],
        targetRelative: [joint.targetRelative.x, joint.targetRelative.y, joint.targetRelative.z, joint.targetRelative.w],
        desiredChild: [desiredChild.x, desiredChild.y, desiredChild.z, desiredChild.w],
        errorRotation: [errorQ.x, errorQ.y, errorQ.z, errorQ.w],
        errorAngle: angle,
        dampingVelocity: dampingW.toArray()
      };
      torque.copy(axis).multiplyScalar(angle * joint.baseKp * kpScale).addScaledVector(dampingW, -joint.baseKd * kdScale).add(joint.extraWorldTorque);

      const requested = torque.length();
      const maxTorque = joint.baseMaxTorque * strength * jointTorqueScale[joint.type];
      const applied = Math.min(requested, maxTorque);
      joint.orientationError = angle;
      joint.requestedTorque = requested;
      joint.appliedTorque = applied;
      if (requested > maxTorque) {
        torque.multiplyScalar(maxTorque / Math.max(requested, 1e-8));
        torqueStats.saturated += 1;
      }
    }

    torque.multiplyScalar(jointTorqueSign[joint.type]);
    torqueStats.maxRequested = Math.max(torqueStats.maxRequested, joint.requestedTorque);
    torqueStats.maxApplied = Math.max(torqueStats.maxApplied, joint.appliedTorque);
    addTorquePair(joint, torque);
  }
}

function updateBodyCache() {
  let totalMass = 0;
  let dynamicMass = 0;
  const com = new THREE.Vector3();
  const comVelocity = new THREE.Vector3();
  const rigCom = new THREE.Vector3();
  refreshContactMetadata();

  for (const part of parts) {
    const position = readBodyPosition(part.bodyId);
    const rotation = readBodyRotation(part.bodyId);
    const linearVelocity = readBodyLinearVelocity(part.bodyId);
    const angularVelocity = readBodyAngularVelocity(part.bodyId);

    part.worldPosition.copy(position);
    part.worldRotation.copy(rotation);
    part.worldVelocity.copy(linearVelocity);
    part.worldAngularVelocity.copy(angularVelocity);
    totalMass += part.mass;
    rigCom.addScaledVector(part.worldPosition, part.mass);
    if (part.isDynamic) {
      dynamicMass += part.mass;
      com.addScaledVector(part.worldPosition, part.mass);
      comVelocity.addScaledVector(part.worldVelocity, part.mass);
    }

    const mesh = part.mesh;
    mesh.position.copy(part.worldPosition);
    mesh.quaternion.copy(part.worldRotation);
  }

  // COM and COM velocity describe the simulated dynamic bodies only. Kinematic
  // feet are external anchors, not inertial mass in this diagnostic mode.
  com.multiplyScalar(1 / Math.max(dynamicMass, 1e-6));
  comVelocity.multiplyScalar(1 / Math.max(dynamicMass, 1e-6));
  rigCom.multiplyScalar(1 / Math.max(totalMass, 1e-6));

  const pelvis = partByName.get('pelvis');
  const pelvisUp = WORLD_UP.clone().applyQuaternion(pelvis.worldRotation).dot(WORLD_UP);
  const feet = ['foot_L', 'foot_R'].map(function (name) {
    const part = partByName.get(name);
    const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(part.worldRotation);
    const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(part.worldRotation);
    const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(part.worldRotation);
    const extentY = Math.abs(xAxis.y) * 0.115 + Math.abs(yAxis.y) * 0.065 + Math.abs(zAxis.y) * 0.215;
    const bottomY = part.worldPosition.y - extentY;
    part.grounded = contactTrackingReady ? floorContactFeet.has(name) : bottomY < 0.035;
    return {
      name: name,
      position: part.worldPosition.toArray(),
      grounded: part.grounded
    };
  });

  return {
    step: testStepCount,
    time: testStepCount * FIXED_DT,
    totalMass: totalMass,
    dynamicMass: dynamicMass,
    collisionDiagnostics: {
      selfCollisionsDisabled: DISABLE_SELF_COLLISIONS,
      floorCollisionsDisabled: DISABLE_FLOOR_COLLISIONS,
      footStartGap: FOOT_START_GAP,
      pinnedFeet: PIN_FEET
    },
    pelvisY: pelvis.worldPosition.y,
    pelvisUp: pelvisUp,
    com: com.toArray(),
    rigCom: rigCom.toArray(),
    comVelocity: comVelocity.toArray(),
    rootUpright: {
      enabled: rootUprightEnabled,
      kp: rootUprightKp,
      kd: rootUprightKd,
      sign: rootUprightSign,
      maxMoment: rootUprightMaxMoment,
      appliedMoment: lastRootUprightTorque.length()
    },
    groundedFeet: feet.filter(function (foot) { return foot.grounded; }).map(function (foot) { return foot.name; }),
    feet: feet,
    selfContacts: Array.from(selfContactPairs),
    contactEvents: Object.assign({}, contactEventStats),
    torque: Object.assign({}, torqueStats),
    parts: parts.map(function (part) {
      return {
        name: part.name,
        isDynamic: part.isDynamic,
        isKinematic: part.isKinematic,
        position: part.worldPosition.toArray(),
        velocity: part.worldVelocity.toArray(),
        angularVelocity: part.worldAngularVelocity.toArray(),
        rotation: [part.worldRotation.x, part.worldRotation.y, part.worldRotation.z, part.worldRotation.w],
        grounded: part.grounded
      };
    }),
    joints: joints.map(function (joint) {
      return {
        key: joint.key,
        type: joint.type,
        angle: joint.isHinge ? joint.constraint.GetCurrentAngle() : null,
        min: joint.isHinge ? joint.min : null,
        max: joint.isHinge ? joint.max : null,
        error: joint.orientationError,
        requestedTorque: joint.requestedTorque,
        appliedTorque: joint.appliedTorque,
        measuredError: (() => {
          const desired = joint.parent.worldRotation.clone().multiply(joint.targetRelative);
          const errorQ = desired.multiply(joint.child.worldRotation.clone().invert()).normalize();
          if (errorQ.w < 0) errorQ.set(-errorQ.x, -errorQ.y, -errorQ.z, -errorQ.w);
          return 2 * Math.acos(THREE.MathUtils.clamp(errorQ.w, -1, 1));
        })(),
        lastServoInput: joint.lastServoInput,
        parentRotation: joint.parent.worldRotation.toArray(),
        childRotation: joint.child.worldRotation.toArray(),
        targetRelative: [joint.targetRelative.x, joint.targetRelative.y, joint.targetRelative.z, joint.targetRelative.w],
        currentRelative: joint.parent.worldRotation.clone().invert().multiply(joint.child.worldRotation).toArray()
      };
    })
  };
}

function stepFixedPhysics() {
  updateWorldReferencedTargets();
  updateRootUprightMoment();
  applyJointMuscleTorques();
  joltInterface.Step(FIXED_DT, 1);
  contactTrackingReady = true;
  testStepCount += 1;
}

function resetSimulation() {
  for (const part of parts) {
    const pos = makeJoltRVec3(part.initialPosition.x, part.initialPosition.y, part.initialPosition.z);
    const rot = makeJoltQuat(part.initialRotation);
    const zero = makeJoltVec3(0, 0, 0);
    bodyInterface.SetPositionAndRotation(part.bodyId, pos, rot, Jolt.EActivation_Activate);
    if (part.isDynamic) {
      bodyInterface.SetLinearVelocity(part.bodyId, zero);
      bodyInterface.SetAngularVelocity(part.bodyId, zero);
    }
    Jolt.destroy(pos);
    Jolt.destroy(rot);
    Jolt.destroy(zero);
  }

  liveContactPairs.clear();
  floorContactFeet.clear();
  selfContactPairs.clear();
  contactEventStats.added = 0;
  contactEventStats.persisted = 0;
  contactEventStats.removed = 0;
  contactTrackingReady = false;
  torqueStats.maxRequested = 0;
  torqueStats.maxApplied = 0;
  torqueStats.saturated = 0;
  torqueStats.active = 0;
  for (const joint of joints) {
    joint.orientationError = 0;
    joint.requestedTorque = 0;
    joint.appliedTorque = 0;
    joint.lastServoInput = null;
  }
  testStepCount = 0;
}

function applyImpulse(name, x, y, z) {
  const part = partByName.get(name);
  if (!part) throw new Error('Unknown body: ' + name);
  const p = bodyInterface.GetPosition(part.bodyId);
  const point = makeJoltRVec3(p.GetX(), p.GetY(), p.GetZ());
  const impulse = makeJoltVec3(x, y, z);
  bodyInterface.AddImpulse(part.bodyId, impulse, point);
  bodyInterface.ActivateBody(part.bodyId);
  Jolt.destroy(point);
  Jolt.destroy(impulse);
}

function setMuscleStrength(value) {
  currentMuscleStrength = Math.max(0, Math.min(2.0, Number(value)));
  muscleSlider.value = String(Math.round(currentMuscleStrength * 100));
  muscleValue.textContent = String(Math.round(currentMuscleStrength * 100)) + '%';
}

function setStiffness(value) {
  controllerStiffness = Math.max(0.35, Math.min(2.0, Number(value)));
  stiffnessSlider.value = String(Math.round(controllerStiffness * 100));
  stiffnessValue.textContent = String(Math.round(controllerStiffness * 100)) + '%';
}

function snapshot() {
  return updateBodyCache();
}

function installTestHooks() {
  window.__lowerBodyTest = {
    step: function (count) {
      const steps = Math.max(0, Math.min(100000, Math.floor(count === undefined ? 1 : count)));
      for (let i = 0; i < steps; i += 1) stepFixedPhysics();
      return snapshot();
    },
    snapshot: snapshot,
    reset: resetSimulation,
    setMuscleStrength: setMuscleStrength,
    setStiffness: setStiffness,
    setWorldTargetMode: function (kind, enabled) {
      if (!Object.prototype.hasOwnProperty.call(worldTargetMode, kind)) throw new Error('Unknown world target mode: ' + kind);
      worldTargetMode[kind] = !!enabled;
      for (const joint of joints) joint.targetRelative.copy(joint.defaultRelative);
    },
    setJointTorqueScale: function (type, value) {
      if (!Object.prototype.hasOwnProperty.call(jointTorqueScale, type)) throw new Error('Unknown joint type: ' + type);
      jointTorqueScale[type] = Math.max(0, Math.min(1, Number(value)));
    },
    setJointTorqueSign: function (type, value) {
      if (!Object.prototype.hasOwnProperty.call(jointTorqueSign, type)) throw new Error('Unknown joint type: ' + type);
      jointTorqueSign[type] = Number(value) < 0 ? -1 : 1;
    },
    setRootUprightController: function (enabled, sign, kp, kd, maxMoment) {
      rootUprightEnabled = !!enabled;
      rootUprightSign = Number(sign) < 0 ? -1 : 1;
      if (Number.isFinite(Number(kp))) rootUprightKp = Math.max(0, Math.min(600, Number(kp)));
      if (Number.isFinite(Number(kd))) rootUprightKd = Math.max(0, Math.min(80, Number(kd)));
      if (Number.isFinite(Number(maxMoment))) rootUprightMaxMoment = Math.max(0, Math.min(400, Number(maxMoment)));
    },
    rebaseJointTargets: rebaseJointTargets,
    applyImpulse: applyImpulse,
    anchorError: window.__lowerBodyAnchorError
  };
}

function updateReadout(state) {
  metricPelvis.textContent = state.pelvisY.toFixed(3) + ' m';
  metricUpright.textContent = (state.pelvisUp * 100).toFixed(1) + '%';
  metricGrounded.textContent = state.groundedFeet.length + '/2';
  metricTorque.textContent = state.torque.maxApplied.toFixed(1) + ' Nm';
  const knees = state.joints.filter(function (joint) { return joint.type === 'knee'; });
  diagnostics.textContent =
    'COM: [' + state.com.map(function (n) { return n.toFixed(3); }).join(', ') + '] m\n' +
    'Knee L/R: ' + knees.map(function (joint) { return (joint.angle * 180 / Math.PI).toFixed(1) + '°'; }).join(' / ') + '\n' +
    'Saturation: ' + state.torque.saturated + '/6 · contacts: ' + state.contactEvents.added + ' added / ' + state.contactEvents.persisted + ' persisted';
}

function syncVisuals() {
  const state = snapshot();
  updateReadout(state);
}

function initGraphics() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141d25);
  scene.fog = new THREE.Fog(0x141d25, 8, 22);

  camera = new THREE.PerspectiveCamera(38, viewport.clientWidth / viewport.clientHeight, 0.1, 100);
  camera.position.set(3.1, 2.1, 4.0);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;

  scene.add(new THREE.HemisphereLight(0xc4d8e2, 0x253039, 1.5));

  const key = new THREE.DirectionalLight(0xfff0d9, 2.0);
  key.position.set(3, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x83b8d1, 1.1);
  rim.position.set(-4, 3, -3);
  scene.add(rim);

  window.addEventListener('resize', function () {
    if (!renderer || !camera) return;
    camera.aspect = viewport.clientWidth / viewport.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  });
}

function bindUI() {
  muscleSlider.addEventListener('input', function () {
    setMuscleStrength(Number(muscleSlider.value) / 100);
  });
  stiffnessSlider.addEventListener('input', function () {
    setStiffness(Number(stiffnessSlider.value) / 100);
  });
  resetButton.addEventListener('click', function () {
    if (simulationReady) {
      resetSimulation();
      syncVisuals();
    }
  });
  impulseButton.addEventListener('click', function () {
    if (simulationReady) {
      applyImpulse('pelvis', 0, 0, 0.8);
      setStatus('Импульс приложен к тазу', 'ready');
    }
  });
}

function animate(now) {
  if (!simulationReady || TEST_MODE) return;

  const elapsed = lastFrameTime === 0 ? FIXED_DT : Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  accumulator += elapsed;

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < 4) {
    stepFixedPhysics();
    accumulator -= FIXED_DT;
    steps += 1;
  }
  if (steps === 4) accumulator = Math.min(accumulator, FIXED_DT);

  syncVisuals();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

async function main() {
  try {
    setStatus('Загрузка Jolt WASM…', 'loading');
    bindUI();
    initGraphics();
    Jolt = await initJolt();
    setupJolt();
    addFloor();
    ragdollGroupFilter = createLowerBody();
    simulationReady = true;
    syncVisuals();
    setStatus('Физика готова · 7 тел / 6 суставов', 'ready');
    if (TEST_MODE) installTestHooks();
    else requestAnimationFrame(animate);
  } catch (error) {
    showError(error);
  }
}

main();