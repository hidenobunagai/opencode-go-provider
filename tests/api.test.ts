import { fetchModels, streamChatCompletion, BASE_URL } from '../src/api';
import { OcGoStreamResponse } from '../src/types';

describe('fetchModels', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns models on success', async () => {
    const mockModels = [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }];
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mockModels }),
    } as any);

    const result = await fetchModels('test-key');
    expect(result).toEqual(mockModels);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/models`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      })
    );
  });

  it('returns null on failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid key',
    } as any);

    const result = await fetchModels('bad-key');
    expect(result).toBeNull();
  });
});

describe('streamChatCompletion', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('yields parsed SSE chunks', async () => {
    const chunk: OcGoStreamResponse = {
      id: '1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'kimi-k2.6',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: stream,
    } as any);

    const gen = streamChatCompletion('key', { model: 'kimi-k2.6', messages: [], stream: true });
    const results: OcGoStreamResponse[] = [];
    for await (const item of gen) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0].choices[0].delta.content).toBe('Hello');
  });

  it('throws on non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server error',
    } as any);

    const gen = streamChatCompletion('key', { model: 'kimi-k2.6', messages: [], stream: true });
    await expect(gen.next()).rejects.toThrow('OpenCode Go API error: 500 Internal Server Error');
  });

  it('throws authentication error on 401', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid key',
    } as any);

    const gen = streamChatCompletion('key', { model: 'kimi-k2.6', messages: [], stream: true });
    await expect(gen.next()).rejects.toThrow('Authentication failed. Your API key may be invalid or expired.');
  });

  it('throws rate limit error on 429', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: (name: string) => name === 'retry-after' ? '60' : null },
      text: async () => 'Rate limited',
    } as any);

    const gen = streamChatCompletion('key', { model: 'kimi-k2.6', messages: [], stream: true });
    await expect(gen.next()).rejects.toThrow('Rate limited. Retry after 60s.');
  });

  it('retries on network failure and succeeds', async () => {
    const mockModels = [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }];
    global.fetch = jest.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockModels }),
      } as any);

    const result = await fetchModels('test-key');
    expect(result).toEqual(mockModels);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries up to 3 times then returns null', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const result = await fetchModels('test-key');
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('handles partial lines across chunks', async () => {
    const chunk: OcGoStreamResponse = {
      id: '1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'kimi-k2.6',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    };
    const encoder = new TextEncoder();
    const jsonStr = JSON.stringify(chunk);
    const part1 = `data: ${jsonStr.slice(0, 10)}`;
    const part2 = `${jsonStr.slice(10)}\n\n`;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: stream,
    } as any);

    const gen = streamChatCompletion('key', { model: 'kimi-k2.6', messages: [], stream: true });
    const results: OcGoStreamResponse[] = [];
    for await (const item of gen) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0].choices[0].delta.content).toBe('Hello');
  });

  it('skips malformed JSON lines', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {invalid json}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: stream,
    } as any);

    const gen = streamChatCompletion('key', { model: 'kimi-k2.6', messages: [], stream: true });
    const results: OcGoStreamResponse[] = [];
    for await (const item of gen) {
      results.push(item);
    }

    expect(results).toHaveLength(0);
  });
});
