import { createEffect, onCleanup, onMount } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function Viewport(props: {
  positions: readonly number[];
  indices: readonly number[];
  failed: boolean;
}) {
  let canvas: HTMLCanvasElement | undefined;
  let apply = (_positions: readonly number[], _indices: readonly number[], _failed: boolean): void => {};

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
    camera.position.set(210, -170, 150);
    camera.lookAt(40, 20, 16);
    const controls = new OrbitControls(camera, element);
    controls.target.set(40, 20, 16);
    controls.enableDamping = true;
    controls.update();

    const bedGeometry = new THREE.BoxGeometry(250, 210, 220);
    bedGeometry.translate(125, 105, 110);
    const bedEdges = new THREE.EdgesGeometry(bedGeometry);
    const bed = new THREE.LineSegments(
      bedEdges,
      new THREE.LineBasicMaterial({ color: 0x364052 }),
    );
    scene.add(bed);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(60, -140, 200);
    scene.add(key);

    let part: THREE.Mesh | undefined;
    apply = (positions, indices, failed) => {
      if (part) {
        scene.remove(part);
        part.geometry.dispose();
        const material = part.material;
        if (!Array.isArray(material)) {
          material.dispose();
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(Float32Array.from(positions), 3),
      );
      geometry.setIndex(Array.from(indices));
      geometry.computeVertexNormals();
      part = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: failed ? 0xff657a : 0x73e6c2,
          roughness: 0.42,
          metalness: 0.08,
          // The shell mesh includes the inner void, so both sides have to draw.
          side: THREE.DoubleSide,
        }),
      );
      scene.add(part);
    };
    apply(props.positions, props.indices, props.failed);

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
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      apply = () => undefined;
      if (part) {
        part.geometry.dispose();
        const material = part.material;
        if (!Array.isArray(material)) {
          material.dispose();
        }
      }
      bedGeometry.dispose();
      bedEdges.dispose();
      (bed.material as THREE.Material).dispose();
      renderer.dispose();
    });
  });

  createEffect(() => {
    apply(props.positions, props.indices, props.failed);
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
