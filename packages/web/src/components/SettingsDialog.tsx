import { useEffect, useRef, useState } from 'react';
import { MODEL_ALIAS_ENV, type AppConfig, type EffortLevel, type GatewayTestResult, type PermissionMode } from '@workstation/protocol';
import { api } from '../lib/api';
import { platform } from '../platform';
import { clearRemoteServer, confirmRemoteServer, getRemoteServer, getServerBase, normalizeServerOrigin } from '../lib/storage';
import { useSessions } from '../store/sessions';
import { useLogs } from '../store/logs';
import { useUi, type Brand, type Density, type Theme } from '../store/ui';
import { modelLabel } from '../lib/utils';
import { EFFORTS, MODES, useBypass } from './Chips';
import { Dialog, Segmented } from './ui';
import { RememberedRules } from './RememberedRules';

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const firstRun = useUi((s) => s.firstRunChecked);
  const theme = useUi((s) => s.theme);
  const brand = useUi((s) => s.brand);
  const density = useUi((s) => s.density);
  const config = useSessions((s) => s.config);
  const bypass = useBypass();
  const models = useSessions((s) => s.models);
  const [f, setF] = useState({ baseUrl: '', apiKey: '', authToken: '', model: '', effort: 'medium' as EffortLevel, mode: 'default' as PermissionMode, custom: '' });
  const [alias, setAlias] = useState<Record<string, string>>({});
  const [gw, setGw] = useState<{ busy: boolean; result?: GatewayTestResult; error?: string }>({ busy: false });
  const focus = useUi((s) => s.settingsFocus);
  const [server, setServer] = useState(getServerBase());
  const [serverToken, setServerToken] = useState('');
  const [saving, setSaving] = useState(false);
  // "Welcome" belongs to the automatic first-run prompt only; opening Settings yourself later is just "Settings"
  const firstRunPending = useUi((s) => s.settingsFirstRun);
  const close = () => { useUi.getState().set({ settingsOpen: false, settingsFocus: undefined }); useUi.setState({ settingsFirstRun: false }); try { localStorage.setItem('ws.firstRunDone', '1'); } catch { /* ignore */ } };

  // Seed the form ONCE per opening (when the config is first available). A later config refresh (reconnect, a background reload) must
  // not wipe what the person is typing.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) { seeded.current = false; return; }
    if (!config || seeded.current) return;
    seeded.current = true;
    setF({ baseUrl: config.anthropicBaseUrl ?? '', apiKey: '', authToken: '', model: config.defaultModel ?? '', effort: config.defaultEffort ?? 'medium', mode: config.defaultPermissionMode ?? 'default', custom: (config.customModels ?? []).join(', ') });
    setAlias(Object.fromEntries(MODEL_ALIAS_ENV.map((a) => [a.env, config.env?.[a.env] ?? ''])));
    setGw({ busy: false });
    setServer(getServerBase());
    setServerToken('');
  }, [open, config]);

  // "Model settings" (banner / model menu): land on the Model field, after the dialog's own first-field focus
  useEffect(() => {
    if (!open || focus !== 'model' || !config) return;
    const t = setTimeout(() => { const el = document.getElementById('set-model'); el?.scrollIntoView({ block: 'center' }); el?.focus(); }, 60);
    return () => clearTimeout(t);
  }, [open, focus, config]);

  // first-run: nothing configured and never dismissed
  const ready = useSessions((s) => s.ready);
  useEffect(() => {
    if (!ready || !config || firstRun) return;
    useUi.setState({ firstRunChecked: true });
    let done = false; try { done = localStorage.getItem('ws.firstRunDone') === '1'; } catch { /* ignore */ }
    if (!done && !config.hasApiKey && !config.hasAuthToken && !config.anthropicBaseUrl) { useUi.setState({ settingsFirstRun: true }); useUi.getState().set({ settingsOpen: true }); }
  }, [ready, config, firstRun]);

  const save = async () => {
    // Server switch is confirmed FIRST (and applied only after the config below was saved to the CURRENT server).
    let applySwitch: (() => boolean) | null = null;
    if (server.trim().replace(/\/+$/, '') !== getServerBase()) {
      applySwitch = await planServerSwitch(server, serverToken);
      if (!applySwitch) return; // declined or invalid: keep Settings open, nothing switched
    }
    setSaving(true);
    const patch: Partial<AppConfig> = {
      anthropicBaseUrl: f.baseUrl.trim(), defaultModel: f.model.trim() || undefined, defaultEffort: f.effort, defaultPermissionMode: f.mode,
      customModels: f.custom.split(/[,\n]/).map((x) => x.trim()).filter(Boolean), theme,
    };
    // gateway aliases live in the env handed to the agent; every other env entry is kept as it is (secret-looking ones stay masked server-side)
    const env = { ...(config?.env ?? {}) };
    for (const a of MODEL_ALIAS_ENV) { const v = (alias[a.env] ?? '').trim(); if (v) env[a.env] = v; else delete env[a.env]; }
    if (JSON.stringify(env) !== JSON.stringify(config?.env ?? {})) patch.env = env;
    if (f.apiKey.trim()) patch.apiKey = f.apiKey.trim();
    if (f.authToken.trim()) patch.authToken = f.authToken.trim();
    const ok = await useSessions.getState().saveConfig(patch);
    setSaving(false);
    if (applySwitch) { if (applySwitch()) location.reload(); return; }
    if (ok) { useUi.getState().toast({ kind: 'success', title: 'Settings saved' }); close(); void useSessions.getState().loadConfig(); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const fromGateway = new Set([...models.filter((m) => m.source === 'gateway').map((m) => m.id), ...(gw.result?.models ?? [])]);
  const modelOpts = [...new Set([...fromGateway, ...models.map((m) => m.id), ...f.custom.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)])];
  const hasAlias = MODEL_ALIAS_ENV.some((a) => (alias[a.env] ?? '').trim());
  const testConnection = async () => {
    setGw({ busy: true });
    try {
      const result = await api.gatewayTest({
        baseUrl: f.baseUrl.trim() || undefined, apiKey: f.apiKey.trim() || undefined, authToken: f.authToken.trim() || undefined, model: f.model.trim(),
        aliasEnv: Object.fromEntries(MODEL_ALIAS_ENV.map((a) => [a.env, (alias[a.env] ?? '').trim()])),
      });
      setGw({ busy: false, result });
    } catch (e) { setGw({ busy: false, error: (e as Error).message }); }
  };
  const notif = platform.notificationPermission();

  return (
    <Dialog open={open} onClose={close} title={firstRunPending && config && !config.hasApiKey && !config.hasAuthToken && !config.anthropicBaseUrl ? 'Welcome. Set up your connection' : 'Settings'} width={560}
      footer={<><button type="button" className="btn ghost" onClick={close}>Cancel</button><button type="button" className="btn primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></>}>
      <div className="settings">
        <p className="muted small">Credentials are sent to your local Workstation server and used as the environment of the agent (built on the Claude Agent SDK). If you are already signed in on this machine, you can leave these empty.</p>
        <section>
          <h3>Provider</h3>
          <label className="lbl">Anthropic base URL<input className="field" value={f.baseUrl} onChange={set('baseUrl')} placeholder="https://api.anthropic.com (default)" spellCheck={false} /></label>
          <div className="row2">
            <label className="lbl">API key {config?.hasApiKey && <span className="tag">set</span>}<input className="field" type="password" autoComplete="off" value={f.apiKey} onChange={set('apiKey')} placeholder={config?.hasApiKey ? '•••••••• (leave blank to keep)' : 'sk-ant-…'} /></label>
            <label className="lbl">Auth token {config?.hasAuthToken && <span className="tag">set</span>}<input className="field" type="password" autoComplete="off" value={f.authToken} onChange={set('authToken')} placeholder={config?.hasAuthToken ? '•••••••• (leave blank to keep)' : 'Bearer token for gateways'} /></label>
          </div>
          {f.baseUrl.trim() && (
            <div className="gw-test">
              <button type="button" className="btn" disabled={gw.busy} onClick={testConnection}>{gw.busy ? 'Testing…' : 'Test connection'}</button>
              <span className="muted small">Sends one 1-token message{f.model.trim() ? ` to ${f.model.trim()}` : ''} with the values above.</span>
              <div className={`gw-result${gw.result ? (gw.result.ok ? ' ok' : ' bad') : gw.error ? ' bad' : ''}`} role="status" aria-live="polite">
                {gw.result ? <>{gw.result.ok ? 'Works. ' : 'Failed. '}{gw.result.message}{gw.result.models.length > 0 && <> Gateway lists {gw.result.models.length} model{gw.result.models.length === 1 ? '' : 's'}.</>}</> : gw.error ? `Could not run the test: ${gw.error}` : null}
              </div>
            </div>
          )}
        </section>
        <section>
          <h3>Defaults for new sessions</h3>
          <div className="row2">
            <label className="lbl">Model<input id="set-model" aria-label="Model" className="field" list="model-opts" value={f.model} onChange={set('model')} placeholder={f.baseUrl.trim() ? 'Model id on your gateway' : 'Server default'} /><datalist id="model-opts">{modelOpts.map((m) => <option key={m} value={m}>{fromGateway.has(m) ? `${m} (from gateway)` : modelLabel(m)}</option>)}</datalist></label>
            <label className="lbl">Thinking effort<select className="field" value={f.effort} onChange={set('effort')}>{EFFORTS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
          </div>
          <label className="lbl">Permission mode<select className="field" value={f.mode} onChange={set('mode')}>{MODES.map((m) => { const off = m.id === 'bypassPermissions' && !bypass.available && f.mode !== m.id; return <option key={m.id} value={m.id} disabled={off}>{m.label}{off ? ' (unavailable on this server)' : ''}</option>; })}</select></label>
          {f.baseUrl.trim() && !f.model.trim() && <p className="hint small" role="note">A gateway usually needs an explicit model id: without one, the agent asks it for an Anthropic model name it may not serve.{fromGateway.size > 0 ? ` ${fromGateway.size} found on the gateway, pick from the list.` : ' Type the id your gateway serves, or press Test connection to list them.'}</p>}
          <label className="lbl">Custom model ids<input className="field" value={f.custom} onChange={set('custom')} placeholder="comma separated, e.g. my-gateway/claude-sonnet" spellCheck={false} /></label>
        </section>
        {(f.baseUrl.trim() || hasAlias) && (
          <section>
            <h3>Gateway model aliases</h3>
            <p className="muted small">The agent also uses its own model names (Sonnet, Opus, Haiku, a small/fast helper, subagents). Map the ones your gateway serves under another id; blank keeps the built-in name.</p>
            <div className="row2">
              {MODEL_ALIAS_ENV.map((a) => (
                <label key={a.env} className="lbl" title={a.env}>{a.label}<input className="field" list="model-opts" value={alias[a.env] ?? ''} onChange={(e) => setAlias({ ...alias, [a.env]: e.target.value })} placeholder="gateway model id" spellCheck={false} autoComplete="off" /></label>
              ))}
            </div>
          </section>
        )}
        <RememberedRules active={open} />
        <section>
          <h3>Appearance</h3>
          <div className="row-between"><span>Theme</span><Segmented<Theme> value={theme} onChange={(t) => useUi.getState().setTheme(t)} options={[{ id: 'system', label: 'System', icon: 'monitor' }, { id: 'light', label: 'Light', icon: 'sun' }, { id: 'dark', label: 'Dark', icon: 'moon' }]} /></div>
          <div className="row-between"><span>Brand</span><Segmented<Brand> value={brand} onChange={(b) => useUi.getState().setBrand(b)} options={[{ id: 'horizon', label: 'Horizon' }, { id: 'warm', label: 'Warm' }]} /></div>
          <div className="row-between"><span>Density</span><Segmented<Density> value={density} onChange={(d) => useUi.getState().setDensity(d)} options={[{ id: 'compact', label: 'Compact' }, { id: 'comfortable', label: 'Comfortable' }]} /></div>
        </section>
        <section>
          <h3>Notifications and server</h3>
          {platform.notificationsSupported() && (
            <div className="row-between">
              <span>Desktop notifications when a session needs you or finishes</span>
              {notif === 'granted' ? <span className="tag">on</span> : notif === 'denied' ? <span className="muted small">blocked in browser</span> : <button type="button" className="btn" onClick={async () => { await platform.requestNotificationPermission(); useUi.setState({}); }}>Enable</button>}
            </div>
          )}
          <div className="row-between">
            <span>Server log: errors, warnings and what the agent reported</span>
            <button type="button" className="btn" onClick={() => { close(); useLogs.getState().openLogs(); }}>View logs</button>
          </div>
          <label className="lbl">Server URL<input className="field" value={server} onChange={(e) => setServer(e.target.value)} spellCheck={false} /></label>
          {normalizeServerOrigin(server) !== location.origin && <label className="lbl">Access token for that server<input className="field" type="password" autoComplete="off" value={serverToken} onChange={(e) => setServerToken(e.target.value)} placeholder={getRemoteServer() ? '•••••••• (leave blank to keep)' : 'the token printed by that server'} /></label>}
          <p className="muted small">Defaults to this page's origin. A different server must be confirmed: this page will send it your access token, API keys, prompts and code. Changing it reloads the app.</p>
        </section>
      </div>
    </Dialog>
  );
}

/**
 * Switches the server. Same origin needs no confirmation; any other origin needs an explicit confirm that names it and
 * says what will be sent there. Resolves to a function that applies the switch (true = reload), or null if declined.
 */
export async function planServerSwitch(input: string, token: string): Promise<(() => boolean) | null> {
  const origin = normalizeServerOrigin(input.trim() || location.origin);
  if (!origin) { useUi.getState().toast({ kind: 'error', title: 'Invalid server URL', body: 'Use an http:// or https:// URL.' }); return null; }
  if (origin === location.origin) return () => { clearRemoteServer(); return true; };
  const keep = getRemoteServer();
  const tok = token.trim() || (keep?.origin === origin ? keep.token : '');
  const ok = await useUi.getState().ask({
    title: 'Connect to a different server?',
    body: `This page will connect to ${origin}. Your access token, any API keys or auth tokens you save, and all prompts, files and terminal input will be sent to that server. Only continue if you run it yourself.`,
    confirmLabel: `Send token to ${new URL(origin).host}`,
    danger: true,
  });
  if (!ok) return null;
  return () => confirmRemoteServer(origin, tok);
}
