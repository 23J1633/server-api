import fs from 'node:fs';

export function replaceFileSyncPortable(source, target) {
  try {
    fs.renameSync(source, target);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }

  const backup = `${target}.${process.pid}.${process.hrtime.bigint()}.bak`;
  let hasBackup = false;
  try {
    try {
      fs.copyFileSync(target, backup);
      hasBackup = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    try {
      fs.copyFileSync(source, target);
      syncFile(target);
    } catch (error) {
      if (hasBackup) {
        fs.copyFileSync(backup, target);
        syncFile(target);
      } else {
        try { fs.rmSync(target, { force: true }); } catch { /* Best effort cleanup. */ }
      }
      throw error;
    }
  } finally {
    try { fs.rmSync(source, { force: true }); } catch { /* Best effort cleanup. */ }
    if (hasBackup) {
      try { fs.rmSync(backup, { force: true }); } catch { /* Best effort cleanup. */ }
    }
  }
}

function syncFile(file) {
  const descriptor = fs.openSync(file, 'r+');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
