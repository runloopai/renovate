import fs from 'fs-extra';
import { simpleGit } from 'simple-git';
import tmp from 'tmp-promise';
import { partial } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import { rawExec as _rawExec } from '../../../util/exec/common.ts';
import type { ExecResult } from '../../../util/exec/types.ts';
import type { CommitFilesConfig } from '../../../util/git/types.ts';
import {
  LocalFs,
  captureLocalBaselineDirtyFiles,
  getLocalBaselineDirtyFiles,
} from './scm.ts';

vi.mock('glob', () => ({
  glob: vi.fn().mockImplementation(() => Promise.resolve(['file1', 'file2'])),
}));
vi.mock('../../../util/exec/common.ts');
vi.unmock('../../../util/git/index.ts');
const execSync = vi.mocked(_rawExec);

describe('modules/platform/local/scm', () => {
  let localFs: LocalFs;

  beforeEach(() => {
    localFs = new LocalFs();
  });

  afterEach(() => {
    GlobalConfig.reset();
  });

  describe('dummy functions', () => {
    it('behindBaseBranch', async () => {
      expect(await localFs.isBranchBehindBase('', '')).toBe(false);
    });

    it('isBranchModified', async () => {
      expect(await localFs.isBranchModified('', '')).toBe(false);
    });

    it('isBranchConflicted', async () => {
      expect(await localFs.isBranchConflicted('', '')).toBe(false);
    });

    it('branchExists', async () => {
      expect(await localFs.branchExists('')).toBe(false);
    });

    it('getBranchCommit', async () => {
      expect(await localFs.getBranchCommit('')).toBeNull();
    });

    it('getBranchUpdateDate', async () => {
      expect(await localFs.getBranchUpdateDate('')).toBeNull();
    });

    it('deleteBranch', async () => {
      expect(await localFs.deleteBranch('')).toBeUndefined();
    });

    it('checkoutBranch', async () => {
      expect(await localFs.checkoutBranch('')).toBeNull();
    });
  });

  describe('getFileList', () => {
    it('should return file list using git', async () => {
      execSync.mockReturnValueOnce(
        Promise.resolve(
          partial<ExecResult>({
            stdout: 'file1\nfile2',
          }),
        ),
      );
      expect(await localFs.getFileList()).toHaveLength(2);

      expect(execSync).toHaveBeenCalledExactlyOnceWith('git ls-files', {
        maxBuffer: 1024 * 1024 * 10,
      });
    });

    it('should return file list using glob', async () => {
      execSync.mockImplementationOnce(() => {
        throw new Error();
      });

      expect(await localFs.getFileList()).toHaveLength(2);
    });
  });

  it('mergeAndPush', async () => {
    await expect(localFs.mergeAndPush('branchName')).resolves.toBeUndefined();
  });

  it('mergeBranch', async () => {
    await expect(localFs.mergeToLocal('branchName')).resolves.toBeUndefined();
  });

  describe('getLocalBaselineDirtyFiles', () => {
    it('returns an empty set before capture has run', async () => {
      vi.resetModules();
      const scm = await import('./scm.ts');
      expect(scm.getLocalBaselineDirtyFiles()).toEqual(new Set());
    });
  });

  describe('captureLocalBaselineDirtyFiles / commitAndPush against a real repo', () => {
    let repoDir: tmp.DirectoryResult;

    beforeEach(async () => {
      repoDir = await tmp.dir({ unsafeCleanup: true });
      const repo = simpleGit(repoDir.path);
      await repo.init();
      await repo.addConfig('user.email', 'Jest@example.com');
      await repo.addConfig('user.name', 'Jest');
      await repo.addConfig('commit.gpgsign', 'false');
      await fs.writeFile(`${repoDir.path}/committed.txt`, 'committed\n');
      await repo.add(['committed.txt']);
      await repo.commit('initial commit');
      GlobalConfig.set({ localDir: repoDir.path });
    });

    afterEach(async () => {
      await repoDir.cleanup();
    });

    it('captures modified, untracked and deleted paths', async () => {
      const repo = simpleGit(repoDir.path);
      await fs.writeFile(`${repoDir.path}/to-delete.txt`, 'bye\n');
      await repo.add(['to-delete.txt']);
      await repo.commit('add file to delete');

      await fs.writeFile(`${repoDir.path}/committed.txt`, 'changed\n');
      await fs.writeFile(`${repoDir.path}/untracked.txt`, 'new\n');
      await fs.remove(`${repoDir.path}/to-delete.txt`);

      await captureLocalBaselineDirtyFiles();

      expect(getLocalBaselineDirtyFiles()).toEqual(
        new Set(['committed.txt', 'untracked.txt', 'to-delete.txt']),
      );
    });

    it('stores an empty set and does not throw when git status fails', async () => {
      GlobalConfig.set({ localDir: `${repoDir.path}/does-not-exist` });

      await expect(captureLocalBaselineDirtyFiles()).toResolve();

      expect(getLocalBaselineDirtyFiles()).toEqual(new Set());
    });

    describe('commitAndPush', () => {
      it('writes additions, commits and returns the sha', async () => {
        const commitConfig = partial<CommitFilesConfig>({
          branchName: 'main',
          message: 'bump dependency',
          files: [
            {
              type: 'addition',
              path: 'updated.txt',
              contents: 'new content\n',
            },
          ],
        });

        const sha = await localFs.commitAndPush(commitConfig);

        expect(sha).not.toBeNull();
        expect(await fs.readFile(`${repoDir.path}/updated.txt`, 'utf8')).toBe(
          'new content\n',
        );
        const log = await simpleGit(repoDir.path).log();
        expect(log.latest?.message).toBe('bump dependency');
        expect(log.latest?.hash).toBe(sha);
        const status = await simpleGit(repoDir.path).status();
        expect(status.isClean()).toBe(true);
      });

      it('returns null and creates no commit when staged content is unchanged', async () => {
        const beforeLog = await simpleGit(repoDir.path).log();

        const commitConfig = partial<CommitFilesConfig>({
          branchName: 'main',
          message: 'no-op bump',
          files: [
            {
              type: 'addition',
              path: 'committed.txt',
              contents: 'committed\n',
            },
          ],
        });

        const sha = await localFs.commitAndPush(commitConfig);

        expect(sha).toBeNull();
        const afterLog = await simpleGit(repoDir.path).log();
        expect(afterLog.latest?.hash).toBe(beforeLog.latest?.hash);
      });

      it('marks additions executable when requested', async () => {
        const commitConfig = partial<CommitFilesConfig>({
          branchName: 'main',
          message: 'add script',
          files: [
            {
              type: 'addition',
              path: 'script.sh',
              contents: '#!/bin/sh\necho hi\n',
              isExecutable: true,
            },
          ],
        });

        const sha = await localFs.commitAndPush(commitConfig);

        expect(sha).not.toBeNull();
        const lsFiles = await simpleGit(repoDir.path).raw([
          'ls-files',
          '--stage',
          'script.sh',
        ]);
        expect(lsFiles).toStartWith('100755');
      });

      it('treats null contents as an empty file', async () => {
        const commitConfig = partial<CommitFilesConfig>({
          branchName: 'main',
          message: 'add empty file',
          files: [
            {
              type: 'addition',
              path: 'empty.txt',
              contents: null,
            },
          ],
        });

        const sha = await localFs.commitAndPush(commitConfig);

        expect(sha).not.toBeNull();
        expect(await fs.readFile(`${repoDir.path}/empty.txt`, 'utf8')).toBe('');
      });

      it('deletes files via git rm', async () => {
        const commitConfig = partial<CommitFilesConfig>({
          branchName: 'main',
          message: 'remove dependency',
          files: [{ type: 'deletion', path: 'committed.txt' }],
        });

        const sha = await localFs.commitAndPush(commitConfig);

        expect(sha).not.toBeNull();
        expect(await fs.pathExists(`${repoDir.path}/committed.txt`)).toBe(
          false,
        );
      });

      it('skips symlinks and does not commit them', async () => {
        const commitConfig = partial<CommitFilesConfig>({
          branchName: 'main',
          message: 'add symlink',
          files: [
            {
              type: 'addition',
              path: 'link.txt',
              contents: 'ignored',
              isSymlink: true,
            },
          ],
        });

        const sha = await localFs.commitAndPush(commitConfig);

        expect(sha).toBeNull();
        expect(await fs.pathExists(`${repoDir.path}/link.txt`)).toBe(false);
      });

      it('returns null when there is nothing to commit', async () => {
        const commitConfig = partial<CommitFilesConfig>({
          branchName: 'main',
          message: 'no-op',
          files: [],
        });

        expect(await localFs.commitAndPush(commitConfig)).toBeNull();
      });

      it('returns null and leaves the write in place when the directory is not a git repo', async () => {
        const plainDir = await tmp.dir({ unsafeCleanup: true });
        try {
          GlobalConfig.set({ localDir: plainDir.path });
          const commitConfig = partial<CommitFilesConfig>({
            branchName: 'main',
            message: 'bump dependency',
            files: [
              { type: 'addition', path: 'updated.txt', contents: 'new\n' },
            ],
          });

          expect(await localFs.commitAndPush(commitConfig)).toBeNull();
          expect(
            await fs.readFile(`${plainDir.path}/updated.txt`, 'utf8'),
          ).toBe('new\n');
        } finally {
          await plainDir.cleanup();
        }
      });

      it('only stages the given paths, leaving unrelated dirty files uncommitted', async () => {
        await fs.writeFile(`${repoDir.path}/committed.txt`, 'dirty edit\n');

        const commitConfig = partial<CommitFilesConfig>({
          branchName: 'main',
          message: 'bump other dependency',
          files: [
            {
              type: 'addition',
              path: 'other.txt',
              contents: 'new content\n',
            },
          ],
        });

        const sha = await localFs.commitAndPush(commitConfig);

        expect(sha).not.toBeNull();
        const status = await simpleGit(repoDir.path).status();
        expect(status.modified).toEqual(['committed.txt']);
        expect(status.not_added).toEqual([]);
      });
    });
  });
});
