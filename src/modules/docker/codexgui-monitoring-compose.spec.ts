import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (src: string) => unknown };

interface Service {
  image?: string;
  ports?: unknown;
  expose?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  volumes?: string[];
  networks?: Record<string, { aliases?: string[] }>;
  environment?: unknown;
  env_file?: string[];
  extra_hosts?: string[];
  healthcheck?: unknown;
}

describe('codexgui monitoring Compose overlay', () => {
  const path = join(__dirname, '../../../deploy/codexgui/compose.yaml');
  const raw = readFileSync(path, 'utf8');
  const compose = yaml.load(raw) as { services: Record<string, Service>; networks: Record<string, unknown> };
  const service = compose.services['openwa-monitor'];
  const systemd = readFileSync(join(__dirname, '../../../deploy/codexgui/openwa-monitor.service'), 'utf8');
  const secretCheck = readFileSync(join(__dirname, '../../../deploy/codexgui/check-secret-files.sh'), 'utf8');
  const routes = readFileSync(join(__dirname, '../../../deploy/codexgui/routes.caddy.fragment'), 'utf8');

  it('uses an immutable externally selected image and publishes no application host port', () => {
    expect(service.image).toContain('OPENWA_MONITOR_IMAGE');
    expect(service.ports).toBeUndefined();
    expect(service.expose).toEqual(['2785']);
  });

  it('mounts no Docker socket and enables least-privilege container hardening', () => {
    expect(raw).not.toContain('/var/run/docker.sock');
    expect(raw).not.toContain('DOCKER_HOST');
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(['ALL']);
    expect(service.cap_add?.sort()).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'].sort());
    expect(service.security_opt).toContain('no-new-privileges:true');
  });

  it('uses explicit state/CA mounts, the verified host gateway, and only the external edge network', () => {
    expect(service.volumes).toEqual([
      '/var/lib/openwa-monitor:/app/data',
      '/etc/openwa-monitor/postgres-ca.pem:/run/secrets/postgres-ca.pem:ro',
    ]);
    expect(service.extra_hosts).toEqual([
      '${OPENWA_MONITOR_PG_HOSTNAME:?set OPENWA_MONITOR_PG_HOSTNAME to the PostgreSQL certificate hostname}:host-gateway',
    ]);
    expect(Object.keys(service.networks ?? {})).toEqual(['edge']);
    expect(compose.networks.edge).toMatchObject({ name: 'edge', external: true });
    expect(service.env_file).toEqual(['/etc/openwa-monitor/runtime.env']);
  });

  it('refuses startup unless both secret env files are root-owned mode 0600', () => {
    expect(systemd).toContain('ExecStartPre=/opt/services/openwa-monitor/check-secret-files.sh');
    expect(secretCheck).toContain('/etc/openwa-monitor/runtime.env');
    expect(secretCheck).toContain('/etc/openwa-monitor/deploy.env');
    expect(secretCheck).toContain('root:root:600');
  });

  it('does not retake ownership of state that Docker may already have mounted at boot', () => {
    expect(systemd).toContain('ExecStartPre=/usr/bin/install -d -m 0700 /var/lib/openwa-monitor');
    expect(systemd).not.toContain('ExecStartPre=/usr/bin/install -d -o root -g root -m 0700 /var/lib/openwa-monitor');
  });

  it('keeps readiness private instead of exposing a public DB-probe endpoint', () => {
    expect(routes).not.toContain('/api/health');
    expect(service.healthcheck).toBeDefined();
  });

  it('publishes only the permanent token alias, never the ordinary API-key MCP route', () => {
    expect(routes).toContain('handle /*/mcp');
    expect(routes).not.toMatch(/handle \/mcp\s*\{/u);
  });
});
