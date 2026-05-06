import { useEffect, useMemo, useRef, useState } from 'react';

import { activityAnimationMode } from '../localPipelineActivity.js';

export type ModelAgentRole = 'query' | 'ranking' | 'visual' | 'metadata';

export interface LocalAgentStatus {
  id: string;
  label: string;
  role: ModelAgentRole;
  model: string;
  apiKeyId: string;
  apiKeyLabel: string;
  groupId: string;
  state: 'idle' | 'active' | 'blocked' | 'error';
  activeProduct: string | null;
  manualAction: {
    type: 'google-captcha';
    message: string;
    url: string;
  } | null;
  counts: {
    completed: number;
    failed: number;
  };
  lastError: string | null;
}

export type JobActivityPhase =
  | 'product:start'
  | 'query:build'
  | 'ranking:search'
  | 'ranking:candidates'
  | 'visual:extract'
  | 'visual:evidence'
  | 'visual:validate'
  | 'metadata:generate'
  | 'captcha'
  | 'product:complete'
  | 'product:failed';

export interface LocalJobActivityEvent {
  id: string;
  jobId: string;
  timestamp: string;
  apiKeyId: string;
  agentId: string;
  role: ModelAgentRole;
  product?: {
    sku: string;
    title: string;
  };
  phase: JobActivityPhase;
  state: 'start' | 'progress' | 'success' | 'rejected' | 'blocked' | 'unblocked' | 'error';
  query?: string;
  candidate?: {
    url: string;
    title: string;
    snippet: string;
    reason?: string;
  };
  imageCount?: number;
  evidenceScore?: number;
  reason?: string;
  message?: string;
}

interface ProductResult {
  sku: string;
  status: 'completed' | 'failed' | 'skipped';
  validationReason: string;
  sourceUrl?: string;
}

interface LocalPipelineOfficeProps {
  agents: LocalAgentStatus[];
  activities: LocalJobActivityEvent[];
  products: ProductResult[];
}

interface SceneHit {
  type: 'agent' | 'product';
  id: string;
}

interface RoleStation {
  role: ModelAgentRole;
  label: string;
  x: number;
}

const roleStations: RoleStation[] = [
  { role: 'query', label: 'Query', x: 120 },
  { role: 'ranking', label: 'Google', x: 370 },
  { role: 'visual', label: 'Visual', x: 620 },
  { role: 'metadata', label: 'Metadata', x: 870 },
];

const phaseProgress: Record<JobActivityPhase, number> = {
  'product:start': 0.03,
  'query:build': 0.16,
  'ranking:search': 0.38,
  'ranking:candidates': 0.46,
  'visual:extract': 0.62,
  'visual:evidence': 0.68,
  'visual:validate': 0.76,
  'metadata:generate': 0.9,
  captcha: 0.45,
  'product:complete': 1,
  'product:failed': 0.98,
};

const spriteFrame = {
  idle: 1,
  walk: 0,
  typeA: 3,
  typeB: 4,
  readA: 5,
  readB: 6,
};

const sprite = {
  width: 16,
  height: 32,
  scale: 3,
};

