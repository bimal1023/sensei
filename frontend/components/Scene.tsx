"use client";
import { Canvas } from "@react-three/fiber";
import type { MutableRefObject } from "react";
import type { Status } from "@/lib/api";
import Avatar from "./Avatar";

export default function Scene({
  analyser,
  status,
}: {
  analyser: MutableRefObject<AnalyserNode | null>;
  status: Status;
}) {
  return (
    <Canvas camera={{ position: [0, -0.15, 5.4], fov: 40 }} dpr={[1, 2]}>
      <ambientLight intensity={0.55} />
      <directionalLight position={[2, 3, 4]} intensity={1.4} />
      <pointLight position={[-3, -1, 2]} intensity={12} color="#8a7dff" />
      <Avatar analyser={analyser} status={status} />
    </Canvas>
  );
}
