import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import { createOrganizationPrefixStore } from '../../plugin-market/organizationPrefixStore.js';
import { GhostManager } from '../GhostManager.js';
import {
  classifyNamespaceMigration,
  readNamespaceMigrationInstallOrigin,
  readNamespaceMigrationMarketRecord,
} from '../ghostNamespaceMigration.js';
import {
  assertManagedPluginParentSync,
  GhostInstallReceiptStore,
  createGhostInstallReceipt,
  hashApprovedSkillContent,
} from '../ghostInstallReceipt.js';
import { runGhostSnapshotWorkerRequest } from '../ghostSnapshotWorkerProcess.js';
import JSZip from 'jszip';

let workDir: string;
let rootDir: string;
let manager: GhostManager;

beforeEach(async () => {
  workDir = fs.realpathSync.native(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-ns-mig-mgr-')),
  );
  rootDir = path.join(workDir, 'ghosts');
  manager = new GhostManager({
    getRootDir: () => rootDir,
    mutateSnapshot: async (request) => {
      const { parentDir, ...workerRequest } = request;
      await runGhostSnapshotWorkerRequest(workerRequest, parentDir);
    },
  });
});

afterEach(async () => {
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

function manifest(id = 'hello'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: 'Hello',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: 'do' }],
  };
}

it('rejects linked namespace parents for content recovery and state journals', async () => {
  const outside = path.join(workDir, 'outside');
  const contentNs = path.join(rootDir, '_ns');
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  await fs.promises.mkdir(outside, { recursive: true });
  await fs.promises.mkdir(rootDir, { recursive: true });
  await fs.promises.writeFile(path.join(outside, 'sentinel'), 'keep');
  await fs.promises.symlink(outside, contentNs, 'dir');
  expect(() => assertManagedPluginParentSync(rootDir, '_ns/acme/hello')).toThrow();

  const store = new GhostInstallReceiptStore(() => stateRoot);
  await fs.promises.mkdir(stateRoot, { recursive: true });
  await fs.promises.symlink(outside, path.join(stateRoot, '_ns'), 'dir');
  await expect(store.writePendingMutation('_ns/acme/hello', {
    kind: 'install', packageSha256: 'a'.repeat(64),
  })).rejects.toThrow();
  expect(store.readPendingMutationSync('_ns/acme/hello').state).toBe('unreadable');
  expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
});

it('does not recover an interrupted namespaced uninstall through a linked content parent', async () => {
  const outside = path.join(workDir, 'outside');
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  await fs.promises.mkdir(path.join(outside, 'acme', 'hello'), { recursive: true });
  await fs.promises.writeFile(path.join(outside, 'acme', 'hello', 'sentinel'), 'keep');
  await fs.promises.mkdir(rootDir, { recursive: true });
  await fs.promises.symlink(outside, path.join(rootDir, '_ns'), 'dir');
  const store = new GhostInstallReceiptStore(() => stateRoot);
  await store.writePendingMutation('_ns/acme/hello', { kind: 'uninstall' });
  manager = new GhostManager({ getRootDir: () => rootDir, getStateDir: () => stateRoot });
  expect(fs.readFileSync(path.join(outside, 'acme', 'hello', 'sentinel'), 'utf8')).toBe('keep');
  expect(store.readPendingMutationSync('_ns/acme/hello').state).toBe('valid');
});

it('refuses to publish a namespaced receipt through a linked approval parent', async () => {
  await plantLegacyInstall('hello');
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  const outside = path.join(workDir, 'outside');
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'sentinel'), 'keep');
  await fs.promises.symlink(outside, path.join(stateRoot, '_ns'), 'dir');
  const store = new GhostInstallReceiptStore(() => stateRoot);
  const approval = store.read('hello');
  expect(approval.state).toBe('approved');
  if (approval.state !== 'approved') return;
  await expect(store.write({ ...approval.receipt, namespace: 'acme' }, {
    relId: '_ns/acme/hello', requireSkillSnapshot: false,
  })).rejects.toThrow('parent is not a real directory');
  expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
});

