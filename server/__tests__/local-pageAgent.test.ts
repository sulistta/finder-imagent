import { describe, expect, it } from 'vitest';

import { forwardPageAgentGeminiRequest, normalizePageAgentSelection } from '../src/pageAgentSelection.js';
import type { SearchCandidate } from '../src/types.js';

describe('PageAgent candidate selection helpers', () => {
  it('keeps only existing selected URLs, preserves order, and removes duplicates', () => {
    const candidates: SearchCandidate[] = [
      { url: 'https://shop.test/a', title: 'A', snippet: 'first' },
      { url: 'https://shop.test/b', title: 'B', snippet: 'second' },
    ];

    expect(
      normalizePageAgentSelection(
        {
          candidatos: [
            { href: 'https://shop.test/b', motivo: 'melhor modelo' },
            { href: 'https://missing.test/product', motivo: 'invented' },
            { href: 'https://shop.test/b', motivo: 'duplicate' },
            { url: 'https://shop.test/a', reason: 'fallback' },
          ],
        },
        candidates,
      ),
    ).toEqual([
      { url: 'https://shop.test/b', title: 'B', snippet: 'second', reason: 'melhor modelo' },
      { url: 'https://shop.test/a', title: 'A', snippet: 'first', reason: 'fallback' },
    ]);
  });

  it('adds the Gemini bearer token in the backend bridge without trusting frontend auth headers', async () => {
    let forwardedHeaders: Record<string, string> = {};
    const fetchMock: typeof fetch = async (_input, init) => {
      forwardedHeaders = init?.headers as Record<string, string>;
      return new Response('{"ok":true}', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    };

    const response = await forwardPageAgentGeminiRequest(
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        method: 'POST',
        headers: {
          Authorization: 'Bearer frontend-key',
          'x-goog-api-key': 'frontend-key',
          'Content-Type': 'application/json',
        },
        body: '{"model":"gemini"}',
      },
      { id: 'key-1', label: 'Google 1', key: 'real-backend-key' },
      fetchMock,
    );

    expect(forwardedHeaders.Authorization).toBe('Bearer real-backend-key');
    expect(forwardedHeaders['x-goog-api-key']).toBeUndefined();
    expect(response.body).toBe('{"ok":true}');
  });
});
