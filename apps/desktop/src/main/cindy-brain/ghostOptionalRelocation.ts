import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isGhostInstanceId } from '../../shared/pluginIdentity.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

interface PendingRelocation {
  fromId: string;
  toId: string;
  ready: boolean;
}

function markerPath(fromId: string): string {
  if (!isGhostInstanceId(fromId)) throw new Error('Invalid plugin identity');
  return ownerScopedUserDataPath('ghost-optional-relocations', fromId + '.json');
}

function readMarker(file: string): PendingRelocation {
  const marker: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!marker || typeof marker !== 'object') throw new Error('Invalid optional relocation marker');
  const { fromId, toId, ready } = marker as PendingRelocation;
  if (
    !isGhostInstanceId(fromId) ||
    !isGhostInstanceId(toId) ||
    typeof ready !== 'boolean' ||
    path.basename(file) !== fromId + '.json'
  ) {
    throw new Error('Invalid optional relocation marker');
  }
  return { fromId, toId, ready };
}

function writeMarker(marker: PendingRelocation): void {
  const file = markerPath(marker.fromId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function isGhostOptionalRelocationSource(id: string): boolean {
  if (!isGhostInstanceId(id)) return false;
  try {
    fs.lstatSync(markerPath(id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function prepareGhostOptionalRelocation(fromId: string, toId: string): void {
  const file = markerPath(fromId);
  if (fs.existsSync(file)) {
    if (readMarker(file).toId !== toId) throw new Error('Conflicting optional relocation');
    return;
  }
  writeMarker({ fromId, toId, ready: false });
}

export function readyGhostOptionalRelocation(fromId: string, toId: string): void {
  const marker = readMarker(markerPath(fromId));
  if (marker.toId !== toId) throw new Error('Conflicting optional relocation');
  if (!marker.ready) writeMarker({ ...marker, ready: true });
}

export function retryGhostOptionalRelocations(
  relocate: (fromId: string, toId: string) => void,
  onError: (error: unknown, fromId: string) => void,
): void {
  const directory = ownerScopedUserDataPath('ghost-optional-relocations');
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory).filter((file) => file.endsWith('.json'))) {
    let marker: PendingRelocation;
    try {
      marker = readMarker(path.join(directory, name));
    } catch (error) {
      onError(error, name.slice(0, -'.json'.length));
      continue;
    }
    if (!marker.ready) continue;
    try {
      relocate(marker.fromId, marker.toId);
      fs.unlinkSync(markerPath(marker.fromId));
    } catch (error) {
      onError(error, marker.fromId);
    }
  }
}
