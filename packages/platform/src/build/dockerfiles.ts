/** Generated Dockerfiles. Pinned small official bases; every one ends up running as a non-root user. */
export const NODE_IMAGE = 'node:22-alpine';
export const PYTHON_IMAGE = 'python:3.12-alpine';
export const PHP_IMAGE = 'php:8.3-apache';

export const DEFAULT_PORT = 8080;

export function nodeDockerfile(opts: { hasLockfile: boolean }): string {
  return `FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=${DEFAULT_PORT}
WORKDIR /app
COPY package*.json ./
RUN ${opts.hasLockfile ? 'npm ci --omit=dev' : 'npm install --omit=dev'}
COPY . .
USER node
EXPOSE ${DEFAULT_PORT}
CMD ["npm","start"]
`;
}

export type PythonServer = 'gunicorn' | 'uvicorn';

export function pythonDockerfile(opts: { server: PythonServer; module: 'app' | 'main' }): string {
  const run = opts.server === 'uvicorn'
    ? `exec uvicorn ${opts.module}:app --host 0.0.0.0 --port \${PORT}`
    : `exec gunicorn --bind 0.0.0.0:\${PORT} ${opts.module}:app`;
  return `FROM ${PYTHON_IMAGE}
ENV PORT=${DEFAULT_PORT} PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt ${opts.server === 'uvicorn' ? 'uvicorn' : 'gunicorn'}
COPY . .
RUN adduser -D -u 10001 app
USER app
EXPOSE ${DEFAULT_PORT}
CMD ["sh","-c","${run}"]
`;
}

export function phpDockerfile(): string {
  // Apache expands \${PORT} from the environment at start, so the port is chosen at run time (default 8080).
  // Runtime state (pid, lock, run dir) lives under /tmp because the root filesystem is read-only at run time.
  return `FROM ${PHP_IMAGE}
ARG PORT=${DEFAULT_PORT}
ENV PORT=\${PORT} APACHE_RUN_DIR=/tmp/apache2/run APACHE_LOCK_DIR=/tmp/apache2/lock APACHE_PID_FILE=/tmp/apache2/apache2.pid
RUN sed -ri 's/^Listen .*/Listen \${PORT}/' /etc/apache2/ports.conf \\
 && sed -ri 's/<VirtualHost \\*:[0-9]+>/<VirtualHost *:\${PORT}>/' /etc/apache2/sites-available/000-default.conf
COPY . /var/www/html/
USER www-data
EXPOSE ${DEFAULT_PORT}
CMD ["sh","-c","mkdir -p /tmp/apache2/run /tmp/apache2/lock && exec apache2-foreground"]
`;
}
