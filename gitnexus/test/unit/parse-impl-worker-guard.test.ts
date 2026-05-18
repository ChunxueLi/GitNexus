import { describe, expect, it } from 'vitest';

import { hasWorkerUnsafeLanguages } from '../../src/core/ingestion/workers/worker-language-guard.js';

describe('hasWorkerUnsafeLanguages', () => {
  it('returns false for non-C/C++ inputs', () => {
    expect(
      hasWorkerUnsafeLanguages([
        { path: 'src/app.ts', size: 123 },
        { path: 'src/main.py', size: 456 },
      ]),
    ).toBe(false);
  });

  it('returns true when C/C++ files are present', () => {
    expect(
      hasWorkerUnsafeLanguages([
        { path: 'src/main.ts', size: 123 },
        { path: 'native/runtime.cpp', size: 456 },
      ]),
    ).toBe(true);
  });
});
