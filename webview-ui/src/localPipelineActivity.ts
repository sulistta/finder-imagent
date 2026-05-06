export type PipelineAnimationAgent = {
  state: 'idle' | 'active' | 'blocked' | 'error';
};

export type PipelineAnimationActivity = {
  role: 'query' | 'ranking' | 'visual' | 'metadata';
  phase: string;
  state: 'start' | 'progress' | 'success' | 'rejected' | 'blocked' | 'unblocked' | 'error';
};

export function activityAnimationMode(
  agent: PipelineAnimationAgent,
  activity?: PipelineAnimationActivity,
): 'idle' | 'typing' | 'reading' | 'blocked' | 'error' {
  if (agent.state === 'error' || activity?.state === 'error') return 'error';
  if (agent.state === 'blocked' || activity?.state === 'blocked') return 'blocked';
  if (agent.state !== 'active') return 'idle';
  if (activity?.role === 'ranking' || activity?.role === 'visual') return 'reading';
  if (activity?.phase.startsWith('ranking:') || activity?.phase.startsWith('visual:')) return 'reading';
  return 'typing';
}
