# GitHub App setup (deploy on push)

The API deploys a static site whenever its connected branch is pushed. This needs one GitHub App owned by the
platform operator. If the three environment variables below are not set, the GitHub routes are not registered.

## 1. Create the App

GitHub > Settings > Developer settings > GitHub Apps > New GitHub App.

- **Webhook URL**: `https://<api-host>/github/webhook`
- **Webhook secret**: a long random string (`openssl rand -hex 32`). Keep it for `GITHUB_WEBHOOK_SECRET`.
- **Repository permissions**:
  - Contents: **Read-only**
  - Metadata: **Read-only**
  - (nothing else)
- **Subscribe to events**: **Push** only.
- **Where can this App be installed**: any account (students install it on their own repositories).

After creating it, note the **App ID** and generate a **private key** (a `.pem` file).

## 2. Configure the API

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | the numeric App ID |
| `GITHUB_APP_PRIVATE_KEY` | the PEM contents (literal `\n` sequences are accepted for single-line env files) |
| `GITHUB_WEBHOOK_SECRET` | the webhook secret from step 1 |

## 3. Connect a site

A student installs the App on their repository and notes the installation ID (the number in
`https://github.com/settings/installations/<id>`). Then:

```
PATCH /apps/:id/github
{ "repo": "owner/name", "branch": "main", "installationId": "12345" }
```

The caller needs the `deploy` permission for the app's owner. The API asks GitHub that the installation exists
for this App and can read the repository before saving.

## How a push is handled

1. The signature (`X-Hub-Signature-256`) is verified against the raw body. Missing or wrong: `401`.
2. Only `push` events matter. Deleted-branch pushes, other branches, and repositories/installations no app is
   connected to are ignored (`200`).
3. For every connected app the API downloads `GET /repos/{owner}/{repo}/tarball/{sha}` with an installation token,
   stores it as a `github` deployment with the commit SHA and queues it. It answers `202` without waiting.
4. The worker removes the top-level `<owner>-<repo>-<sha>/` folder, applies the app's publish directory, scans and
   publishes like any other deployment.

## Known limitation (Phase 2)

The installation ID is checked only against GitHub, not against the identity of the person connecting the app.
Someone who knows another account's installation ID and repository name could connect a site to it. Binding
installations to the connecting user (GitHub OAuth) is future work; until then, treat repository contents reachable
by the App as publishable by any platform user who can guess the installation ID and repo.
