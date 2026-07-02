import { logger, scm } from '~test/util.ts';
import { GlobalConfig } from '../../../../config/global.ts';
import { getLocalBaselineDirtyFiles as _getLocalBaselineDirtyFiles } from '../../../../modules/platform/local/scm.ts';
import type { LongCommitSha } from '../../../../util/schema-utils/git.ts';
import type { BranchConfig } from '../../../types.ts';
import { commitFilesToBranch } from './commit.ts';

vi.mock('../../../../modules/platform/local/scm.ts', () => ({
  getLocalBaselineDirtyFiles: vi.fn().mockReturnValue(new Set()),
}));
const getLocalBaselineDirtyFiles = vi.mocked(_getLocalBaselineDirtyFiles);

describe('workers/repository/update/branch/commit', () => {
  describe('commitFilesToBranch', () => {
    let config: BranchConfig;

    beforeEach(() => {
      config = {
        baseBranch: 'base-branch',
        manager: 'some-manager',
        branchName: 'renovate/some-branch',
        commitMessage: 'some commit message',
        semanticCommits: 'disabled',
        semanticCommitType: 'a',
        semanticCommitScope: 'b',
        updatedPackageFiles: [],
        updatedArtifacts: [],
        upgrades: [],
        platformCommit: 'auto',
      } satisfies BranchConfig;
      scm.commitAndPush.mockResolvedValueOnce('123test' as LongCommitSha);
      getLocalBaselineDirtyFiles.mockReturnValue(new Set());
      GlobalConfig.reset();
    });

    it('handles empty files', async () => {
      await commitFilesToBranch(config);
      expect(scm.commitAndPush).toHaveBeenCalledTimes(0);
    });

    it('commits files', async () => {
      config.updatedPackageFiles?.push({
        type: 'addition',
        path: 'package.json',
        contents: 'some contents',
      });
      await commitFilesToBranch(config);
      expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
      expect(scm.commitAndPush.mock.calls).toEqual([
        [
          {
            baseBranch: 'base-branch',
            branchName: 'renovate/some-branch',
            files: [
              {
                contents: 'some contents',
                path: 'package.json',
                type: 'addition',
              },
            ],
            force: false,
            message: 'some commit message',
            platformCommit: 'auto',
          },
        ],
      ]);
    });

    it('dry runs', async () => {
      GlobalConfig.set({ dryRun: 'full' });
      config.updatedPackageFiles?.push({
        type: 'addition',
        path: 'package.json',
        contents: 'some contents',
      });
      await commitFilesToBranch(config);
      expect(scm.commitAndPush).toHaveBeenCalledTimes(0);
      expect(logger.logger.info).toHaveBeenCalledWith(
        'DRY-RUN: Would commit files to branch renovate/some-branch. See debug logs for raw commit information',
      );
    });

    it('dry runs with a deletion', async () => {
      GlobalConfig.set({ dryRun: 'full' });
      config.updatedPackageFiles?.push({
        type: 'deletion',
        path: 'package.json',
      });
      await commitFilesToBranch(config);
      expect(scm.commitAndPush).toHaveBeenCalledTimes(0);
      expect(logger.logger.info).toHaveBeenCalledWith(
        'DRY-RUN: Would commit files to branch renovate/some-branch. See debug logs for raw commit information',
      );
    });

    describe('local platform apply mode', () => {
      beforeEach(() => {
        GlobalConfig.set({ dryRun: 'full', platform: 'local' });
        config.updatedPackageFiles?.push({
          type: 'addition',
          path: 'package.json',
          contents: 'some contents',
        });
      });

      it('commits via scm.commitAndPush instead of dry-run logging', async () => {
        await commitFilesToBranch(config);
        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.info).toHaveBeenCalledWith(
          'Committing 1 file(s) to local branch renovate/some-branch',
        );
        expect(logger.logger.info).not.toHaveBeenCalledWith(
          expect.stringContaining('DRY-RUN'),
        );
      });

      it('throws when a source file has pre-existing uncommitted changes', () => {
        getLocalBaselineDirtyFiles.mockReturnValue(new Set(['package.json']));
        expect(() => commitFilesToBranch(config)).toThrow(
          'Cannot create local commit: source file(s) package.json have uncommitted changes; commit or stash them first',
        );
        expect(scm.commitAndPush).toHaveBeenCalledTimes(0);
      });

      it('commits and warns when only an artifact has pre-existing uncommitted changes', async () => {
        config.updatedArtifacts?.push({
          type: 'addition',
          path: 'package-lock.json',
          contents: 'some lockfile contents',
        });
        getLocalBaselineDirtyFiles.mockReturnValue(
          new Set(['package-lock.json']),
        );

        await commitFilesToBranch(config);

        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.warn).toHaveBeenCalledWith(
          { files: ['package-lock.json'] },
          'local: overwriting uncommitted lock file/artifact changes with regenerated content',
        );
      });

      it('commits cleanly when there is no dirty-file overlap', async () => {
        getLocalBaselineDirtyFiles.mockReturnValue(
          new Set(['unrelated-file.txt']),
        );
        await commitFilesToBranch(config);
        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.warn).not.toHaveBeenCalled();
      });

      it('does not flag a dirty deletion as an overlap', async () => {
        config.updatedPackageFiles?.push({
          type: 'deletion',
          path: 'old-file.json',
        });
        getLocalBaselineDirtyFiles.mockReturnValue(new Set(['old-file.json']));
        await commitFilesToBranch(config);
        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.warn).not.toHaveBeenCalled();
      });

      it('does not flag a dirty file excluded via excludeCommitPaths', async () => {
        config.updatedPackageFiles?.push({
          type: 'addition',
          path: 'other.json',
          contents: 'other contents',
        });
        config.excludeCommitPaths = ['package.json'];
        getLocalBaselineDirtyFiles.mockReturnValue(new Set(['package.json']));
        await commitFilesToBranch(config);
        expect(scm.commitAndPush).toHaveBeenCalledTimes(1);
        expect(logger.logger.warn).not.toHaveBeenCalled();
      });
    });
  });
});
