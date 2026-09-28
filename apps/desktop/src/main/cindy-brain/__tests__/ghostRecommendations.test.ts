import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledGhost } from '../../../shared/ghost';
import { validateGhostManifest } from '../../../shared/ghost';
import { buildGhostRecommendationSnapshot } from '../ghostRecommendationSnapshot';

const state = vi.hoisted(() => ({
  owner: 'owner-a',
  buckets: new Map<string, Record<string, unknown>>(),
  failRecentWrite: false,
  failRecommendationRead: false,
}));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: (...parts: string[]) => path.join(state.owner, ...parts) }));
vi.mock('electron-store', () => ({
  default: class {
    constructor(private options: { cwd: string; name: string; defaults: Record<string, unknown> }) {
      if (!state.buckets.has(options.cwd))
        state.buckets.set(options.cwd, structuredClone(options.defaults));
    }
    get(key: string) {
      if (state.failRecommendationRead && this.options.name === 'ghost-recommendations') throw new Error('read unavailable');
      return state.buckets.get(this.options.cwd)?.[key];
    }
    set(key: string, value: unknown) {
      if (state.failRecentWrite && this.options.name === 'ghost-recent-usage') throw new Error('disk unavailable');
      state.buckets.get(this.options.cwd)![key] = structuredClone(value);
    }
  },
}));
import {
  readGhostRecommendationEntries,
  replaceGhostRecommendations,
  markGhostRecommendationInstalled,
  consumeGhostRecommendationPriority,
  forgetGhostRecommendations,
  relocateGhostRecommendations,
} from '../ghostRecommendationStore';
import {
  loadGhostRecentIds,
  markGhostRecentlyUsed,
  relocateGhostRecentUsage,
} from '../ghostRecentUsageStore';
import {
  isGhostOptionalRelocationSource,
  prepareGhostOptionalRelocation,
  readyGhostOptionalRelocation,
  retryGhostOptionalRelocations,
} from '../ghostOptionalRelocation';
const item = { id: 'one', label: 'Review email', prompt: 'Review email for me.' };
const ghost = {
  enabled: true,
  manifest: { id: 'example', recommendations: [item] },
} as unknown as InstalledGhost;
beforeEach(() => {
  state.owner = 'owner-a';
  state.failRecentWrite = false;
  state.failRecommendationRead = false;
  state.buckets.set('owner-a', { entries: [], ids: [] });
  state.buckets.set('owner-b', { entries: [], ids: [] });
});
describe('plugin recommendation state', () => {
  it('replaces, withdraws, preserves install priority and isolates owners', () => {
    markGhostRecommendationInstalled('example');
    const installedAt = readGhostRecommendationEntries()[0].installedAt;
    expect(replaceGhostRecommendations('example', [item])).toEqual({ ok: true });
    expect(replaceGhostRecommendations('example', [])).toEqual({ ok: true });
    expect(readGhostRecommendationEntries()[0]).toEqual({ id: 'example', items: [], installedAt });
    expect(
      buildGhostRecommendationSnapshot(state.owner, [ghost], readGhostRecommendationEntries(), [])
        .sources[0].items,
    ).toEqual([]);
    state.owner = 'owner-b';
    expect(readGhostRecommendationEntries()).toEqual([]);
    state.owner = 'owner-a';
    expect(readGhostRecommendationEntries()[0].items).toEqual([]);
    consumeGhostRecommendationPriority('example');
    expect(
      buildGhostRecommendationSnapshot(state.owner, [ghost], readGhostRecommendationEntries(), [])
        .newlyInstalledId,
    ).toBeNull();
    forgetGhostRecommendations('example');
    expect(readGhostRecommendationEntries()).toEqual([]);
  });
  it('accepts namespaced instance ids used by the pipe binding', () => {
    expect(replaceGhostRecommendations('_ns__xd__helper', [item])).toEqual({ ok: true });
    expect(readGhostRecommendationEntries()[0].id).toBe('_ns__xd__helper');
  });
  it('keeps same-name root and organization recommendations and history separate', () => {
    const root = { ...ghost, manifest: { ...ghost.manifest, id: 'helper', name: 'Root' }, dir: '/ghosts/helper', namespace: null };
    const org = { ...ghost, manifest: { ...ghost.manifest, id: 'helper', name: 'Org' }, dir: '/ghosts/_ns/acme/helper', namespace: 'acme' };
    replaceGhostRecommendations('helper', [{ ...item, id: 'root' }]);
    replaceGhostRecommendations('_ns__acme__helper', [{ ...item, id: 'org' }]);
    markGhostRecommendationInstalled('_ns__acme__helper');
    const snapshot = buildGhostRecommendationSnapshot('owner-a', [root, org], readGhostRecommendationEntries(), ['_ns__acme__helper']);
    expect(snapshot.sources.map((source) => [source.ghostId, source.items?.[0]?.id])).toEqual([
      ['helper', 'root'], ['_ns__acme__helper', 'org'],
    ]);
    expect(snapshot.recentIds).toEqual(['_ns__acme__helper']);
    expect(snapshot.newlyInstalledId).toBe('_ns__acme__helper');
  });
  it('moves an in-place organization recommendation without overwriting destination data', () => {
    replaceGhostRecommendations('helper', [{ ...item, id: 'source' }]);
    markGhostRecommendationInstalled('helper');
    relocateGhostRecommendations('helper', '_ns__acme__helper');
    expect(readGhostRecommendationEntries()).toEqual([{
      id: '_ns__acme__helper', items: [{ ...item, id: 'source' }], installedAt: expect.any(Number),
    }]);
    relocateGhostRecommendations('helper', '_ns__acme__helper');
    expect(readGhostRecommendationEntries()).toHaveLength(1);
    replaceGhostRecommendations('helper', [{ ...item, id: 'later-root' }]);
    expect(readGhostRecommendationEntries()).toHaveLength(2);
    replaceGhostRecommendations('_ns__acme__helper', [{ ...item, id: 'destination' }]);
    relocateGhostRecommendations('helper', '_ns__acme__helper');
    expect(readGhostRecommendationEntries()).toEqual([{
      id: '_ns__acme__helper', items: [{ ...item, id: 'destination' }], installedAt: expect.any(Number),
    }]);
    consumeGhostRecommendationPriority('_ns__acme__helper');
    replaceGhostRecommendations('helper', [{ ...item, id: 'later-root' }]);
    relocateGhostRecommendations('helper', '_ns__acme__helper');
    expect(readGhostRecommendationEntries()).toEqual([{
      id: '_ns__acme__helper', items: [{ ...item, id: 'destination' }],
    }]);
  });
  it('transfers recent use to the relocated organization without granting it to a new root', () => {
    markGhostRecentlyUsed('_ns__acme__helper');
    markGhostRecentlyUsed('helper');
    relocateGhostRecentUsage('helper', '_ns__acme__helper');
    expect(loadGhostRecentIds()).toEqual(['_ns__acme__helper']);
    relocateGhostRecentUsage('helper', '_ns__acme__helper');
    expect(loadGhostRecentIds()).toEqual(['_ns__acme__helper']);
  });
  it('defers failed optional history writes without leaking old root data to a later root install', () => {
    const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-optional-history-'));
    state.owner = owner;
    state.buckets.set(owner, { entries: [], ids: [] });
    try {
      replaceGhostRecommendations('helper', [{ ...item, id: 'old-root' }]);
      markGhostRecentlyUsed('helper');
      prepareGhostOptionalRelocation('helper', '_ns__acme__helper');
      expect(isGhostOptionalRelocationSource('helper')).toBe(true);
      const move = () => {
        relocateGhostRecommendations('helper', '_ns__acme__helper');
        relocateGhostRecentUsage('helper', '_ns__acme__helper');
      };
      const failure = vi.fn();
      retryGhostOptionalRelocations(move, failure);
      expect(readGhostRecommendationEntries()[0].id).toBe('helper');
      readyGhostOptionalRelocation('helper', '_ns__acme__helper');
      state.failRecentWrite = true;
      retryGhostOptionalRelocations(move, failure);
      expect(failure).toHaveBeenCalledOnce();
      expect(isGhostOptionalRelocationSource('helper')).toBe(true);
      expect(replaceGhostRecommendations('helper', [item])).toEqual({ ok: false, errorCode: 'INTERNAL' });
      expect(() => markGhostRecentlyUsed('helper')).toThrow('relocation pending');
      expect(readGhostRecommendationEntries().filter((entry) => !isGhostOptionalRelocationSource(entry.id)))
        .toEqual([{ id: '_ns__acme__helper', items: [{ ...item, id: 'old-root' }] }]);
      expect(loadGhostRecentIds().filter((id) => !isGhostOptionalRelocationSource(id))).toEqual([]);
      state.failRecentWrite = false;
      retryGhostOptionalRelocations(move, failure);
      expect(isGhostOptionalRelocationSource('helper')).toBe(false);
      expect(loadGhostRecentIds()).toEqual(['_ns__acme__helper']);
      replaceGhostRecommendations('helper', [{ ...item, id: 'new-root' }]);
      expect(readGhostRecommendationEntries().map((entry) => [entry.id, entry.items?.[0]?.id]))
        .toEqual([['_ns__acme__helper', 'old-root'], ['helper', 'new-root']]);
    } finally {
      state.failRecentWrite = false;
      fs.rmSync(owner, { recursive: true, force: true });
    }
  });
  it('keeps unreadable optional history pending until a later read succeeds', () => {
    const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-optional-history-'));
    state.owner = owner;
    state.buckets.set(owner, { entries: [], ids: [] });
    try {
      replaceGhostRecommendations('helper', [{ ...item, id: 'old-root' }]);
      prepareGhostOptionalRelocation('helper', '_ns__acme__helper');
      readyGhostOptionalRelocation('helper', '_ns__acme__helper');
      state.failRecommendationRead = true;
      const failure = vi.fn();
      retryGhostOptionalRelocations(relocateGhostRecommendations, failure);
      expect(failure).toHaveBeenCalledOnce();
      expect(isGhostOptionalRelocationSource('helper')).toBe(true);
      state.failRecommendationRead = false;
      retryGhostOptionalRelocations(relocateGhostRecommendations, failure);
      expect(isGhostOptionalRelocationSource('helper')).toBe(false);
      expect(readGhostRecommendationEntries()[0].id).toBe('_ns__acme__helper');
    } finally {
      state.failRecommendationRead = false;
      fs.rmSync(owner, { recursive: true, force: true });
    }
  });
  it('rejects invalid replacement without losing previous tasks', () => {
    replaceGhostRecommendations('example', [item]);
    expect(replaceGhostRecommendations('example', [{ ...item, pluginId: 'other' }]).ok).toBe(false);
    expect(readGhostRecommendationEntries()[0].items).toEqual([item]);
  });
  it('keeps no-field old plugins and uses only currently installed identities', () => {
    expect(
      buildGhostRecommendationSnapshot('a', [ghost], [], ['gone', 'example']).recentIds,
    ).toEqual(['example']);
    expect(
      buildGhostRecommendationSnapshot('a', [], [{ id: 'gone', installedAt: 1 }], [])
        .newlyInstalledId,
    ).toBeNull();
    const old = {
      schemaVersion: 2,
      id: 'old',
      name: 'Old',
      version: '1',
      entry: 'main.js',
      slots: [],
    };
    expect(validateGhostManifest(old).ok).toBe(true);
    const result = validateGhostManifest({ ...old, recommendations: [item] });
    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest).not.toHaveProperty('recommendations');
  });
  it.each(['legacy metadata', { custom: true }, [{ ...item, priority: 99 }]])(
    'preserves opaque v3 metadata without publishing invalid recommendations: %j',
    (recommendations) => {
      const parsed = validateGhostManifest({
        schemaVersion: 3,
        minCindyVersion: '0.1.61',
        id: 'example',
        name: 'Example',
        version: '1',
        entry: 'main.js',
        recommendations,
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.manifest.recommendations).toEqual(recommendations);
      const installed = { ...ghost, manifest: parsed.manifest };
      expect(
        buildGhostRecommendationSnapshot('a', [installed], [], []).sources[0].items,
      ).toBeUndefined();
      expect(
        buildGhostRecommendationSnapshot('a', [installed], [{ id: 'example', items: [item] }], [])
          .sources[0].items,
      ).toEqual([item]);
      expect(
        buildGhostRecommendationSnapshot('a', [installed], [{ id: 'example', items: [] }], [])
          .sources[0].items,
      ).toEqual([]);
    },
  );
});
