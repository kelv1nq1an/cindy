import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost.js';
import { GhostManager } from '../GhostManager.js';
import {
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

async function plantLegacyInstall(id: string, withSkill = false): Promise<void> {
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
    const rootCindy = await makeCindy('hello');
    await expect(manager.install(rootCindy)).resolves.toMatchObject({
      ghost: { manifest: { id: 'hello' }, dir: path.join(rootDir, 'hello') },
    });
    expect(fs.existsSync(path.join(rootDir, '_ns', 'acme', 'hello', 'ghost.json'))).toBe(true);
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
