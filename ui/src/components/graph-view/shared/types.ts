export interface NodeData {
  label: string;
  x: number;
  y: number;
  size: number;
  color: string;
  community: number;
  type: string;
  activationLevel: number;
  firingRate: number;
}

export interface EdgeData {
  weight: number;
  color: string;
  size: number;
  type: string;
}

export interface Particle {
  edgeKey: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  t: number;
  speed: number;
  ttl: number;
  size: number;
  alpha: number;
  color: string;
  jitter: number;
  curvature: number;
}

export interface FiringEvent {
  source: string;
  target: string;
  strength: number;
  count: number;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  activeParticles: number;
  fps: number;
  communities: number;
}
