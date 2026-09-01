import { describe, expect, it } from 'vitest';
import { localExecutableAsset } from './web-duckdb';

describe('web DuckDB executable assets', () => {
  it('normalizes Vite asset URLs to same-origin paths', () => {
    expect(
      localExecutableAsset(
        'https://csv.example/app/assets/duckdb.wasm',
        'https://csv.example/app/index.html',
      ),
    ).toBe('/app/assets/duckdb.wasm');
    expect(
      localExecutableAsset('./assets/duckdb.worker.js', 'https://csv.example/app/index.html'),
    ).toBe('/app/assets/duckdb.worker.js');
  });

  it('rejects executable assets from another origin', () => {
    expect(() =>
      localExecutableAsset('https://cdn.example/duckdb.wasm', 'https://csv.example/app/'),
    ).toThrow('same origin');
  });
});
