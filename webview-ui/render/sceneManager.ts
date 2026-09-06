import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SetupConfig, Vec3 } from '../../src/types';
import { buildChannelPath, progressCount, toThree, type ChannelPath } from './toolpathBuilder';
import { buildMachineModel, type MachineModel } from './machineModel';
import { DEFAULT_GEOMETRY } from '../../src/config/geometry';
import type { ScheduledChannel } from '../../src/simulation/timeline';

const CHANNEL_COLORS = [0x22d3ee, 0xf59e0b, 0xe879f9, 0x4ade80];

export class SceneManager {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly world = new THREE.Group();
  private readonly machine = new THREE.Group();
  private readonly paths = new THREE.Group();
  private readonly tools = new THREE.Group();
  private grid!: THREE.GridHelper;
  private model: MachineModel | undefined;
  private channelPaths: ChannelPath[] = [];
  private toolMarkers = new Map<number, THREE.Mesh>();
  private setup: SetupConfig | undefined;
  private raf = 0;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(120, 90, 140);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(80, 140, 100);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-100, 40, -60);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(400, 40, 0x555555, 0x333333);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(this.grid);

    const axes = new THREE.AxesHelper(30);
    this.scene.add(axes);

    this.world.add(this.machine, this.paths, this.tools);
    this.scene.add(this.world);

    this.loop();
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.scene.background = null;
    const gc = theme === 'light' ? [0x999999, 0xcccccc] : [0x555555, 0x333333];
    this.scene.remove(this.grid);
    this.grid = new THREE.GridHelper(400, 40, gc[0], gc[1]);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = theme === 'light' ? 0.5 : 0.35;
    this.scene.add(this.grid);
  }

  setSetup(setup: SetupConfig): void {
    this.setup = setup;
    this.buildMachine();
  }

  private buildMachine(): void {
    if (!this.setup) return;
    this.model?.dispose();
    this.machine.clear();
    const geo = this.setup.machine.geometry ?? DEFAULT_GEOMETRY;
    this.model = buildMachineModel(this.setup, geo);
    this.machine.add(this.model.root);
  }

  setToolpaths(channels: ScheduledChannel[]): void {
    this.paths.clear();
    this.tools.clear();
    this.toolMarkers.clear();
    this.channelPaths = [];

    const union = new THREE.Box3();
    for (const sc of channels) {
      const cp = buildChannelPath(sc);
      this.channelPaths.push(cp);
      this.paths.add(cp.group);
      if (!cp.bounds.isEmpty()) union.union(cp.bounds);

      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.8, (this.setup?.stock.outerDiameter ?? 20) * 0.06), 16, 12),
        new THREE.MeshStandardMaterial({
          color: CHANNEL_COLORS[(sc.channel - 1) % 4],
          emissive: CHANNEL_COLORS[(sc.channel - 1) % 4],
          emissiveIntensity: 0.5,
        })
      );
      marker.visible = false;
      this.tools.add(marker);
      this.toolMarkers.set(sc.channel, marker);
    }

    if (!union.isEmpty()) this.frameBox(union);
  }

  clearToolpaths(): void {
    this.paths.clear();
    this.tools.clear();
    this.toolMarkers.clear();
    this.channelPaths = [];
  }

  get hasToolpaths(): boolean {
    return this.channelPaths.length > 0;
  }

  setRapidsVisible(visible: boolean): void {
    for (const cp of this.channelPaths) {
      cp.group.traverse((o) => {
        const mat = (o as THREE.Line).material as THREE.Material | undefined;
        if (mat && mat.type === 'LineDashedMaterial') o.visible = visible;
      });
    }
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  setMachineVisible(visible: boolean): void {
    this.machine.visible = visible;
  }

  /** Camera presets relative to the current toolpath bounds. */
  setView(preset: 'iso' | 'top' | 'front' | 'right'): void {
    const box = new THREE.Box3().setFromObject(this.paths);
    const target = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const r = box.isEmpty() ? 160 : Math.max(box.getSize(new THREE.Vector3()).length() * 0.7, 40);
    this.controls.target.copy(target);
    const dir =
      preset === 'top'
        ? new THREE.Vector3(0.001, 1, 0.001)
        : preset === 'front'
          ? new THREE.Vector3(0, 0, 1)
          : preset === 'right'
            ? new THREE.Vector3(1, 0, 0.001)
            : new THREE.Vector3(0.9, 0.7, 1.1);
    this.camera.position.copy(target).add(dir.normalize().multiplyScalar(r));
    this.camera.near = r / 100;
    this.camera.far = r * 100;
    this.camera.updateProjectionMatrix();
  }

  /** Update per-channel progress lines + tool markers for a wall-clock time. */
  updatePlayback(
    time: number,
    positions: Map<number, { pos: Vec3; waiting: boolean }>
  ): void {
    for (const cp of this.channelPaths) {
      cp.progressLine.geometry.setDrawRange(0, progressCount(cp, time));
    }
    for (const [ch, marker] of this.toolMarkers) {
      const p = positions.get(ch);
      if (!p) {
        marker.visible = false;
        continue;
      }
      marker.visible = true;
      marker.position.copy(toThree(p.pos));
      (marker.material as THREE.MeshStandardMaterial).emissiveIntensity = p.waiting ? 0.1 : 0.6;
    }
  }

  setHeadstock(z: number, subZ?: number): void {
    if (!this.model) return;
    this.model.headstock.position.x = z;
    if (subZ !== undefined) this.model.subCarriage.position.x = subZ;
  }

  /** Drop the gang tool post to the current cutting radius (three.js Y). */
  setGangRadius(radius: number | undefined): void {
    if (!this.model) return;
    const park = this.model.gangParkY;
    this.model.gangSlide.position.y =
      radius === undefined ? park : Math.max(radius + 6, Math.min(park, radius + 6));
  }

  frameAll(): void {
    const box = new THREE.Box3().setFromObject(this.paths);
    if (!box.isEmpty()) this.frameBox(box);
  }

  private frameBox(box: THREE.Box3): void {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.6, 20);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(radius * 0.9, radius * 0.7, radius * 1.1));
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
