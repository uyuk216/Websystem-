import { Readable } from 'node:stream';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

/** The GitHub calls the platform makes. Tests inject a fake; production uses createGithubClient. */
export interface GithubClient {
  /** True when the installation exists for this App and can read `repo` ("owner/name"). */
  verifyInstallation(installationId: string, repo: string): Promise<boolean>;
  /** Streams the repository tarball (tar.gz) at `sha`, authenticated with an installation token. */
  downloadTarball(installationId: string, repo: string, sha: string): Promise<Readable>;
  /** GitHub OAuth authorize URL for the user-authorization flow. */
  authorizeUrl(state: string): string;
  /** Exchanges an OAuth code and returns the ids of the installations the user can access (GET /user/installations). */
  userInstallations(code: string): Promise<string[]>;
}

export interface GithubAppConfig {
  appId: string;
  /** PEM private key. */
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

const TARBALL_TIMEOUT_MS = 120_000;

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
    authorizeUrl(state) {
      return `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: cfg.clientId, state })}`;
    },
    async userInstallations(code) {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code }),
        signal: AbortSignal.timeout(15_000),
      });
      const token = (await res.json() as { access_token?: unknown }).access_token;
      if (!res.ok || typeof token !== 'string') throw new Error('github oauth exchange failed');
      const octokit = new Octokit({ auth: token });
      const items = await octokit.paginate('GET /user/installations', { per_page: 100 });
      return items.map((i) => String((i as { id: number }).id));
    },
    async downloadTarball(installationId, repo, sha) {
      const res = await installationOctokit(installationId).request('GET /repos/{owner}/{repo}/tarball/{ref}', {
        ...splitRepo(repo), ref: sha, request: { parseSuccessResponseBody: false, signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) },
      });
      const body = res.data as unknown;
      if (body instanceof ReadableStream) return Readable.fromWeb(body as never);
      if (body && typeof (body as Readable).pipe === 'function') return body as Readable;
      throw new Error('github tarball: unexpected response body');
    },
  };
}
