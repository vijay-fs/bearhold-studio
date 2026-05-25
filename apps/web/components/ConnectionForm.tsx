'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { CheckCircle2, XCircle, Loader2, KeyRound, Network, ShieldCheck, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

import { ENGINE_LABELS, type ConnectionProfile, type DatabaseEngine } from '@/lib/types';
import { api } from '@/lib/api';
import { isDesktop } from '@/lib/runtime';
import { useConnections } from '@/store/connections';

type TestState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok' }
  | { kind: 'error'; code: string; message: string };

export function ConnectionForm({ initial }: { initial: ConnectionProfile }) {
  const router = useRouter();
  const upsert = useConnections((s) => s.upsert);
  const [profile, setProfile] = useState<ConnectionProfile>(initial);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  // Password is keychain-backed, never in profile state. Track whether one is
  // already saved (for the "Password set" indicator), and a separate buffer
  // for new values the user types.
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');

  // SSH tunnel toggling + buffer state for credentials that go to keychain.
  const [tunnelEnabled, setTunnelEnabled] = useState(initial.ssh_tunnel != null);
  const [tunnelAuthKind, setTunnelAuthKind] = useState<'password' | 'key'>(
    initial.ssh_tunnel?.auth.kind ?? 'key',
  );
  const [tunnelPasswordInput, setTunnelPasswordInput] = useState('');
  const [tunnelPassphraseInput, setTunnelPassphraseInput] = useState('');
  const [hasSavedTunnelPassword, setHasSavedTunnelPassword] = useState(false);
  const [hasSavedTunnelPassphrase, setHasSavedTunnelPassphrase] = useState(false);

  // Host-key discovery state. `discovered` is the fingerprint we just fetched
  // and haven't pinned yet; clicking Trust copies it onto the profile.
  const [discoverState, setDiscoverState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'discovered'; fingerprint: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const isSqlite = profile.engine === 'sqlite';

  useEffect(() => {
    if (!isDesktop()) return;
    (async () => {
      // Migration: profiles from the inline-workaround era still carry
      // password_ref / passphrase_ref values. Copy them into the encrypted
      // store and blank them on the form state so the next Save sanitizes
      // them out of localStorage for good.
      const migrations: Array<[string, () => void]> = [];
      if (initial.auth.kind === 'password' && initial.auth.password_ref) {
        await api.setSecret(initial.id, 'password', initial.auth.password_ref);
        migrations.push([
          'db password',
          () =>
            setProfile((p) => ({
              ...p,
              auth:
                p.auth.kind === 'password'
                  ? { ...p.auth, password_ref: '' }
                  : p.auth,
            })),
        ]);
      }
      if (
        initial.ssh_tunnel?.auth.kind === 'password' &&
        initial.ssh_tunnel.auth.password_ref
      ) {
        await api.setSecret(
          initial.id,
          'ssh_tunnel_password',
          initial.ssh_tunnel.auth.password_ref,
        );
        migrations.push([
          'ssh tunnel password',
          () =>
            setProfile((p) =>
              p.ssh_tunnel && p.ssh_tunnel.auth.kind === 'password'
                ? {
                    ...p,
                    ssh_tunnel: {
                      ...p.ssh_tunnel,
                      auth: { kind: 'password', password_ref: '' },
                    },
                  }
                : p,
            ),
        ]);
      }
      if (
        initial.ssh_tunnel?.auth.kind === 'key' &&
        initial.ssh_tunnel.auth.passphrase_ref
      ) {
        await api.setSecret(
          initial.id,
          'ssh_tunnel_passphrase',
          initial.ssh_tunnel.auth.passphrase_ref,
        );
        migrations.push([
          'ssh key passphrase',
          () =>
            setProfile((p) =>
              p.ssh_tunnel && p.ssh_tunnel.auth.kind === 'key'
                ? {
                    ...p,
                    ssh_tunnel: {
                      ...p.ssh_tunnel,
                      auth: {
                        kind: 'key',
                        key_ref: p.ssh_tunnel.auth.key_ref,
                        passphrase_ref: null,
                      },
                    },
                  }
                : p,
            ),
        ]);
      }
      for (const [, apply] of migrations) apply();

      try {
        setHasSavedPassword(await api.hasSecret(profile.id, 'password'));
        setHasSavedTunnelPassword(
          await api.hasSecret(profile.id, 'ssh_tunnel_password'),
        );
        setHasSavedTunnelPassphrase(
          await api.hasSecret(profile.id, 'ssh_tunnel_passphrase'),
        );
      } catch {
        // first-run before secrets store init, etc. — defaults stay false.
      }
    })().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => {
    setProfile((p) => ({ ...p, [key]: value }));
    setTest({ kind: 'idle' });
  };

  const switchEngine = (engine: DatabaseEngine) => {
    setTest({ kind: 'idle' });
    if (engine === 'sqlite') {
      setProfile((p) => ({
        ...p,
        engine,
        host: '',
        port: 0,
        database: '',
        auth: { kind: 'none' },
        file_path: p.file_path ?? '',
      }));
    } else {
      const defaultPort =
        engine === 'mysql' || engine === 'mariadb'
          ? 3306
          : engine === 'mongodb'
            ? 27017
            : engine === 'redis'
              ? 6379
              : 5432;
      // Default DB name conventions differ wildly per engine, so we clear
      // it on engine switch to force the user to set the right value
      // (e.g. `postgres` -> `shop` for MySQL).
      setProfile((p) => ({
        ...p,
        engine,
        port: defaultPort,
        host: p.host || 'localhost',
        database: p.engine === engine ? p.database : '',
        auth:
          p.auth.kind === 'password'
            ? p.auth
            : { kind: 'password', username: '', password_ref: '' },
      }));
    }
  };

  const setUsername = (username: string) => {
    setProfile((p) => ({
      ...p,
      auth: p.auth.kind === 'password' ? { ...p.auth, username } : p.auth,
    }));
  };

  // Persist credentials to the encrypted secrets file (managed by
  // dbstudio-core::secrets). The store is OS-user-private and uses
  // ChaCha20-Poly1305; see services/core/src/secrets.rs.
  const ensurePasswordSaved = async () => {
    if (passwordInput) {
      await api.setSecret(profile.id, 'password', passwordInput);
      setHasSavedPassword(true);
    }
    if (tunnelEnabled && tunnelAuthKind === 'password' && tunnelPasswordInput) {
      await api.setSecret(profile.id, 'ssh_tunnel_password', tunnelPasswordInput);
      setHasSavedTunnelPassword(true);
    }
    if (tunnelEnabled && tunnelAuthKind === 'key' && tunnelPassphraseInput) {
      await api.setSecret(profile.id, 'ssh_tunnel_passphrase', tunnelPassphraseInput);
      setHasSavedTunnelPassphrase(true);
    }
  };

  // The profile that's both sent to the driver and persisted to Zustand
  // carries NO inline secrets — those live in the encrypted store.
  // password_ref / passphrase_ref fields stay empty strings.
  const sanitizedProfile = (): ConnectionProfile => {
    const auth: ConnectionProfile['auth'] =
      profile.auth.kind === 'password'
        ? { ...profile.auth, password_ref: '' }
        : profile.auth;

    const tunnel = profile.ssh_tunnel
      ? {
          ...profile.ssh_tunnel,
          auth:
            profile.ssh_tunnel.auth.kind === 'password'
              ? { kind: 'password' as const, password_ref: '' }
              : {
                  kind: 'key' as const,
                  key_ref: profile.ssh_tunnel.auth.key_ref,
                  passphrase_ref: null,
                },
        }
      : null;

    return { ...profile, auth, ssh_tunnel: tunnel };
  };

  const updateTunnel = (
    fn: (t: NonNullable<ConnectionProfile['ssh_tunnel']>) => NonNullable<ConnectionProfile['ssh_tunnel']>,
  ) => {
    setTest({ kind: 'idle' });
    setProfile((p) => {
      const base = p.ssh_tunnel ?? {
        host: '',
        port: 22,
        username: '',
        auth: { kind: 'key', key_ref: '', passphrase_ref: null },
        host_key_fingerprint: null,
      };
      return { ...p, ssh_tunnel: fn(base) };
    });
  };

  const toggleTunnel = (enabled: boolean) => {
    setTunnelEnabled(enabled);
    setTest({ kind: 'idle' });
    if (enabled) {
      updateTunnel((t) => t);
    } else {
      setProfile((p) => ({ ...p, ssh_tunnel: null }));
    }
  };

  const onDiscoverHostKey = async () => {
    if (!profile.ssh_tunnel?.host) return;
    setDiscoverState({ kind: 'loading' });
    try {
      const fingerprint = await api.discoverHostKey(
        profile.ssh_tunnel.host,
        profile.ssh_tunnel.port,
      );
      setDiscoverState({ kind: 'discovered', fingerprint });
    } catch (e: unknown) {
      const err = e as { message?: string };
      setDiscoverState({
        kind: 'error',
        message: err.message ?? String(e),
      });
    }
  };

  const onTrustHostKey = (fingerprint: string) => {
    updateTunnel((t) => ({ ...t, host_key_fingerprint: fingerprint }));
    setDiscoverState({ kind: 'idle' });
  };

  const onClearHostKey = () => {
    updateTunnel((t) => ({ ...t, host_key_fingerprint: null }));
    setDiscoverState({ kind: 'idle' });
  };

  const switchTunnelAuth = (kind: 'password' | 'key') => {
    setTunnelAuthKind(kind);
    updateTunnel((t) => ({
      ...t,
      auth:
        kind === 'password'
          ? { kind: 'password', password_ref: '' }
          : { kind: 'key', key_ref: t.auth.kind === 'key' ? t.auth.key_ref : '', passphrase_ref: null },
    }));
  };

  const onTest = async () => {
    setTest({ kind: 'loading' });
    try {
      await ensurePasswordSaved();
      await api.testConnection(sanitizedProfile());
      setTest({ kind: 'ok' });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setTest({
        kind: 'error',
        code: err.code ?? 'unknown',
        message: err.message ?? String(e),
      });
    }
  };

  const onSave = async () => {
    try {
      await ensurePasswordSaved();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setTest({
        kind: 'error',
        code: err.code ?? 'unknown',
        message: err.message ?? String(e),
      });
      return;
    }
    upsert(sanitizedProfile());
    setPasswordInput('');
    setTunnelPasswordInput('');
    setTunnelPassphraseInput('');
    router.push(`/connections/${profile.id}/schema` as Route);
  };

  const username = profile.auth.kind === 'password' ? profile.auth.username : '';

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add connection</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connection details are stored locally on this device only.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
          <CardDescription>Name your connection and pick the engine.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Display name">
            <Input
              value={profile.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="prod-readonly"
            />
          </Field>
          <Field label="Engine">
            <Select
              value={profile.engine}
              onChange={(e) => switchEngine(e.target.value as DatabaseEngine)}
            >
              <option value="postgres">{ENGINE_LABELS.postgres}</option>
              <option value="cockroachdb">{ENGINE_LABELS.cockroachdb}</option>
              <option value="mysql">{ENGINE_LABELS.mysql}</option>
              <option value="mariadb">{ENGINE_LABELS.mariadb}</option>
              <option value="sqlite">{ENGINE_LABELS.sqlite}</option>
              <option value="mongodb">{ENGINE_LABELS.mongodb}</option>
              <option value="redis">{ENGINE_LABELS.redis}</option>
            </Select>
          </Field>
        </CardContent>
      </Card>

      {isSqlite ? (
        <Card>
          <CardHeader>
            <CardTitle>Database file</CardTitle>
            <CardDescription>
              Absolute path to the SQLite file. The file is opened in
              read-write mode; create it via <code>sqlite3 mydb.db ".databases"</code>
              first if it doesn&apos;t exist.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Field label="File path">
              <Input
                value={profile.file_path ?? ''}
                onChange={(e) => setField('file_path', e.target.value)}
                placeholder="/Users/you/data/app.sqlite"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Host</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-[2fr_1fr_2fr]">
              <Field label="Host">
                <Input value={profile.host} onChange={(e) => setField('host', e.target.value)} />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={profile.port}
                  onChange={(e) => setField('port', Number(e.target.value))}
                />
              </Field>
              <Field label="Database">
                <Input
                  value={profile.database}
                  onChange={(e) => setField('database', e.target.value)}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Authentication</CardTitle>
              <CardDescription className="flex items-center gap-1.5">
                <KeyRound className="h-3 w-3" />
                Password is stored in your OS keychain, not in app storage.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <Field label="Username">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field
                label={hasSavedPassword ? 'Password (saved — type to replace)' : 'Password'}
              >
                <Input
                  type="password"
                  value={passwordInput}
                  onChange={(e) => {
                    setPasswordInput(e.target.value);
                    setTest({ kind: 'idle' });
                  }}
                  placeholder={hasSavedPassword ? '••••••••' : ''}
                  autoComplete="off"
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="flex items-center gap-1.5">
                  <Network className="h-4 w-4" />
                  SSH tunnel (optional)
                </CardTitle>
                <CardDescription>
                  Reach a private database via an SSH bastion. The driver connects
                  to a local port forwarded through the bastion.
                </CardDescription>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={tunnelEnabled}
                  onChange={(e) => toggleTunnel(e.target.checked)}
                />
                <span>Enable</span>
              </label>
            </CardHeader>
            {tunnelEnabled && profile.ssh_tunnel && (
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-[2fr_1fr_2fr]">
                  <Field label="Bastion host">
                    <Input
                      value={profile.ssh_tunnel.host}
                      onChange={(e) =>
                        updateTunnel((t) => ({ ...t, host: e.target.value }))
                      }
                      placeholder="bastion.example.com"
                    />
                  </Field>
                  <Field label="Bastion port">
                    <Input
                      type="number"
                      value={profile.ssh_tunnel.port}
                      onChange={(e) =>
                        updateTunnel((t) => ({ ...t, port: Number(e.target.value) }))
                      }
                    />
                  </Field>
                  <Field label="Bastion username">
                    <Input
                      value={profile.ssh_tunnel.username}
                      onChange={(e) =>
                        updateTunnel((t) => ({ ...t, username: e.target.value }))
                      }
                      placeholder="ec2-user"
                    />
                  </Field>
                </div>

                <Field label="Auth method">
                  <Select
                    value={tunnelAuthKind}
                    onChange={(e) => switchTunnelAuth(e.target.value as 'password' | 'key')}
                  >
                    <option value="key">SSH key (recommended)</option>
                    <option value="password">Password</option>
                  </Select>
                </Field>

                {tunnelAuthKind === 'key' ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Private key path">
                      <Input
                        value={
                          profile.ssh_tunnel.auth.kind === 'key'
                            ? profile.ssh_tunnel.auth.key_ref
                            : ''
                        }
                        onChange={(e) =>
                          updateTunnel((t) => ({
                            ...t,
                            auth: {
                              kind: 'key',
                              key_ref: e.target.value,
                              passphrase_ref:
                                t.auth.kind === 'key' ? t.auth.passphrase_ref : null,
                            },
                          }))
                        }
                        placeholder="/Users/you/.ssh/id_ed25519"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </Field>
                    <Field
                      label={
                        hasSavedTunnelPassphrase
                          ? 'Passphrase (saved — type to replace)'
                          : 'Passphrase (optional)'
                      }
                    >
                      <Input
                        type="password"
                        value={tunnelPassphraseInput}
                        onChange={(e) => {
                          setTunnelPassphraseInput(e.target.value);
                          setTest({ kind: 'idle' });
                        }}
                        placeholder={hasSavedTunnelPassphrase ? '••••••••' : ''}
                        autoComplete="off"
                      />
                    </Field>
                  </div>
                ) : (
                  <Field
                    label={
                      hasSavedTunnelPassword
                        ? 'Bastion password (saved — type to replace)'
                        : 'Bastion password'
                    }
                  >
                    <Input
                      type="password"
                      value={tunnelPasswordInput}
                      onChange={(e) => {
                        setTunnelPasswordInput(e.target.value);
                        setTest({ kind: 'idle' });
                      }}
                      placeholder={hasSavedTunnelPassword ? '••••••••' : ''}
                      autoComplete="off"
                    />
                  </Field>
                )}

                <HostKeyBlock
                  pinned={profile.ssh_tunnel.host_key_fingerprint ?? null}
                  bastionHost={profile.ssh_tunnel.host}
                  bastionPort={profile.ssh_tunnel.port}
                  state={discoverState}
                  onDiscover={onDiscoverHostKey}
                  onTrust={onTrustHostKey}
                  onClear={onClearHostKey}
                />
              </CardContent>
            )}
          </Card>
        </>
      )}

      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={onTest} disabled={test.kind === 'loading'}>
          {test.kind === 'loading' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {test.kind === 'ok' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
          {test.kind === 'error' && <XCircle className="h-3.5 w-3.5 text-destructive" />}
          Test connection
        </Button>
        <Button
          onClick={onSave}
          disabled={
            !profile.name.trim() || (isSqlite && !(profile.file_path ?? '').trim())
          }
        >
          Save
        </Button>
        {test.kind === 'error' && (
          <p className="text-xs text-destructive">
            <span className="font-mono">{test.code}</span> · {test.message}
          </p>
        )}
        {test.kind === 'ok' && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            Connection successful.
          </p>
        )}
        {!isDesktop() && (
          <p className="text-xs text-muted-foreground">
            Browser mode: Test will fail (use the desktop app to actually connect).
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

type DiscoverState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'discovered'; fingerprint: string }
  | { kind: 'error'; message: string };

function HostKeyBlock({
  pinned,
  bastionHost,
  bastionPort,
  state,
  onDiscover,
  onTrust,
  onClear,
}: {
  pinned: string | null;
  bastionHost: string;
  bastionPort: number;
  state: DiscoverState;
  onDiscover: () => void;
  onTrust: (fingerprint: string) => void;
  onClear: () => void;
}) {
  const canDiscover = Boolean(bastionHost) && bastionPort > 0;
  const newFingerprint =
    state.kind === 'discovered' && state.fingerprint !== pinned ? state.fingerprint : null;

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {pinned ? (
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
            )}
            Bastion host key
          </div>
          <p className="text-xs text-muted-foreground">
            {pinned
              ? "Connections are refused if the server presents a different key. Re-pin only after verifying the new key out-of-band."
              : "Pin the bastion's SHA256 fingerprint before connecting. Cross-check it with `ssh-keygen -lf` on the host."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDiscover}
          disabled={!canDiscover || state.kind === 'loading'}
        >
          {state.kind === 'loading' && <Loader2 className="h-3 w-3 animate-spin" />}
          {pinned ? 'Re-discover' : 'Discover'}
        </Button>
      </div>

      {pinned && (
        <div className="flex items-center justify-between gap-3 rounded bg-background px-2 py-1.5 text-xs">
          <code className="break-all font-mono text-emerald-600 dark:text-emerald-400">
            {pinned}
          </code>
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            Clear
          </button>
        </div>
      )}

      {newFingerprint && (
        <div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {pinned ? 'Different key from the one pinned' : 'Server presented this key'}
          </p>
          <code className="block break-all font-mono">{newFingerprint}</code>
          <p className="text-muted-foreground">
            Compare against <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</code> on the bastion before trusting.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onTrust(newFingerprint)}
            >
              Trust this key
            </Button>
          </div>
        </div>
      )}

      {state.kind === 'discovered' && state.fingerprint === pinned && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          Server key matches the pinned fingerprint.
        </p>
      )}

      {state.kind === 'error' && (
        <p className="text-xs text-destructive">{state.message}</p>
      )}
    </div>
  );
}
