import { describe, expect, it } from 'vitest';

import {
  forwardPageAgentGeminiRequest,
  getSuccessfulPageAgentData,
  normalizePageAgentSelection,
  sanitizePageAgentRequestBody,
} from '../src/pageAgentSelection.js';
import type { SearchCandidate } from '../src/types.js';

describe('PageAgent candidate ranking', () => {
  it('accepts only existing Google candidates and removes duplicates', () => {
    const candidates: SearchCandidate[] = [
      { url: 'https://shop.test/a', title: 'A', snippet: 'A' },
      { url: 'https://shop.test/b', title: 'B', snippet: 'B' },
    ];

    expect(
      normalizePageAgentSelection(
        `${JSON.stringify({
          candidatos: [
            { href: 'https://shop.test/b', motivo: 'modelo correto' },
            { href: 'https://missing.test/product', motivo: 'inventado' },
            { href: 'https://shop.test/b', motivo: 'duplicado' },
          ],
        })}\nTexto extra do modelo.`,
        candidates,
      ),
    ).toEqual([{ url: 'https://shop.test/b', title: 'B', snippet: 'B', reason: 'modelo correto' }]);
  });

  it('strips unsupported Structured Outputs fields from PageAgent requests', () => {
    expect(
      sanitizePageAgentRequestBody(
        JSON.stringify({
          model: 'gemini-3.1-flash',
          response_format: { type: 'json_object' },
          reasoning_effort: 'medium',
          messages: [],
        }),
      ),
    ).toEqual({
      model: 'gemini-3.1-flash',
      messages: [],
    });
  });

  it('forwards PageAgent Gemini requests through the backend without leaking browser auth', async () => {
    let forwardedHeaders: Headers | null = null;
    let forwardedBody: unknown;
    const response = await forwardPageAgentGeminiRequest(
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        method: 'POST',
        headers: {
          authorization: 'Bearer frontend-key',
          'x-goog-api-key': 'frontend-key',
          'content-type': 'text/plain',
        },
        body: JSON.stringify({ model: 'gemini-3.1-flash', messages: [] }),
      },
      { id: 'key-1', label: 'Google 1', key: 'backend-secret' },
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        forwardedHeaders = new Headers(init?.headers);
        forwardedBody = JSON.parse(String(init?.body));
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    expect(response).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(forwardedHeaders).not.toBeNull();
    const headers = forwardedHeaders as unknown as Headers;
    expect(headers.get('Authorization')).toBe('Bearer backend-secret');
    expect(headers.get('x-goog-api-key')).toBeNull();
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(forwardedBody).toEqual({ model: 'gemini-3.1-flash', messages: [] });
  });

  it('forwards Gemma PageAgent tool requests through the OpenAI-compatible endpoint', async () => {
    let forwardedUrl = '';
    let forwardedBody: Record<string, unknown> = {};
    const response = await forwardPageAgentGeminiRequest(
      {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        method: 'POST',
        body: JSON.stringify({
          model: 'gemma-4-31b-it',
          messages: [{ role: 'user', content: 'rank candidates' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'AgentOutput',
                description: 'PageAgent macro output',
                parameters: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    action: { type: 'object', additionalProperties: false },
                  },
                  required: ['action'],
                },
              },
            },
          ],
        }),
      },
      { id: 'key-1', label: 'Google 1', key: 'backend-secret' },
      async (input: RequestInfo | URL, init?: RequestInit) => {
        forwardedUrl = String(input);
        forwardedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    );

    expect(response).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(forwardedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(forwardedBody.model).toBe('gemma-4-31b-it');
    expect(forwardedBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'AgentOutput',
          description: 'PageAgent macro output',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'object', additionalProperties: false },
            },
            required: ['action'],
          },
        },
      },
    ]);
  });

  it('fails PageAgent execution errors before JSON parsing', () => {
    expect(() => getSuccessfulPageAgentData({ success: false, data: 'InvokeError: Server error:' })).toThrow(
      'PageAgent ranking failed: InvokeError: Server error:',
    );
  });
});
