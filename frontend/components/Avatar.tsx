"use client";
import { useFrame } from "@react-three/fiber";
import { MutableRefObject, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Status } from "@/lib/api";

const STATUS_COLOR: Record<Status, string> = {
  idle: "#6b7cff",
  listening: "#3ddc97",
  thinking: "#ffb347",
  speaking: "#ff6b9d",
};

type Props = {
  analyser: MutableRefObject<AnalyserNode | null>;
  status: Status;
};

/**
 * Stylized procedural head. Mouth opening is driven by the RMS level of the
 * TTS audio, so it lip-syncs to whatever Sensei says. Swap for a Ready Player
 * Me GLB later (see README) and drive its `jawOpen` morph target the same way.
 */
export default function Avatar({ analyser, status }: Props) {
  const head = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const eyes = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);
  const haloMat = useRef<THREE.MeshBasicMaterial>(null);
  const buf = useMemo(() => new Uint8Array(2048), []);
  const level = useRef(0);
  const blink = useRef({ next: 2.5, until: 0 });
  const target = useMemo(() => new THREE.Color(), []);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;

    // --- lip-sync from audio amplitude ---
    let raw = 0;
    const a = analyser.current;
    if (a && status === "speaking") {
      const n = Math.min(a.fftSize, buf.length);
      a.getByteTimeDomainData(buf.subarray(0, n));
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      raw = Math.min(1, Math.sqrt(sum / n) * 5);
    }
    level.current += (raw - level.current) * Math.min(1, dt * 18);
    if (mouth.current) {
      mouth.current.scale.y = 0.12 + level.current * 1.1;
      mouth.current.scale.x = 1 - level.current * 0.25;
    }

    // --- idle motion ---
    if (head.current) {
      const listening = status === "listening";
      head.current.rotation.y = Math.sin(t * 0.5) * 0.15;
      head.current.rotation.x = listening ? -0.08 : Math.sin(t * 0.7) * 0.04;
      head.current.rotation.z = listening ? 0.1 : 0;
      head.current.position.y = Math.sin(t * 1.2) * 0.03 + level.current * 0.03;
    }

    // --- blinking ---
    if (eyes.current) {
      const b = blink.current;
      if (t > b.next) {
        b.until = t + 0.12;
        b.next = t + 2 + Math.random() * 3;
      }
      eyes.current.scale.y = t < b.until ? 0.1 : 1;
    }

    // --- status halo ---
    if (halo.current && haloMat.current) {
      halo.current.rotation.z += dt * (status === "thinking" ? 3 : 0.3);
      const pulse = status === "listening" ? 1 + Math.sin(t * 6) * 0.04 : 1 + level.current * 0.08;
      halo.current.scale.setScalar(pulse);
      target.set(STATUS_COLOR[status]);
      haloMat.current.color.lerp(target, Math.min(1, dt * 5));
    }
  });

  return (
    <group>
      <mesh ref={halo} position={[0, 0.1, -0.6]}>
        <torusGeometry args={[1.45, 0.025, 16, 128, Math.PI * 1.7]} />
        <meshBasicMaterial ref={haloMat} color={STATUS_COLOR.idle} toneMapped={false} />
      </mesh>

      <group ref={head}>
        {/* head */}
        <mesh castShadow>
          <sphereGeometry args={[1, 64, 64]} />
          <meshStandardMaterial color="#f1d3b8" roughness={0.6} />
        </mesh>
        {/* hair cap */}
        <mesh position={[0, 0.18, -0.05]} rotation={[-0.25, 0, 0]}>
          <sphereGeometry args={[1.04, 64, 64, 0, Math.PI * 2, 0, Math.PI / 2.1]} />
          <meshStandardMaterial color="#1c1a24" roughness={0.9} />
        </mesh>
        {/* ears */}
        {[-1, 1].map((s) => (
          <mesh key={s} position={[s * 0.98, 0, 0]} scale={[0.4, 1, 0.6]}>
            <sphereGeometry args={[0.22, 24, 24]} />
            <meshStandardMaterial color="#e8c3a4" />
          </mesh>
        ))}
        {/* eyes */}
        <group ref={eyes} position={[0, 0.12, 0.86]}>
          {[-0.32, 0.32].map((x) => (
            <group key={x} position={[x, 0, 0]}>
              <mesh>
                <sphereGeometry args={[0.15, 32, 32]} />
                <meshStandardMaterial color="#ffffff" />
              </mesh>
              <mesh position={[0, 0, 0.1]}>
                <sphereGeometry args={[0.075, 24, 24]} />
                <meshStandardMaterial color="#231f2e" />
              </mesh>
            </group>
          ))}
        </group>
        {/* brows */}
        {[-0.32, 0.32].map((x) => (
          <mesh key={x} position={[x, 0.36, 0.9]} rotation={[0, 0, x > 0 ? -0.1 : 0.1]}>
            <boxGeometry args={[0.28, 0.045, 0.05]} />
            <meshStandardMaterial color="#1c1a24" />
          </mesh>
        ))}
        {/* mouth */}
        <mesh ref={mouth} position={[0, -0.38, 0.9]} scale={[1, 0.12, 1]}>
          <sphereGeometry args={[0.22, 32, 16]} />
          <meshStandardMaterial color="#5a1f2b" roughness={0.4} />
        </mesh>
      </group>
    </group>
  );
}
