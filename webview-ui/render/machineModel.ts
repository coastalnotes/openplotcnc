import * as THREE from 'three';
import type { MachineGeometry, SetupConfig } from '../../src/types';

/**
 * Parametric 3D model of a sliding-headstock Swiss lathe, dimensioned from
 * {@link MachineGeometry}. Three.js frame: +X = spindle axis (toward the
 * sub-spindle), +Y = radial up, +Z = lateral.
 */
export interface MachineModel {
  root: THREE.Group;
  /** Sliding headstock — translate on +X by −Z1. Holds the bar stock. */
  headstock: THREE.Group;
  /** Sub-spindle + back tool-post carriage — translate on +X by Z2. */
  subCarriage: THREE.Group;
  /** Gang tool post — translate −Y to cut (X1), ±Z for Y1. */
  gangSlide: THREE.Group;
  stock: THREE.Mesh;
  /** Radial park height of the gang tool tips above the centreline. */
  gangParkY: number;
  dispose(): void;
}

const CAST = () => new THREE.MeshStandardMaterial({ color: 0x3c4657, metalness: 0.35, roughness: 0.65 });
const STEEL = () => new THREE.MeshStandardMaterial({ color: 0x8a94a6, metalness: 0.7, roughness: 0.35 });
const DARK = () => new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.3, roughness: 0.8 });
const HOLDER = () => new THREE.MeshStandardMaterial({ color: 0x566072, metalness: 0.5, roughness: 0.5 });

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}
/** Cylinder with its axis along +X. */
function tube(rTop: number, rBot: number, len: number, mat: THREE.Material, seg = 24): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, seg), mat);
  m.rotation.z = Math.PI / 2;
  return m;
}

