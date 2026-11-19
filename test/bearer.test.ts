import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { bearer } from '../src/lib/auth.js';

const req = (authorization?: string) => ({ headers: { authorization } }) as Request;

describe('bearer', () => {
  it('reads Bearer tokens, a bare agent token (xAI MCP), and a doubled Bearer', () => {
    expect(bearer(req('Bearer a2ah_x'))).toBe('a2ah_x');
    expect(bearer(req('a2ah_x'))).toBe('a2ah_x');
    expect(bearer(req('Bearer Bearer a2ah_x'))).toBe('a2ah_x');
    expect(bearer(req('bearer tok'))).toBe('tok');
    expect(bearer(req('Basic abc'))).toBeUndefined();
    expect(bearer(req('Bearer'))).toBeUndefined();
    expect(bearer(req())).toBeUndefined();
  });
});
