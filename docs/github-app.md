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
- **Callback URL**: `https://<api-host>/github/callback`
- **Request user authorization (OAuth) during installation**: enable it.
- **Expire user authorization tokens**: leave enabled (tokens are used once and never stored).
- **Where can this App be installed**: any account (students install it on their own repositories).

After creating it, note the **App ID**, the **Client ID**, generate a **client secret** and a **private key** (a `.pem` file).

## 2. Configure the API

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | the numeric App ID |
| `GITHUB_APP_PRIVATE_KEY` | the PEM contents (literal `\n` sequences are accepted for single-line env files) |
| `GITHUB_WEBHOOK_SECRET` | the webhook secret from step 1 |
| `GITHUB_CLIENT_ID` | the App's client ID |
| `GITHUB_CLIENT_SECRET` | the App's client secret |

The GitHub routes are registered only when all five are set.

## 3. Connect a site

A student installs the App on their repository, then proves they control the installation: the signed-in user
opens `GET /github/connect`, which redirects to GitHub's user authorization (state is a one-time nonce bound to the
session, valid 10 minutes, stored hashed). GitHub returns to `/github/callback`; the API exchanges the code, lists
`GET /user/installations` and records those installations as links for the account (`github_installation_links`).
Then:

```
PATCH /apps/:id/github
{ "repo": "owner/name", "branch": "main", "installationId": "12345" }
```

The caller needs the `deploy` permission for the app's owner and must have a link for that installation (for team
apps, the acting member's own link). Connecting someone else's installation is `403`. The API also asks GitHub that
the installation exists for this App and can read the repository.

## How a push is handled

1. Bodies over 25MB are rejected (`413`). The signature (`X-Hub-Signature-256`) is verified against the raw body. Missing or wrong: `401`. A repeated `X-GitHub-Delivery` id is ignored (ids are kept 7 days, purged by `admin:purge`), as is a commit already queued, processing or live for the app.
2. Only `push` events matter. Deleted-branch pushes, other branches, and repositories/installations no app is
   connected to are ignored (`200`).
3. For every connected app the API first records a queued `github` deployment with the commit SHA, then downloads `GET /repos/{owner}/{repo}/tarball/{sha}` with an installation token,
   stores it and queues it (120s download timeout; a failed or oversized download marks the deployment `failed`). It answers `202` without waiting.
4. The worker removes the top-level `<owner>-<repo>-<sha>/` folder, applies the app's publish directory, scans and
   publishes like any other deployment.

## Limitation

`/user/installations` lists every installation the user can access, including organisation installations where
they are only a member; the per-app `deploy` permission and the repo check still apply.