export function LocalPipelineOffice({ agents, activities, products }: LocalPipelineOfficeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hitsRef = useRef<Array<{ hit: SceneHit; x: number; y: number; w: number; h: number }>>([]);
  const [selected, setSelected] = useState<SceneHit | null>(null);

  const groups = useMemo(() => groupAgentsByApiKey(agents), [agents]);
  const latestByAgent = useMemo(() => latestActivityByAgent(activities), [activities]);
  const latestByProduct = useMemo(() => latestActivityByProduct(activities), [activities]);
  const productsBySku = useMemo(() => new Map(products.map((product) => [product.sku, product])), [products]);
  const spriteImages = useSpriteImages(Math.max(agents.length, 6));

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !wrapper || !ctx) return undefined;

    let raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const logicalWidth = 1040;
    const logicalHeight = Math.max(410, 132 + Math.max(groups.length, 1) * 178);

    const render = (now: number) => {
      const cssWidth = Math.max(620, wrapper.clientWidth);
      const cssHeight = Math.round((logicalHeight / logicalWidth) * cssWidth);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      ctx.setTransform((cssWidth / logicalWidth) * dpr, 0, 0, (cssHeight / logicalHeight) * dpr, 0, 0);
      drawScene(ctx, {
        now,
        agents,
        groups,
        latestByAgent,
        latestByProduct,
        productsBySku,
        selected,
        spriteImages,
        width: logicalWidth,
        height: logicalHeight,
        hits: hitsRef.current,
      });
      raf = window.requestAnimationFrame(render);
    };

    raf = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(raf);
  }, [agents, groups, latestByAgent, latestByProduct, productsBySku, selected, spriteImages]);

  return (
    <div className="local-pipeline-office">
      <div ref={wrapperRef} className="pipeline-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="pipeline-canvas"
          onClick={(event) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const logicalX = ((event.clientX - rect.left) / rect.width) * 1040;
            const logicalY =
              ((event.clientY - rect.top) / rect.height) *
              Math.max(410, 132 + Math.max(groups.length, 1) * 178);
            const hit = hitsRef.current.find(
              (candidate) =>
                logicalX >= candidate.x &&
                logicalX <= candidate.x + candidate.w &&
                logicalY >= candidate.y &&
                logicalY <= candidate.y + candidate.h,
            );
            setSelected(hit?.hit ?? null);
          }}
        />
      </div>
      <PipelineDetails
        selected={selected}
        agents={agents}
        productsBySku={productsBySku}
        latestByAgent={latestByAgent}
        latestByProduct={latestByProduct}
      />
    </div>
  );
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  options: {
    now: number;
    agents: LocalAgentStatus[];
    groups: Array<{ apiKeyId: string; apiKeyLabel: string; agents: LocalAgentStatus[] }>;
    latestByAgent: Map<string, LocalJobActivityEvent>;
    latestByProduct: Map<string, LocalJobActivityEvent>;
    productsBySku: Map<string, ProductResult>;
    selected: SceneHit | null;
    spriteImages: HTMLImageElement[];
    width: number;
    height: number;
    hits: Array<{ hit: SceneHit; x: number; y: number; w: number; h: number }>;
  },
) {
  const { now, groups, latestByAgent, latestByProduct, productsBySku, selected, spriteImages, width, height, hits } =
    options;
  hits.length = 0;
  ctx.clearRect(0, 0, width, height);
  drawBackground(ctx, width, height);
  drawHeader(ctx, options.agents.length, [...latestByProduct.values()].length);

  const rowHeight = 178;
  const firstRowY = 104;
  const shownGroups = groups.length > 0 ? groups : [{ apiKeyId: 'empty', apiKeyLabel: 'Waiting for API keys', agents: [] }];
  shownGroups.forEach((group, groupIndex) => {
    const y = firstRowY + groupIndex * rowHeight;
    drawGroupLane(ctx, group.apiKeyLabel, y);
    for (const station of roleStations) {
      const agent = group.agents.find((item) => item.role === station.role);
      const activity = agent ? latestByAgent.get(agent.id) : undefined;
      drawStation(ctx, station, y, agent, activity, selected);
      if (agent) {
        hits.push({ hit: { type: 'agent', id: agent.id }, x: station.x - 46, y: y + 34, w: 92, h: 118 });
        drawCharacter(ctx, station.x, y + 104, groupIndex * roleStations.length + roleStations.indexOf(station), agent, activity, now, spriteImages);
      }
    }
  });

  drawProducts(ctx, latestByProduct, productsBySku, shownGroups, firstRowY, rowHeight, selected, hits, now);
}

function drawBackground(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = '#121520';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#1c2230';
  for (let y = 0; y < height; y += 24) {
    for (let x = (y / 24) % 2 === 0 ? 0 : 12; x < width; x += 24) {
      ctx.fillRect(x, y, 12, 12);
    }
  }
  ctx.fillStyle = '#243142';
  ctx.fillRect(0, 70, width, 4);
}

function drawHeader(ctx: CanvasRenderingContext2D, agentCount: number, productCount: number) {
  ctx.fillStyle = '#f7f0d0';
  ctx.font = '24px "FS Pixel Sans", monospace';
  ctx.fillText('Image Finder pipeline', 24, 38);
  ctx.fillStyle = '#9eb0c8';
  ctx.font = '16px "FS Pixel Sans", monospace';
  ctx.fillText(`${agentCount} agents seated  |  ${productCount} products in telemetry`, 26, 60);
}

function drawGroupLane(ctx: CanvasRenderingContext2D, label: string, y: number) {
  ctx.fillStyle = '#1a2030';
  ctx.fillRect(20, y, 1000, 146);
  ctx.strokeStyle = '#40506a';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, y, 1000, 146);
  ctx.fillStyle = '#f7f0d0';
  ctx.font = '16px "FS Pixel Sans", monospace';
  ctx.fillText(label, 34, y + 24);
  ctx.fillStyle = '#2d3a4c';
  ctx.fillRect(86, y + 108, 880, 18);
  ctx.fillStyle = '#5c6f89';
  for (let x = 96; x < 950; x += 34) ctx.fillRect(x, y + 112, 18, 10);
}

