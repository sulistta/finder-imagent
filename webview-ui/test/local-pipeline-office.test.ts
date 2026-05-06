import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activityAnimationMode } from '../src/localPipelineActivity.ts';

test('activityAnimationMode maps local pipeline roles to sprite behaviors', () => {
  assert.equal(activityAnimationMode({ state: 'idle' }), 'idle');
  assert.equal(
    activityAnimationMode({ state: 'active' }, { role: 'query', phase: 'query:build', state: 'success' }),
    'typing',
  );
  assert.equal(
    activityAnimationMode(
      { state: 'active' },
      { role: 'ranking', phase: 'ranking:search', state: 'start' },
    ),
    'reading',
  );
  assert.equal(
    activityAnimationMode(
      { state: 'active' },
      { role: 'visual', phase: 'visual:validate', state: 'progress' },
    ),
    'reading',
  );
  assert.equal(
    activityAnimationMode({ state: 'blocked' }, { role: 'ranking', phase: 'captcha', state: 'blocked' }),
    'blocked',
  );
  assert.equal(
    activityAnimationMode(
      { state: 'active' },
      { role: 'visual', phase: 'product:failed', state: 'error' },
    ),
    'error',
  );
});