export function buildMachineModel(setup: SetupConfig, geo: MachineGeometry): MachineModel {
  const root = new THREE.Group();
  root.name = 'machine';
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const track = <T extends THREE.Object3D>(o: T): T => {
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (mesh.geometry) disposables.push(mesh.geometry);
      if (mesh.material) disposables.push(mesh.material as THREE.Material);
    });
    return o;
  };

  const m = setup.machine;
  const s = setup.stock;
  const swiss = m.kinematicsMode === 'swiss-type';
  const od = s.outerDiameter;
  const bushX = m.guideBushingZ;
  const faceX = m.mainSpindleFaceZ;
  const baseTop = -Math.max(od, geo.mainSpindle.bodyDiameter * 0.5) - 14;

  /* ---------- bed / base ---------- */
  const left = faceX - geo.mainSpindle.bodyLength - 120;
  const right = m.subSpindle.homeZ + geo.subSpindle.bodyLength + 40;
  const bed = track(box(right - left, geo.base.height, geo.base.depth, DARK()));
  bed.position.set((left + right) / 2, baseTop - geo.base.height / 2, 0);
  root.add(bed);
  const wayTop = track(box(right - left, 10, geo.base.depth * 0.62, CAST()));
  wayTop.position.set((left + right) / 2, baseTop - 5, 0);
  root.add(wayTop);

  /* ---------- sliding headstock ---------- */
  const headstock = new THREE.Group();
  headstock.name = 'headstock';
  const hs = geo.mainSpindle;
  const spindleBody = track(tube(hs.bodyDiameter / 2, hs.bodyDiameter / 2, hs.bodyLength, STEEL()));
  spindleBody.position.x = -hs.bodyLength / 2;
  headstock.add(spindleBody);
  const collet = track(tube(od * 0.7, hs.bodyDiameter / 2, hs.noseLength, STEEL(), 20));
  collet.position.x = hs.noseLength / 2;
  headstock.add(collet);
  const hsCast = track(box(150, hs.bodyDiameter * 1.9, hs.bodyDiameter * 1.7, CAST()));
  hsCast.position.set(-hs.bodyLength - 60, baseTop + (hs.bodyDiameter * 1.9) / 2, 0);
  headstock.add(hsCast);
  headstock.position.set(faceX, 0, 0);
  root.add(headstock);

  /* ---------- bar stock (rides with the headstock) ---------- */
  const stockLen = Math.max(s.length, bushX - faceX + s.protrusion + hs.bodyLength);
  const stockGeom =
    s.innerDiameter > 0
      ? new THREE.CylinderGeometry(od / 2, od / 2, stockLen, 32, 1, true)
      : new THREE.CylinderGeometry(od / 2, od / 2, stockLen, 32);
  const stock = new THREE.Mesh(
    stockGeom,
    new THREE.MeshStandardMaterial({ color: 0xc2c2c4, metalness: 0.8, roughness: 0.3 })
  );
  disposables.push(stockGeom, stock.material as THREE.Material);
  stock.rotation.z = Math.PI / 2;
  // Front of the bar sits just past the local origin (the collet face).
  stock.position.x = stockLen / 2 - hs.bodyLength * 0.15;
  headstock.add(stock);

  /* ---------- guide bushing (fixed) ---------- */
  if (swiss && geo.guideBushing.present) {
    const gb = geo.guideBushing;
    const bracket = track(box(22, gb.holderHeight, gb.holderWidth, CAST()));
    bracket.position.set(bushX, baseTop + gb.holderHeight / 2, 0);
    root.add(bracket);
    const ringGeom = new THREE.TorusGeometry(gb.outerDiameter / 2, Math.max(2, od * 0.12), 14, 36);
    const ring = new THREE.Mesh(ringGeom, STEEL());
    disposables.push(ringGeom, ring.material as THREE.Material);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(bushX, 0, 0);
    root.add(ring);
  }

  /* ---------- gang tool post ---------- */
  const gp = geo.gangPost;
  const gangParkY = od + gp.parkClearance + gp.plateHeight / 2;
  const gangSlide = new THREE.Group();
  gangSlide.name = 'gang';
  const plate = track(box(gp.plateThickness, gp.plateHeight, gp.plateWidth, CAST()));
  gangSlide.add(plate);
  // column of holders hanging toward the work
  const turn = Math.max(1, Math.round(gp.turningStations));
  for (let i = 0; i < turn; i++) {
    const z = (i - (turn - 1) / 2) * (gp.plateWidth / (turn + 1));
    const holder = track(box(gp.plateThickness * 0.8, gp.plateHeight * 0.5, gp.plateWidth / (turn + 2), HOLDER()));
    holder.position.set(0, -gp.plateHeight / 2 - gp.plateHeight * 0.2, z);
    gangSlide.add(holder);
    const tip = track(box(6, 5, 4, STEEL()));
    tip.position.set(0, -gp.plateHeight * 0.95, z);
    gangSlide.add(tip);
  }
  // live-tool spindle housings — axis vertical (radial), pointing at the work
  const live = Math.max(0, Math.round(gp.liveStations));
  for (let i = 0; i < live; i++) {
    const z = (i - (live - 1) / 2) * (gp.plateWidth / (live + 1));
    const g = new THREE.CylinderGeometry(9, 9, gp.plateHeight * 0.7, 16);
    const spin = new THREE.Mesh(g, HOLDER());
    disposables.push(g, spin.material as THREE.Material);
    spin.position.set(gp.plateThickness * 0.3, -gp.plateHeight * 0.55, z);
    gangSlide.add(spin);
  }
  gangSlide.position.set(gp.faceZ, gangParkY, 0);
  root.add(gangSlide);

  /* ---------- sub-spindle + back tool-post carriage ---------- */
  const subCarriage = new THREE.Group();
  subCarriage.name = 'sub';
  const ss = geo.subSpindle;
  const subBody = track(tube(ss.bodyDiameter / 2, ss.bodyDiameter / 2, ss.bodyLength, STEEL()));
  subBody.position.x = ss.bodyLength / 2; // body extends +X, nose faces −X at local 0
  subCarriage.add(subBody);
  const subNose = track(tube(ss.bodyDiameter / 2, od * 0.7, ss.noseLength, STEEL(), 20));
  subNose.position.x = -ss.noseLength / 2;
  subCarriage.add(subNose);
  const subCast = track(box(140, ss.bodyDiameter * 1.9, ss.bodyDiameter * 1.7, CAST()));
  subCast.position.set(ss.bodyLength + 55, baseTop + (ss.bodyDiameter * 1.9) / 2, 0);
  subCarriage.add(subCast);

  if (geo.backPost.present) {
    const bp = geo.backPost;
    const bpPlate = track(box(bp.plateWidth * 0.16, bp.plateHeight, bp.plateWidth, CAST()));
    bpPlate.position.set(-14, -ss.bodyDiameter / 2 - bp.plateHeight / 2 - 6, 0);
    subCarriage.add(bpPlate);
    const rows = Math.max(1, Math.round(bp.fixedStations + bp.rotaryStations));
    for (let i = 0; i < rows; i++) {
      const z = (i - (rows - 1) / 2) * (bp.plateWidth / (rows + 1));
      const isRotary = i >= bp.fixedStations;
      const hh = isRotary
        ? track(tube(7, 7, 34, HOLDER(), 14))
        : track(box(30, 12, bp.plateWidth / (rows + 2), HOLDER()));
      hh.position.set(-34, -ss.bodyDiameter / 2 - bp.plateHeight / 2 - 6, z);
      subCarriage.add(hh);
    }
  }
  subCarriage.position.set(m.subSpindle.homeZ, 0, 0);
  root.add(subCarriage);

  return {
    root,
    headstock,
    subCarriage,
    gangSlide,
    stock,
    gangParkY,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