function drawStation(
  ctx: CanvasRenderingContext2D,
  station: RoleStation,
  y: number,
  agent: LocalAgentStatus | undefined,
  activity: LocalJobActivityEvent | undefined,
  selected: SceneHit | null,
) {
  const state = agent?.manualAction ? 'blocked' : agent?.state ?? 'idle';
  const active = state === 'active';
  const blocked = state === 'blocked';
  const error = state === 'error';
  ctx.fillStyle = active ? '#233a2a' : blocked ? '#493319' : error ? '#4a2028' : '#20283a';
  ctx.fillRect(station.x - 54, y + 38, 108, 84);
  ctx.strokeStyle =
    selected?.type === 'agent' && selected.id === agent?.id
      ? '#ffffff'
      : active
        ? '#89d185'
        : blocked
          ? '#ffb257'
          : error
            ? '#d14249'
            : '#526079';
  ctx.lineWidth = 3;
  ctx.strokeRect(station.x - 54, y + 38, 108, 84);
  ctx.fillStyle = '#f7f0d0';
  ctx.font = '15px "FS Pixel Sans", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(station.label, station.x, y + 56);
  ctx.fillStyle = '#9eb0c8';
  ctx.font = '12px "FS Pixel Sans", monospace';
  ctx.fillText(activity?.message?.slice(0, 20) || agent?.activeProduct?.slice(0, 20) || state, station.x, y + 74);
  ctx.textAlign = 'left';
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  x: number,
  feetY: number,
  spriteIndex: number,
  agent: LocalAgentStatus,
  activity: LocalJobActivityEvent | undefined,
  now: number,
  spriteImages: HTMLImageElement[],
) {
  const image = spriteImages[spriteIndex % Math.max(spriteImages.length, 1)];
  const mode = activityAnimationMode(agent, activity);
  const active = mode !== 'idle';
  const read = mode === 'reading';
  const alternate = Math.floor(now / 280) % 2 === 0;
  const frame = !active ? spriteFrame.idle : read ? (alternate ? spriteFrame.readA : spriteFrame.readB) : alternate ? spriteFrame.typeA : spriteFrame.typeB;
  const row = 0;
  const destW = sprite.width * sprite.scale;
  const destH = sprite.height * sprite.scale;
  if (image?.complete && image.naturalWidth > 0) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, frame * sprite.width, row * sprite.height, sprite.width, sprite.height, x - destW / 2, feetY - destH, destW, destH);
  } else {
    ctx.fillStyle = active ? '#89d185' : '#75839b';
    ctx.fillRect(x - 16, feetY - 54, 32, 54);
  }
  if (mode === 'blocked') drawBubble(ctx, x + 28, feetY - 86, '...');
  if (mode === 'error') drawBubble(ctx, x + 28, feetY - 86, '!');
}

function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.fillStyle = '#fff5d8';
  ctx.fillRect(x, y, 38, 22);
  ctx.strokeStyle = '#0a0a14';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, 38, 22);
  ctx.fillStyle = '#0a0a14';
  ctx.font = '14px "FS Pixel Sans", monospace';
  ctx.fillText(text, x + 9, y + 15);
}

