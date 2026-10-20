import { createAdminShell } from './server.js';

// 127.0.0.1 only: reached through `tailscale serve` (e.g. `tailscale serve --https=443 /admin http://127.0.0.1:3002`
// for the API and `tailscale serve --https=443 / http://127.0.0.1:5175` for this shell).
const port = Number(process.env.ADMIN_UI_PORT ?? 5175);
createAdminShell().listen(port, process.env.ADMIN_UI_HOST ?? '127.0.0.1', () => console.log(`admin ui listening on :${port}`));
