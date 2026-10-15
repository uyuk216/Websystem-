import { Readable } from 'node:stream';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

/** The GitHub calls the platform makes. Tests inject a fake; production uses createGithubClient. */
export interface GithubClient {
  /** True when the installation exists for this App and can read `repo` ("owner/name"). */
  verifyInstallation(installationId: string, repo: string): Promise<boolean>;
  /** Streams the repository tarball (tar.gz) at `sha`, authenticated with an installation token. */
  downloadTarball(installationId: string, repo: string, sha: string): Promise<Readable>;
}

export interface GithubAppConfig {
  appId: string;
  /** PEM private key. */
  privateKey: string;
}

const splitRepo = (repo: string): { owner: string; repo: string } => {
  const [owner = '', name = ''] = repo.split('/');
  return { owner, repo: name };
};

export function createGithubClient(cfg: GithubAppConfig): GithubClient {
  const appOctokit = () => new Octokit({ authStrategy: createAppAuth, auth: { appId: cfg.appId, privateKey: cfg.privateKey } });
  const installationOctokit = (installationId: string) => new Octokit({
    authStrategy: createAppAuth, auth: { appId: cfg.appId, privateKey: cfg.privateKey, installationId: Number(installationId) },
  });
  return {
    async verifyInstallation(installationId, repo) {
      try {
        await appOctokit().request('GET /app/installations/{installation_id}', { installation_id: Number(installationId) });
        await installationOctokit(installationId).request('GET /repos/{owner}/{repo}', splitRepo(repo));
        return true;
      } catch {
        return false;
      }
    },
    async downloadTarball(installationId, repo, sha) {
      const res = await installationOctokit(installationId).request('GET /repos/{owner}/{repo}/tarball/{ref}', {
        ...splitRepo(repo), ref: sha, request: { parseSuccessResponseBody: false },
      });
      const body = res.data as unknown;
      if (body instanceof ReadableStream) return Readable.fromWeb(body as never);
      if (body && typeof (body as Readable).pipe === 'function') return body as Readable;
      throw new Error('github tarball: unexpected response body');
    },
  };
}