function drawProducts(
  ctx: CanvasRenderingContext2D,
  latestByProduct: Map<string, LocalJobActivityEvent>,
  productsBySku: Map<string, ProductResult>,
  groups: Array<{ apiKeyId: string; apiKeyLabel: string; agents: LocalAgentStatus[] }>,
  firstRowY: number,
  rowHeight: number,
  selected: SceneHit | null,
  hits: Array<{ hit: SceneHit; x: number; y: number; w: number; h: number }>,
  now: number,
) {
  for (const [sku, activity] of latestByProduct) {
    const groupIndex = Math.max(0, groups.findIndex((group) => group.apiKeyId === activity.apiKeyId));
    const y = firstRowY + groupIndex * rowHeight + 118;
    const progress = phaseProgress[activity.phase] ?? 0;
    const x = 74 + progress * 900;
    const result = productsBySku.get(sku);
    const failed = activity.state === 'error' || result?.status === 'failed';
    const done = activity.phase === 'product:complete' || result?.status === 'completed';
    const rejected = activity.state === 'rejected';
    const wobble = rejected ? Math.sin(now / 90) * 4 : 0;
    ctx.fillStyle = failed ? '#d14249' : done ? '#89d185' : rejected ? '#ffb257' : '#7aa2ff';
    ctx.fillRect(x - 22, y - 18 + wobble, 44, 28);
    ctx.strokeStyle = selected?.type === 'product' && selected.id === sku ? '#ffffff' : '#0a0a14';
    ctx.lineWidth = 3;
    ctx.strokeRect(x - 22, y - 18 + wobble, 44, 28);
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(x - 14, y - 24 + wobble, 28, 6);
    ctx.fillStyle = '#f7f0d0';
    ctx.font = '12px "FS Pixel Sans", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(sku.slice(0, 10), x, y + 28);
    ctx.textAlign = 'left';
    hits.push({ hit: { type: 'product', id: sku }, x: x - 30, y: y - 32, w: 60, h: 74 });
  }
}

function PipelineDetails({
  selected,
  agents,
  productsBySku,
  latestByAgent,
  latestByProduct,
}: {
  selected: SceneHit | null;
  agents: LocalAgentStatus[];
  productsBySku: Map<string, ProductResult>;
  latestByAgent: Map<string, LocalJobActivityEvent>;
  latestByProduct: Map<string, LocalJobActivityEvent>;
}) {
  if (!selected) {
    return <div className="pipeline-details">Click an agent or product package for live details.</div>;
  }
  if (selected.type === 'agent') {
    const agent = agents.find((item) => item.id === selected.id);
    const activity = latestByAgent.get(selected.id);
    if (!agent) return <div className="pipeline-details">Agent not found.</div>;
    return (
      <div className="pipeline-details">
        <strong>{agent.label}</strong>
        <span>{agent.model}</span>
        <span>{activity ? `${activity.phase} - ${activity.state}` : agent.state}</span>
        <span>{activity?.message || agent.activeProduct || 'idle'}</span>
        {agent.manualAction && <a href={agent.manualAction.url}>{agent.manualAction.message}</a>}
        {agent.lastError && <small>{agent.lastError}</small>}
      </div>
    );
  }
  const result = productsBySku.get(selected.id);
  const activity = latestByProduct.get(selected.id);
  return (
    <div className="pipeline-details">
      <strong>{selected.id}</strong>
      <span>{activity ? `${activity.phase} - ${activity.state}` : result?.status}</span>
      <span>{activity?.message || result?.validationReason || 'No details yet'}</span>
      {activity?.candidate && <a href={activity.candidate.url}>{activity.candidate.title || activity.candidate.url}</a>}
      {result?.sourceUrl && <a href={result.sourceUrl}>{result.sourceUrl}</a>}
    </div>
  );
}

function groupAgentsByApiKey(agents: LocalAgentStatus[]): Array<{ apiKeyId: string; apiKeyLabel: string; agents: LocalAgentStatus[] }> {
  const byKey = new Map<string, { apiKeyId: string; apiKeyLabel: string; agents: LocalAgentStatus[] }>();
  for (const agent of agents) {
    const group = byKey.get(agent.apiKeyId) ?? {
      apiKeyId: agent.apiKeyId,
      apiKeyLabel: agent.apiKeyLabel,
      agents: [],
    };
    group.agents.push(agent);
    byKey.set(agent.apiKeyId, group);
  }
  return [...byKey.values()];
}

function latestActivityByAgent(activities: LocalJobActivityEvent[]): Map<string, LocalJobActivityEvent> {
  const byAgent = new Map<string, LocalJobActivityEvent>();
  for (const activity of activities) byAgent.set(activity.agentId, activity);
  return byAgent;
}

function latestActivityByProduct(activities: LocalJobActivityEvent[]): Map<string, LocalJobActivityEvent> {
  const byProduct = new Map<string, LocalJobActivityEvent>();
  for (const activity of activities) {
    if (activity.product?.sku) byProduct.set(activity.product.sku, activity);
  }
  return byProduct;
}

function useSpriteImages(count: number): HTMLImageElement[] {
  const [images, setImages] = useState<HTMLImageElement[]>([]);
  useEffect(() => {
    const loaded = Array.from({ length: Math.max(6, count) }, (_, index) => {
      const image = new Image();
      image.src = `/assets/characters/char_${index % 6}.png`;
      return image;
    });
    setImages(loaded);
  }, [count]);
  return images;
}
