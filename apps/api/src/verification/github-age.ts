/** GitHub アカウントの作成日の確認（Starter Grant の不正対策）。テストは偽物を注入し、本物は api.github.com の公開 API を読むだけ。 */
export interface GithubAccountLookup {
  /** そのユーザー名の GitHub アカウントの作成日。存在しなければ null。 */
  createdAt(login: string): Promise<Date | null>;
}

export function createGithubAccountLookup(fetchImpl: typeof fetch = fetch): GithubAccountLookup {
  return {
    async createdAt(login) {
      const res = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'platform-starter-check' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`github user lookup failed: ${res.status}`);
      const created = (await res.json() as { created_at?: unknown }).created_at;
      const d = typeof created === 'string' ? new Date(created) : null;
      return d && !Number.isNaN(d.getTime()) ? d : null;
    },
  };
}

export const githubAgeDays = (createdAt: Date, now: Date): number => Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000);
