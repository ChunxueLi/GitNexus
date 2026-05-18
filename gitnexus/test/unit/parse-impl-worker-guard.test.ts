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

  it('returns true when C++ files are present', () => {
    expect(
      hasWorkerUnsafeLanguages([
        { path: 'src/main.ts', size: 123 },
        { path: 'native/runtime.cpp', size: 456 },
      ]),
    ).toBe(true);
  });

  it('returns true when C files (.c extension) are present', () => {
    expect(hasWorkerUnsafeLanguages([{ path: 'lib/util.c', size: 100 }])).toBe(true);
  });

  it('returns true when C header files are present', () => {
    expect(hasWorkerUnsafeLanguages([{ path: 'include/api.h', size: 100 }])).toBe(true);
  });

  it('returns true when C++ header files (.hpp, .hxx, .hh) are present', () => {
    expect(hasWorkerUnsafeLanguages([{ path: 'include/api.hpp', size: 100 }])).toBe(true);
    expect(hasWorkerUnsafeLanguages([{ path: 'include/core.hxx', size: 100 }])).toBe(true);
    expect(hasWorkerUnsafeLanguages([{ path: 'include/util.hh', size: 100 }])).toBe(true);
  });

  it('returns false for an empty list', () => {
    expect(hasWorkerUnsafeLanguages([])).toBe(false);
  });
});
