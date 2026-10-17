import { useEffect, useState } from 'react';
import type { AppConfig, EffortLevel, PermissionMode } from '@workstation/protocol';
import { platform } from '../platform';
import { clearRemoteServer, confirmRemoteServer, getRemoteServer, getServerBase, normalizeServerOrigin } from '../lib/storage';
import { useSessions } from '../store/sessions';
import { useUi, type Brand, type Density, type Theme } from '../store/ui';
import { modelLabel } from '../lib/utils';
import { EFFORTS, MODES } from './Chips';
import { Dialog, Segmented } from './ui';

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const firstRun = useUi((s) => s.firstRunChecked);
  const theme = useUi((s) => s.theme);
  const brand = useUi((s) => s.brand);
  const density = useUi((s) => s.density);
  const config = useSessions((s) => s.config);
  const models = useSessions((s) => s.models);
  const [f, setF] = useState({ baseUrl: '', apiKey: '', authToken: '', model: '', effort: 'medium' as EffortLevel, mode: 'default' as PermissionMode, custom: '' });
  const [server, setServer] = useState(getServerBase());
  const [serverToken, setServerToken] = useState('');
  const [saving, setSaving] = useState(false);
  // the welcome title is for the very first visit only (people signed in through a Claude login never need keys)
  let firstRunPending = true; try { firstRunPending = localStorage.getItem('ws.firstRunDone') !== '1'; } catch { /* ignore */ }
  const close = () => { useUi.getState().set({ settingsOpen: false }); try { localStorage.setItem('ws.firstRunDone', '1'); } catch { /* ignore */ } };

  useEffect(() => {
    if (!open || !config) return;
    setF({ baseUrl: config.anthropicBaseUrl ?? '', apiKey: '', authToken: '', model: config.defaultModel ?? '', effort: config.defaultEffort ?? 'medium', mode: config.defaultPermissionMode ?? 'default', custom: (config.customModels ?? []).join(', ') });
    setServer(getServerBase());
    setServerToken('');
  }, [open, config]);

  // first-run: nothing configured and never dismissed
  const ready = useSessions((s) => s.ready);
  useEffect(() => {
    if (!ready || !config || firstRun) return;
    useUi.setState({ firstRunChecked: true });
    let done = false; try { done = localStorage.getItem('ws.firstRunDone') === '1'; } catch { /* ignore */ }
    if (!done && !config.hasApiKey && !config.hasAuthToken && !config.anthropicBaseUrl) useUi.getState().set({ settingsOpen: true });
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
    if (f.apiKey.trim()) patch.apiKey = f.apiKey.trim();
    if (f.authToken.trim()) patch.authToken = f.authToken.trim();
    const ok = await useSessions.getState().saveConfig(patch);
    setSaving(false);
    if (applySwitch) { if (applySwitch()) location.reload(); return; }
    if (ok) { useUi.getState().toast({ kind: 'success', title: 'Settings saved' }); close(); void useSessions.getState().loadConfig(); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const modelOpts = [...new Set([...models.map((m) => m.id), ...f.custom.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)])];
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
        </section>
        <section>
          <h3>Defaults for new sessions</h3>
          <div className="row2">
            <label className="lbl">Model<input className="field" list="model-opts" value={f.model} onChange={set('model')} placeholder="Server default" /><datalist id="model-opts">{modelOpts.map((m) => <option key={m} value={m}>{modelLabel(m)}</option>)}</datalist></label>
            <label className="lbl">Thinking effort<select className="field" value={f.effort} onChange={set('effort')}>{EFFORTS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>
          </div>
          <label className="lbl">Permission mode<select className="field" value={f.mode} onChange={set('mode')}>{MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
          <label className="lbl">Custom model ids<input className="field" value={f.custom} onChange={set('custom')} placeholder="comma separated, e.g. my-gateway/claude-sonnet" spellCheck={false} /></label>
        </section>
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