async function plantLegacyInstall(
  id: string,
  withSkill = false,
  installOrigin?: 'agent-forge',
): Promise<void> {
  const dir = path.join(rootDir, id);
  await fs.promises.mkdir(dir, { recursive: true });
  const declared = {
    ...manifest(id),
    ...(withSkill ? {
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    } : {}),
  };
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(declared));
  await fs.promises.writeFile(path.join(dir, 'main.js'), '// ok\n');
  if (withSkill) {
    await fs.promises.mkdir(path.join(dir, 'skills', 'demo'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n\nDemo\n');
  }
  const stateRoot = path.join(workDir, 'ghosts-install-state');
  const store = new GhostInstallReceiptStore(
    () => stateRoot,
    async ({ parentDir, ...request }) => {
      await runGhostSnapshotWorkerRequest(request, parentDir);
    },
  );
  const normalized = declared as never;
  const approvedManifest = {
    ...declared,
  } as InstalledGhost['manifest'];
  await store.write(
    createGhostInstallReceipt({
      manifest: approvedManifest,
      localeResources: {},
      enabled: true,
      trust: {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
      skillContentSha256: await hashApprovedSkillContent(approvedManifest, dir),
      ...(installOrigin ? { installOrigin } : {}),
    }),
    { skillSourceDir: dir },
  );
  void normalized;
}

async function makeCindy(id: string): Promise<string> {
  const zip = new JSZip();
  zip.file('ghost.json', JSON.stringify(manifest(id)));
  zip.file('main.js', '// ok\n');
  const filePath = path.join(workDir, `${id}.cindy`);
  await fs.promises.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  return filePath;
}

describe('GhostManager namespace migration census', () => {
  it('retries a failed first directory scan instead of persisting an empty census', async () => {
    await plantLegacyInstall('hello');
    const actualRead = fs.readdirSync;
    const read = vi.spyOn(fs, 'readdirSync').mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
      if (String(directory) === rootDir) {
        read.mockRestore();
        throw Object.assign(new Error('unavailable'), { code: 'EACCES' });
      }
      return actualRead(directory, ...(args as []));
    }) as typeof fs.readdirSync);
    try {
      expect(manager.ensureNamespaceMigrationCensus()).toBeNull();
    } finally {
      read.mockRestore();
    }
    expect(manager.ensureNamespaceMigrationCensus()?.entries.hello?.status).toBe('pending');
  });
  it('keeps an old unstamped install unresolved when its census is unavailable', async () => {
    await plantLegacyInstall('hello');
    fs.writeFileSync(path.join(workDir, 'ghosts-install-state', 'namespace-migration.v1.json'), '{');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(manager.list()[0]?.namespace).toBeUndefined();
  });
  it('waits for approved origin and organization prefix before committing a Forge install', async () => {
    await plantLegacyInstall('acme-tool', false, 'agent-forge');
    const prefixStore = createOrganizationPrefixStore(path.join(workDir, 'organization.v1.json'));
    let receiptUnreadable = true;
    manager = new GhostManager({
      getRootDir: () => rootDir,
      classifyPendingNamespace: (ghostId, marketSyncCompleted = false) => {
        const prefix = prefixStore.lookup('org-acme');
        return classifyNamespaceMigration({
          ghostId,
          builtin: false,
          installOrigin: readNamespaceMigrationInstallOrigin(() => {
            if (receiptUnreadable) throw new Error('receipt temporarily unreadable');
            return manager.readApprovedInstallOriginStrict(ghostId);
          }),
          marketSyncCompleted,
          marketRecord: null,
          currentOrganization: {
            organizationId: 'org-acme',
            orgSlug: 'acme',
            pluginPrefix: prefix.kind === 'known' ? prefix.pluginPrefix : null,
          },
        });
      },
    });

    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespaceMigration: 'pending' });
    expect(manager.list()[0]?.namespace).toBeUndefined();

    receiptUnreadable = false;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespaceMigration: 'pending' });
    expect(manager.list()[0]?.namespace).toBeUndefined();

    prefixStore.remember('org-acme', 'acme');
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
  });

  it('does not stamp an approval receipt when the market namespace stamp fails', async () => {
    await plantLegacyInstall('hello');
    manager = new GhostManager({
      getRootDir: () => rootDir,
      beforeNamespaceCommit: () => { throw new Error('market namespace conflict'); },
    });
    await expect(manager.commitPendingNamespace('hello', 'acme', 'market-organization'))
      .rejects.toThrow('market namespace conflict');
    const store = new GhostInstallReceiptStore(() => path.join(workDir, 'ghosts-install-state'));
    const approval = store.read('hello');
    expect(approval.state).toBe('approved');
    if (approval.state === 'approved') expect(approval.receipt.namespace).toBeUndefined();
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
  });

  it('runs an approved legacy resident offline, then stops it before stamping and restarts after commit', async () => {
    await plantLegacyInstall('hello');
    const events: string[] = [];
    let runtimeBusy = false;
    manager = new GhostManager({
      getRootDir: () => rootDir,
      classifyPendingNamespace: (_id, synced) => synced
        ? { kind: 'commit', namespace: 'acme', basis: 'market-organization' }
        : { kind: 'pending', reason: 'awaiting-market-facts' },
      isNamespaceMigrationBusy: () => runtimeBusy,
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: (ghost) => {
        expect(ghost.approval.state).toBe('approved');
        runtimeBusy = true;
        events.push('started');
      },
      preparePendingResidentForMigration: async () => {
        events.push('stopped');
        runtimeBusy = false;
        return true;
      },
      beforeNamespaceCommit: () => events.push('stamped'),
      onNamespaceCommitted: () => events.push('restarted'),
    });
    manager.resumePendingResidentsOffline();
    await manager.reconcilePendingRootNamespaces(false);
    expect(events).toEqual(['started']);
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    await manager.reconcilePendingRootNamespaces(true);
    expect(events).toEqual(['started', 'stopped', 'stamped', 'restarted']);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
  });

  it('keeps a running offline resident pending when safe stop is deferred', async () => {
    await plantLegacyInstall('hello');
    const stopped = vi.fn(async () => false);
    const deferred = vi.fn();
    manager = new GhostManager({
      getRootDir: () => rootDir,
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      isNamespaceMigrationBusy: () => true,
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: vi.fn(),
      preparePendingResidentForMigration: stopped,
      onPendingResidentMigrationDeferred: deferred,
    });
    manager.resumePendingResidentsOffline();
    await manager.reconcilePendingRootNamespaces(true);
    expect(stopped).toHaveBeenCalledOnce();
    expect(deferred).toHaveBeenCalledWith('hello');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    expect(manager.list()[0]?.namespace).toBeUndefined();
  });

  it('retries after in-flight work finishes, then stops, stamps, and restarts the offline resident', async () => {
    await plantLegacyInstall('hello');
    vi.useFakeTimers();
    try {
      let inFlight = true;
      let runtimeBusy = false;
      let retry: Promise<void> | undefined;
      const events: string[] = [];
      const stop = vi.fn(async () => {
        if (inFlight) return false;
        runtimeBusy = false;
        events.push('stopped');
        return true;
      });
      manager = new GhostManager({
        getRootDir: () => rootDir,
        classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
        isNamespaceMigrationBusy: () => inFlight || runtimeBusy,
        canResumePendingResidentOffline: () => true,
        onResumePendingResidentOffline: () => { runtimeBusy = true; events.push('started'); },
        preparePendingResidentForMigration: stop,
        onPendingResidentMigrationDeferred: () => {
          setTimeout(() => { retry = manager.reconcilePendingRootNamespaces(true); }, 1000);
        },
        beforeNamespaceCommit: () => events.push('stamped'),
        onNamespaceCommitted: () => events.push('restarted'),
      });
      manager.resumePendingResidentsOffline();
      await manager.reconcilePendingRootNamespaces(true);
      expect(events).toEqual(['started']);
      expect(manager.list()[0]?.namespaceMigration).toBe('pending');
      inFlight = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(retry).toBeDefined();
      await retry;
      expect(stop).toHaveBeenCalledTimes(2);
      expect(events).toEqual(['started', 'stopped', 'stamped', 'restarted']);
      expect(manager.list()[0]?.namespace).toBe('acme');
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers a failed market namespace commit so the offline resident can retry', async () => {
    await plantLegacyInstall('hello');
    const deferred = vi.fn();
    let failStamp = true;
    manager = new GhostManager({
      getRootDir: () => rootDir,
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      preparePendingResidentForMigration: async () => true,
      onPendingResidentMigrationDeferred: deferred,
      beforeNamespaceCommit: () => {
        if (failStamp) throw new Error('market ledger unavailable');
      },
    });
    await expect(manager.reconcilePendingRootNamespaces(true)).rejects.toThrow('market ledger unavailable');
    expect(deferred).toHaveBeenCalledWith('hello');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    failStamp = false;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespace).toBe('acme');
  });

  it('abandons an offline migration if its owner changes during safe stop', async () => {
    await plantLegacyInstall('hello');
    let owner = 'original';
    let releaseStop: (() => void) | undefined;
    const stopping = new Promise<void>((resolve) => { releaseStop = resolve; });
    const committed = vi.fn();
    manager = new GhostManager({
      getRootDir: () => rootDir,
      getOwnerContextKey: () => owner,
      classifyPendingNamespace: () => ({ kind: 'commit', namespace: 'acme', basis: 'market-organization' }),
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: vi.fn(),
      preparePendingResidentForMigration: async () => { await stopping; return true; },
      onNamespaceCommitted: committed,
    });
    manager.resumePendingResidentsOffline();
    const migration = manager.reconcilePendingRootNamespaces(true);
    owner = 'replacement';
    releaseStop?.();
    await migration;
    expect(committed).not.toHaveBeenCalled();
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
  });

  it('does not publish a namespace commit when its owner changes while writing the receipt', async () => {
    await plantLegacyInstall('hello');
    let owner = 'original';
    let releaseWrite: (() => void) | undefined;
    let writeStarted: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => { writeStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const write = vi.spyOn(GhostInstallReceiptStore.prototype, 'write').mockImplementation(async () => {
      writeStarted?.();
      await blocked;
    });
    const committed = vi.fn();
    try {
      manager = new GhostManager({
        getRootDir: () => rootDir,
        getOwnerContextKey: () => owner,
        onNamespaceCommitted: committed,
      });
      manager.list();
      const migration = manager.commitPendingNamespace('hello', 'acme', 'market-organization');
      await writing;
      owner = 'replacement';
      releaseWrite?.();
      await expect(migration).rejects.toThrow('owner changed');
      expect(committed).not.toHaveBeenCalled();
      expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    } finally {
      write.mockRestore();
    }
  });

  it('stops offline residency when the market responds but the organization slug is not yet known', async () => {
    await plantLegacyInstall('hello');
    let slugKnown = false;
    let busy = false;
    const stopped = vi.fn(async () => { busy = false; return true; });
    manager = new GhostManager({
      getRootDir: () => rootDir,
      classifyPendingNamespace: () => slugKnown
        ? { kind: 'commit', namespace: 'acme', basis: 'market-organization' }
        : { kind: 'pending', reason: 'awaiting-organization-namespace' },
      isNamespaceMigrationBusy: () => busy,
      canResumePendingResidentOffline: () => true,
      onResumePendingResidentOffline: () => { busy = true; },
      preparePendingResidentForMigration: stopped,
    });
    manager.resumePendingResidentsOffline();
    await manager.reconcilePendingRootNamespaces(true);
    expect(stopped).toHaveBeenCalledOnce();
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    slugKnown = true;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]?.namespace).toBe('acme');
  });

  it('waits for a failed market read before committing an old organization install', async () => {
    await plantLegacyInstall('hello');
    let readFails = true;
    let commits = 0;
    manager = new GhostManager({
      getRootDir: () => rootDir,
      classifyPendingNamespace: (ghostId, marketSyncCompleted = false) => classifyNamespaceMigration({
        ghostId,
        builtin: false,
        installOrigin: 'manual',
        marketSyncCompleted,
        marketRecord: readNamespaceMigrationMarketRecord(() => {
          if (readFails) throw new Error('locked ledger');
          return [{ scope: 'organization', source: 'market', organizationId: 'org-acme' }];
        }),
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
      }),
      onNamespaceCommitted: () => { commits += 1; },
    });

    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespaceMigration: 'pending' });
    expect(manager.list()[0]?.namespace).toBeUndefined();
    expect(commits).toBe(0);

    readFails = false;
    await manager.reconcilePendingRootNamespaces(true);
    expect(manager.list()[0]).toMatchObject({ namespace: 'acme' });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
    expect(commits).toBe(1);
  });

  it('captures only verified recovered legacy installs after the initial empty census', async () => {
    await fs.promises.mkdir(rootDir, { recursive: true });
    expect(manager.list()).toEqual([]);
    await plantLegacyInstall('recovered');
    await plantLegacyInstall('unverified');
    expect(manager.list().find((ghost) => ghost.manifest.id === 'recovered')?.namespaceMigration).toBeUndefined();
    manager.captureRecoveredLegacyNamespace(['recovered']);
    expect(manager.list().find((ghost) => ghost.manifest.id === 'recovered')?.namespaceMigration).toBe('pending');
    expect(manager.list().find((ghost) => ghost.manifest.id === 'unverified')?.namespaceMigration).toBeUndefined();
    const orgCindy = await makeCindy('recovered');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
  });

  it('keeps a receipt-stamped namespace pending until its market record is stamped', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    let shouldFail = true;
    manager = new GhostManager({
      getRootDir: () => rootDir,
      mutateSnapshot: async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
      onNamespaceCommitted: () => {
        if (shouldFail) throw new Error('market ledger unavailable');
      },
    });
    await expect(manager.commitPendingNamespace('hello', 'acme', 'market-organization'))
      .rejects.toThrow('market ledger unavailable');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
    shouldFail = false;
    await expect(manager.commitPendingNamespace('hello', 'acme', 'market-organization'))
      .resolves.toEqual({ ok: true });
    expect(manager.list()[0]?.namespace).toBe('acme');
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
  });

  it('captures a pre-namespace root install as pending and does not treat a later install as pending', async () => {
    await plantLegacyInstall('xd-feishu');
    const listed = manager.list();
    expect(listed).toEqual([
      expect.objectContaining({
        manifest: expect.objectContaining({ id: 'xd-feishu' }),
        namespaceMigration: 'pending',
      }),
    ]);
    expect(listed[0]?.namespace).toBeUndefined();

    const planted = await makeCindy('helper');
    const installed = await manager.install(planted);
    expect('ghost' in installed).toBe(true);
    const helperGhost = (installed as { ghost: { manifest: { id: string }; namespace?: unknown } }).ghost;
    expect(helperGhost.manifest.id).toBe('helper');
    expect(Object.prototype.hasOwnProperty.call(helperGhost, 'namespace')).toBe(false);
    const helper = manager.list().find((ghost) => ghost.manifest.id === 'helper');
    expect(helper).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(helper, 'namespace')).toBe(false);
    expect(helper?.namespaceMigration).toBeUndefined();
  });

  it('commits a pending builtin-looking install as root without moving the directory', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await expect(manager.commitPendingRootNamespace('hello', 'builtin')).resolves.toEqual({ ok: true });
    const ghost = manager.list()[0];
    expect(ghost).toMatchObject({
      manifest: { id: 'hello' },
      namespace: null,
    });
    expect(ghost?.namespaceMigration).toBeUndefined();
    expect(ghost?.dir).toBe(path.join(rootDir, 'hello'));
  });

  it('lets a root reinstall proceed after uninstalling a pending legacy install', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await expect(manager.uninstall('hello', { notify: false })).resolves.toEqual({ ok: true });
    const cindy = await makeCindy('hello');
    await expect(manager.install(cindy)).resolves.toMatchObject({
      ghost: { manifest: { id: 'hello' } },
    });
  });

  it('keeps a pending census while the root directory is in an update backup', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    const live = path.join(rootDir, 'hello');
    const backup = path.join(rootDir, '.cindy-updating-hello-deadbeef');
    await fs.promises.rename(live, backup);
    manager.list();
    await fs.promises.rename(backup, live);
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
  });

  it('captures the original receipt when the first census sees an update backup', async () => {
    await plantLegacyInstall('hello');
    const receipts = new GhostInstallReceiptStore(() => path.join(workDir, 'ghosts-install-state'));
    const backupName = '.cindy-updating-hello-deadbeef';
    await receipts.writePendingMutation('hello', {
      kind: 'update',
      packageSha256: 'a'.repeat(64),
      backupDirName: backupName,
      phase: 'backed-up',
    });
    await fs.promises.rename(path.join(rootDir, 'hello'), path.join(rootDir, backupName));
    expect(manager.ensureNamespaceMigrationCensus()?.entries.hello?.status).toBe('pending');
    await fs.promises.rename(path.join(rootDir, backupName), path.join(rootDir, 'hello'));
    await receipts.clearPendingMutation('hello');
    expect(manager.list()[0]?.namespaceMigration).toBe('pending');
  });

  it('blocks a same-name organization install while the root instance is still pending', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'namespace-migration-pending' },
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('allows the organization instance after the pending root install is classified', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingRootNamespace('hello', 'market-public');
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      ghost: { namespace: 'acme', dir: path.join(rootDir, '_ns', 'acme', 'hello') },
    });
    expect(manager.list().map((ghost) => [ghost.namespace ?? null, ghost.manifest.id])).toEqual(
      expect.arrayContaining([
        [null, 'hello'],
        ['acme', 'hello'],
      ]),
    );
  });

  it('commits an organization namespace in place without moving the directory or storage key', async () => {
    await plantLegacyInstall('xd-feishu');
    manager.list();
    await expect(manager.commitPendingNamespace('xd-feishu', 'xd', 'market-organization')).resolves.toEqual({
      ok: true,
    });
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    const ghost = manager.list()[0];
    expect(ghost).toMatchObject({
      manifest: { id: 'xd-feishu' },
      namespace: 'xd',
      dir: path.join(rootDir, 'xd-feishu'),
    });
    expect(ghost?.namespaceMigration).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, '_ns', 'xd', 'xd-feishu'))).toBe(false);
    const { installedGhostStoragePart, installedGhostRuntimeId } = await import('../../../shared/pluginIdentity.js');
    expect(installedGhostStoragePart(ghost!)).toBe('xd-feishu');
    expect(installedGhostRuntimeId(ghost!)).toBe('xd-feishu');
  });

  it('finishes a receipt-first commit by removing the pending entry after a restart', async () => {
    await plantLegacyInstall('hello');
    expect(manager.ensureNamespaceMigrationCensus()?.entries.hello?.status).toBe('pending');
    const stateRoot = path.join(workDir, 'ghosts-install-state');
    const receipts = new GhostInstallReceiptStore(() => stateRoot, async ({ parentDir, ...request }) => {
      await runGhostSnapshotWorkerRequest(request, parentDir);
    });
    const approval = receipts.read('hello');
    if (approval.state !== 'approved') throw new Error('expected approved receipt');
    await receipts.write({ ...approval.receipt, namespace: 'xd' }, {
      relId: 'hello', skillSourceDir: path.join(rootDir, 'hello'), requireSkillSnapshot: false,
    });
    manager = new GhostManager({ getRootDir: () => rootDir, getStateDir: () => stateRoot });
    await expect(manager.commitPendingNamespace('hello', null, 'market-public')).resolves.toEqual({ ok: true });
    expect(manager.ensureNamespaceMigrationCensus()?.entries).toEqual({});
    manager = new GhostManager({ getRootDir: () => rootDir, getStateDir: () => stateRoot });
    expect(manager.list()[0]).toMatchObject({ namespace: 'xd', dir: path.join(rootDir, 'hello') });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
  });

  it('disables and uninstalls an in-place namespaced plugin without inventing _ns paths', async () => {
    await plantLegacyInstall('xd-feishu');
    manager.list();
    await expect(manager.commitPendingNamespace('xd-feishu', 'xd', 'market-organization')).resolves.toEqual({
      ok: true,
    });
    await expect(manager.setEnabled('_ns/xd/xd-feishu', false)).resolves.toEqual({ ok: true });
    expect(manager.list()[0]?.enabled).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'xd-feishu'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'xd', 'xd-feishu'))).toBe(false);
    await expect(manager.setEnabled('xd-feishu', true)).resolves.toEqual({ ok: true });
    expect(manager.list()[0]?.enabled).toBe(true);
    await expect(manager.uninstall('_ns/xd/xd-feishu', { notify: false })).resolves.toEqual({ ok: true });
    expect(fs.existsSync(path.join(rootDir, 'xd-feishu'))).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it('lets a root plugin occupy the original directory after an in-place namespaced stamp', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    const committed: string[] = [];
    manager = new GhostManager({
      getRootDir: () => rootDir,
      mutateSnapshot: async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
      onPhysicalRelocated: async () => undefined,
      onPhysicalRelocateCommitted: (toRelId) => {
        committed.push(toRelId);
        expect(manager.list()).toEqual([
          expect.objectContaining({ namespace: 'acme', dir: path.join(rootDir, '_ns', 'acme', 'hello') }),
        ]);
      },
    });
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({
      ghost: { manifest: { id: 'hello' }, dir: path.join(rootDir, 'hello') },
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello', 'ghost.json'))).toBe(true);
    expect(committed).toEqual(['_ns/acme/hello']);
    expect(manager.list().map((ghost) => [ghost.namespace ?? null, ghost.manifest.id, ghost.dir])).toEqual(
      expect.arrayContaining([
        ['acme', 'hello', path.join(rootDir, '_ns', 'acme', 'hello')],
        [null, 'hello', path.join(rootDir, 'hello')],
      ]),
    );
  });

  it('retains the relocation journal until interrupted user-data moves succeed', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    let calls = 0;
    manager = new GhostManager({
      getRootDir: () => rootDir,
      mutateSnapshot: async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
      onPhysicalRelocated: async () => {
        calls += 1;
        if (calls === 1) throw new Error('data move interrupted');
      },
    });
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({
      rejection: { code: 'io' },
    });
    const receipts = new GhostInstallReceiptStore(
      () => path.join(workDir, 'ghosts-install-state'),
      async () => undefined,
    );
    expect(calls).toBe(1);
    expect(receipts.readPendingMutationSync('hello').state).toBe('valid');
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(true);
    expect(manager.list().some((ghost) => ghost.approval.state === 'approved')).toBe(false);
    await expect(manager.install(rootCindy)).resolves.toMatchObject({ rejection: { code: 'io' } });
    expect(receipts.readPendingMutationSync('hello').state).toBe('valid');
    manager = new GhostManager({
      getRootDir: () => rootDir,
      mutateSnapshot: async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
      onPhysicalRelocated: async () => { calls += 1; },
    });
    await expect.poll(() => receipts.readPendingMutationSync('hello').state).toBe('missing');
    expect(calls).toBe(2);
    expect(manager.list()).toEqual([expect.objectContaining({ namespace: 'acme' })]);
  });

  it('retries user-data relocate when content already moved', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    const dest = path.join(rootDir, '_ns', 'acme', 'hello');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(path.join(rootDir, 'hello'), dest);
    const receipts = new GhostInstallReceiptStore(
      () => path.join(workDir, 'ghosts-install-state'),
      async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
    );
    const current = receipts.read('hello');
    expect(current.state).toBe('approved');
    if (current.state !== 'approved') return;
    await receipts.write(current.receipt, {
      relId: '_ns/acme/hello',
      requireSkillSnapshot: false,
      skillSourceDir: dest,
    });
    await receipts.remove('hello');
    await receipts.writePendingMutation('hello', {
      kind: 'relocate',
      fromRelId: 'hello',
      toRelId: '_ns/acme/hello',
    });
    let calls = 0;
    manager = new GhostManager({
      getRootDir: () => rootDir,
      mutateSnapshot: async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
      onPhysicalRelocated: async () => {
        calls += 1;
      },
    });
    await expect.poll(() => receipts.readPendingMutationSync('hello').state).toBe('missing');
    expect(calls).toBe(1);
    expect(manager.list()).toEqual([
      expect.objectContaining({ namespace: 'acme', dir: dest }),
    ]);
  });

  it('retries a failed startup relocation after the database becomes ready', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    const dest = path.join(rootDir, '_ns', 'acme', 'hello');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(path.join(rootDir, 'hello'), dest);
    const receipts = new GhostInstallReceiptStore(
      () => path.join(workDir, 'ghosts-install-state'),
      async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
    );
    const current = receipts.read('hello');
    expect(current.state).toBe('approved');
    if (current.state !== 'approved') return;
    await receipts.write(current.receipt, {
      relId: '_ns/acme/hello',
      requireSkillSnapshot: false,
      skillSourceDir: dest,
    });
    await receipts.remove('hello');
    await receipts.writePendingMutation('hello', {
      kind: 'relocate', fromRelId: 'hello', toRelId: '_ns/acme/hello',
    });
    let ready = false;
    let attempts = 0;
    manager = new GhostManager({
      getRootDir: () => rootDir,
      mutateSnapshot: async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
      onPhysicalRelocated: async () => {
        attempts += 1;
        if (!ready) throw new Error('DbClient not ready');
      },
    });
    await expect.poll(() => attempts).toBe(1);
    expect(receipts.readPendingMutationSync('hello').state).toBe('valid');
    ready = true;
    await manager.retryInterruptedMutationsAfterDbReady();
    expect(attempts).toBe(2);
    expect(receipts.readPendingMutationSync('hello').state).toBe('missing');
    expect(manager.list()).toEqual([expect.objectContaining({ namespace: 'acme', dir: dest })]);
  });

  it('stops the physical instance before renaming it out of the way', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    const seen: string[] = [];
    manager = new GhostManager({
      getRootDir: () => rootDir,
      mutateSnapshot: async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
      onBeforePhysicalRelocate: (fromRelId) => {
        seen.push(fromRelId);
        expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
        expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
      },
    });
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({
      ghost: { manifest: { id: 'hello' }, dir: path.join(rootDir, 'hello') },
    });
    expect(seen).toEqual(['hello']);
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello', 'ghost.json'))).toBe(true);
  });

  it('leaves the approved occupant usable when preflight finds conflicting user data', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    manager = new GhostManager({
      getRootDir: () => rootDir,
      mutateSnapshot: async ({ parentDir, ...request }) => {
        await runGhostSnapshotWorkerRequest(request, parentDir);
      },
      onValidatePhysicalRelocation: () => { throw new Error('relocate destination already exists'); },
    });
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({ rejection: { code: 'io' } });
    expect(fs.existsSync(path.join(rootDir, 'hello', 'ghost.json'))).toBe(true);
    expect(manager.list()).toEqual([expect.objectContaining({ approval: expect.objectContaining({ state: 'approved' }) })]);
    const receipts = new GhostInstallReceiptStore(
      () => path.join(workDir, 'ghosts-install-state'),
      async () => undefined,
    );
    expect(receipts.readPendingMutationSync('hello').state).toBe('missing');
  });

  it('installs and verifies a namespaced skill snapshot under its physical identity', async () => {
    const zip = new JSZip();
    zip.file('ghost.json', JSON.stringify({
      ...manifest('helper'),
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    }));
    zip.file('main.js', '// ok\n');
    zip.file('skills/demo/SKILL.md', '---\nname: demo\ndescription: Demo skill\n---\n\nDemo\n');
    const filePath = path.join(workDir, 'helper-skill.cindy');
    await fs.promises.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const result = await manager.install(filePath, { namespace: 'acme' });
    expect(result).toMatchObject({ ghost: { manifest: { id: 'helper' } } });
    if (!('ghost' in result)) return;
    expect(result.ghost.approvedSkillRoot).toContain(path.join('_ns', 'acme', 'helper'));
    await expect(manager.verifyApprovedSkillSnapshot(result.ghost)).resolves.toBe(true);
  });

  it('keeps a stamped skill approved after vacating for a same-name root install', async () => {
    await plantLegacyInstall('hello', true);
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({ ghost: { manifest: { id: 'hello' } } });
    const org = manager.list().find((ghost) => ghost.namespace === 'acme');
    expect(org).toBeDefined();
    await expect(manager.verifyApprovedSkillSnapshot(org!)).resolves.toBe(true);
  });

  it('treats a later install of the same organization identity as already installed', async () => {
    await plantLegacyInstall('hello');
    manager.list();
    await manager.commitPendingNamespace('hello', 'acme', 'market-organization');
    const orgCindy = await makeCindy('hello');
    await expect(manager.install(orgCindy, { namespace: 'acme' })).resolves.toMatchObject({
      rejection: { code: 'already-installed' },
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello'))).toBe(false);
  });

  it('recovers a half-written commit from the receipt instead of reclassifying', async () => {
    await plantLegacyInstall('xd-feishu');
    manager.list();
    const stateRoot = path.join(workDir, 'ghosts-install-state');
    const store = new GhostInstallReceiptStore(
      () => stateRoot,
      async ({ parentDir, targetName, operation }) => {
        if (operation === 'remove') {
          await fs.promises.rm(path.join(parentDir, targetName), { recursive: true, force: true });
        }
      },
    );
    const current = store.read('xd-feishu');
    expect(current.state).toBe('approved');
    if (current.state !== 'approved') return;
    await store.write(
      { ...current.receipt, namespace: 'xd' },
      { skillSourceDir: path.join(rootDir, 'xd-feishu'), requireSkillSnapshot: false, relId: 'xd-feishu' },
    );
    await expect(manager.commitPendingNamespace('xd-feishu', null, 'builtin')).resolves.toEqual({
      ok: true,
    });
    expect(manager.list()[0]).toMatchObject({
      manifest: { id: 'xd-feishu' },
      namespace: 'xd',
    });
    expect(manager.list()[0]?.namespaceMigration).toBeUndefined();
  });

  it('skips the first namespace stamp while the plugin is busy', async () => {
    await plantLegacyInstall('hello');
    const busyManager = new GhostManager({
      getRootDir: () => rootDir,
      isNamespaceMigrationBusy: () => true,
      mutateSnapshot: async (request) => {
        const { parentDir, ...workerRequest } = request;
        await runGhostSnapshotWorkerRequest(workerRequest, parentDir);
      },
    });
    busyManager.list();
    await expect(busyManager.commitPendingNamespace('hello', null, 'builtin')).resolves.toEqual({
      ok: false,
      reason: 'busy',
    });
    expect(busyManager.list()[0]?.namespaceMigration).toBe('pending');
  });


});
