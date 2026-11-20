import assert from 'node:assert/strict';
import initJolt from '../jolt-physics.wasm-compat.js';

const DT = 1 / 60;
const STEPS = 600;
const Jolt = await initJolt({
  print: (...args) => console.log('[Jolt]', ...args),
  printErr: (...args) => console.error('[Jolt:error]', ...args),
});

const memoryBefore = Jolt.JoltInterface.prototype.sGetFreeMemory();

let jolt = null;
let floorBody = null;
let sphereBody = null;

try {
  // Two object layers: static and moving. Both layers must collide with each other.
  const settings = new Jolt.JoltSettings();
  settings.mMaxWorkerThreads = 0;

  const objectFilter = new Jolt.ObjectLayerPairFilterTable(2);
  objectFilter.EnableCollision(0, 1);
  objectFilter.EnableCollision(1, 1);

  const bpStatic = new Jolt.BroadPhaseLayer(0);
  const bpMoving = new Jolt.BroadPhaseLayer(1);
  const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
  bpInterface.MapObjectToBroadPhaseLayer(0, bpStatic);
  bpInterface.MapObjectToBroadPhaseLayer(1, bpMoving);
  Jolt.destroy(bpStatic);
  Jolt.destroy(bpMoving);

  const bpFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    bpInterface, 2, objectFilter, 2
  );

  settings.mObjectLayerPairFilter = objectFilter;
  settings.mBroadPhaseLayerInterface = bpInterface;
  settings.mObjectVsBroadPhaseLayerFilter = bpFilter;

  jolt = new Jolt.JoltInterface(settings);
  Jolt.destroy(settings);

  const physicsSystem = jolt.GetPhysicsSystem();
  const bodyInterface = physicsSystem.GetBodyInterface();

  // Static floor with its top surface at y = 0.
  const floorShape = new Jolt.BoxShape(new Jolt.Vec3(10, 0.5, 10), 0.02, null);
  const floorSettings = new Jolt.BodyCreationSettings(
    floorShape,
    new Jolt.RVec3(0, -0.5, 0),
    new Jolt.Quat(0, 0, 0, 1),
    Jolt.EMotionType_Static,
    0
  );
  floorShape.Release(); // BodyCreationSettings owns the remaining shape reference.
  floorBody = bodyInterface.CreateBody(floorSettings);
  Jolt.destroy(floorSettings);
  bodyInterface.AddBody(floorBody.GetID(), Jolt.EActivation_DontActivate);

  // Dynamic sphere dropped onto the floor.
  const sphereShape = new Jolt.SphereShape(0.25, null);
  const sphereSettings = new Jolt.BodyCreationSettings(
    sphereShape,
    new Jolt.RVec3(0, 4, 0),
    new Jolt.Quat(0, 0, 0, 1),
    Jolt.EMotionType_Dynamic,
    1
  );
  sphereShape.Release();
  sphereBody = bodyInterface.CreateBody(sphereSettings);
  Jolt.destroy(sphereSettings);
  bodyInterface.AddBody(sphereBody.GetID(), Jolt.EActivation_Activate);

  for (let i = 0; i < STEPS; i++) {
    jolt.Step(DT, 1);
  }

  const p = sphereBody.GetPosition();
  const v = sphereBody.GetLinearVelocity();
  const result = {
    engine: 'JoltPhysics.js embedded WASM',
    steps: STEPS,
    simulatedSeconds: Number((STEPS * DT).toFixed(3)),
    finalPosition: { x: p.GetX(), y: p.GetY(), z: p.GetZ() },
    finalVelocity: { x: v.GetX(), y: v.GetY(), z: v.GetZ() },
  };
  console.log(JSON.stringify(result, null, 2));

  // Sphere center should settle close to its radius above the floor.
  assert.ok(p.GetY() > 0.20 && p.GetY() < 0.32,
    `sphere did not settle on floor; expected y in (0.20, 0.32), got ${p.GetY()}`);
  assert.ok(Math.abs(p.GetX()) < 0.03 && Math.abs(p.GetZ()) < 0.03,
    'sphere drifted horizontally in the zero-input test');
  assert.ok(Math.abs(v.GetY()) < 0.08,
    `sphere did not settle; vertical speed is ${v.GetY()}`);

  console.log('PASS: Jolt WASM initialized, stepped 10 seconds, and resolved floor contact.');
} finally {
  const bodyInterface = jolt?.GetPhysicsSystem().GetBodyInterface();
  if (bodyInterface && sphereBody) {
    const id = sphereBody.GetID();
    bodyInterface.RemoveBody(id);
    bodyInterface.DestroyBody(id);
    sphereBody = null;
  }
  if (bodyInterface && floorBody) {
    const id = floorBody.GetID();
    bodyInterface.RemoveBody(id);
    bodyInterface.DestroyBody(id);
    floorBody = null;
  }
  if (jolt) {
    Jolt.destroy(jolt);
    jolt = null;
  }
}

const memoryAfter = Jolt.JoltInterface.prototype.sGetFreeMemory();
console.log(JSON.stringify({
  memoryBefore,
  memoryAfter,
  memoryDeltaBytes: memoryBefore - memoryAfter,
}, null, 2));
