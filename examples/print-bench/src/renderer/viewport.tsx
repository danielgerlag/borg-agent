import { createEffect, onCleanup, onMount } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { Body } from "../domain.js";
import { localMesh } from "../domain.js";

export function Viewport(props: {
  bodies: readonly Body[];
  selectedId: string | null;
  failed: boolean;
  mode: "translate" | "rotate" | "scale";
  onSelect: (id: string) => void;
  onTransform: (body: Body) => void;
}) {
  let canvas: HTMLCanvasElement | undefined;
  let renderBodies = (
    _bodies: readonly Body[],
    _selectedId: string | null,
    _mode: "translate" | "rotate" | "scale",
    _failed: boolean,
  ): void => {};
  let choose = (_id: string): void => {};
  let commit = (_body: Body): void => {};

  onMount(() => {
    const element = canvas;
    if (!element) {
      return;
    }
    const renderer = new THREE.WebGLRenderer({ canvas: element, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x090b10);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 4000);
    // The mesh is the printer frame: x across the bed, y toward the back, z up.
    camera.up.set(0, 0, 1);
    camera.position.set(280, -40, 220);
    camera.lookAt(125, 105, 20);
    const orbit = new OrbitControls(camera, element);
    orbit.target.set(125, 105, 20);
    orbit.enableDamping = true;
    orbit.update();

    const bedGeometry = new THREE.BoxGeometry(250, 210, 220);
    bedGeometry.translate(125, 105, 110);
    const bedEdges = new THREE.EdgesGeometry(bedGeometry);
    const bed = new THREE.LineSegments(bedEdges, new THREE.LineBasicMaterial({ color: 0x364052 }));
    scene.add(bed);
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(40, -80, 260);
    scene.add(key);

    const solids = new THREE.Group();
    scene.add(solids);
    const gizmo = new TransformControls(camera, element);
    scene.add(gizmo.getHelper());
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let attached: THREE.Mesh | undefined;
    let dragging = false;
    let moved = false;

    gizmo.addEventListener("dragging-changed", (event) => {
      dragging = Boolean(event.value);
      orbit.enabled = !dragging;
    });
    gizmo.addEventListener("objectChange", () => {
      moved = true;
    });
    gizmo.addEventListener("mouseUp", () => {
      orbit.enabled = true;
      const mesh = attached;
      if (!moved || !mesh) {
        moved = false;
        dragging = false;
        return;
      }
      moved = false;
      dragging = false;
      const body = mesh.userData.body as Body;
      commit(bake(body, mesh));
    });

    const onPointerDown = (event: PointerEvent): void => {
      if (dragging || gizmo.axis !== null) {
        return;
      }
      const rect = element.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(solids.children, false)[0];
      const id = hit?.object.userData.id;
      if (typeof id === "string") {
        choose(id);
      }
    };
    element.addEventListener("pointerdown", onPointerDown);

    renderBodies = (bodies, selectedId, mode, failed) => {
      if (dragging) {
        return;
      }
      gizmo.detach();
      attached = undefined;
      for (const child of [...solids.children]) {
        solids.remove(child);
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        const material = mesh.material;
        if (!Array.isArray(material)) {
          material.dispose();
        }
      }
      gizmo.setMode(mode);
      for (const body of bodies) {
        const data = localMesh(body);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(data.positions), 3));
        geometry.setIndex(Array.from(data.indices));
        geometry.computeVertexNormals();
        const selected = body.id === selectedId;
        const mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: failed ? 0xff657a : selected ? 0x73e6c2 : 0x8b95a8,
            roughness: 0.45,
            metalness: 0.05,
          }),
        );
        mesh.position.set(body.position.x, body.position.y, body.position.z);
        mesh.rotation.order = "XYZ";
        mesh.rotation.set(
          THREE.MathUtils.degToRad(body.rotationDeg.x),
          THREE.MathUtils.degToRad(body.rotationDeg.y),
          THREE.MathUtils.degToRad(body.rotationDeg.z),
        );
        mesh.userData = { id: body.id, body };
        solids.add(mesh);
        if (selected) {
          attached = mesh;
          gizmo.attach(mesh);
        }
      }
    };

    const resize = (): void => {
      const width = element.clientWidth || 1;
      const height = element.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    let frame = 0;
    const loop = (): void => {
      frame = requestAnimationFrame(loop);
      orbit.update();
      renderer.render(scene, camera);
    };
    loop();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointerdown", onPointerDown);
      observer.disconnect();
      orbit.dispose();
      gizmo.dispose();
      renderBodies = () => undefined;
      bedGeometry.dispose();
      bedEdges.dispose();
      (bed.material as THREE.Material).dispose();
      renderer.dispose();
    });
  });

  createEffect(() => {
    choose = props.onSelect;
    commit = props.onTransform;
    renderBodies(props.bodies, props.selectedId, props.mode, props.failed);
  });

  return (
    <canvas
      ref={(element) => {
        canvas = element;
      }}
      data-testid="print-bench-viewport"
      class="block h-full w-full"
    />
  );
}

function bake(body: Body, mesh: THREE.Mesh): Body {
  const position = {
    x: round(mesh.position.x),
    y: round(mesh.position.y),
    z: round(mesh.position.z),
  };
  const rotationDeg = {
    x: round(THREE.MathUtils.radToDeg(mesh.rotation.x)),
    y: round(THREE.MathUtils.radToDeg(mesh.rotation.y)),
    z: round(THREE.MathUtils.radToDeg(mesh.rotation.z)),
  };
  const sx = Math.abs(mesh.scale.x);
  const sy = Math.abs(mesh.scale.y);
  const sz = Math.abs(mesh.scale.z);
  if (body.kind === "box") {
    return {
      ...body,
      position,
      rotationDeg,
      widthMm: Math.max(0.4, round(body.widthMm * sx)),
      depthMm: Math.max(0.4, round(body.depthMm * sy)),
      heightMm: Math.max(0.4, round(body.heightMm * sz)),
    };
  }
  if (body.kind === "sphere") {
    return {
      ...body,
      position,
      rotationDeg,
      radiusMm: Math.max(0.4, round(body.radiusMm * ((sx + sy + sz) / 3))),
    };
  }
  return {
    ...body,
    position,
    rotationDeg,
    radiusMm: Math.max(0.4, round(body.radiusMm * ((sx + sy) / 2))),
    heightMm: Math.max(0.4, round(body.heightMm * sz)),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
