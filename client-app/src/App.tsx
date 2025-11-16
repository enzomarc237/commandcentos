import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import create from 'zustand';
import dayjs from 'dayjs';
import clsx from 'clsx';

const SESSION_STORAGE_KEY = 'rcc.client.session';
const SERVER_STORAGE_KEY = 'rcc.client.server';

type ExecutionStatus = 'pending' | 'running' | 'success' | 'error';

type CommandDefinition = {
  id: string;
  name: string;
  executable: string;
  args: string[];
  description?: string | null;
  tags: string[];
  allowArguments: boolean;
  createdAt: string;
  updatedAt: string;
};

type ExecutionLog = {
  id: string;
  commandId: string;
  commandName: string;
  requestedBy: string;
  status: ExecutionStatus;
  output: string;
  error?: string | null;
  parameters: string[];
  startedAt: string;
  finishedAt?: string | null;
};

type LoginResponse = {
  token: string;
  expiresAt: string;
};

type ServerEvent =
  | { type: 'command_created'; payload: CommandDefinition }
  | { type: 'command_updated'; payload: CommandDefinition }
  | { type: 'command_deleted'; payload: { id: string } }
  | { type: 'execution_started'; payload: ExecutionLog }
  | { type: 'execution_updated'; payload: ExecutionLog }
  | { type: 'execution_finished'; payload: ExecutionLog };

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(withoutTrailingSlash)) {
    return `https://${withoutTrailingSlash}`;
  }
  return withoutTrailingSlash;
}

function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/events';
  url.search = '';
  return url.toString();
}

type StoreState = {
  serverUrl: string;
  token: string;
  status: ConnectionStatus;
  socketConnected: boolean;
  loading: boolean;
  error?: string;
  commands: CommandDefinition[];
  history: ExecutionLog[];
  login: (payload: { serverUrl: string; username: string; password: string }) => Promise<void>;
  logout: () => void;
  fetchData: () => Promise<void>;
  execute: (commandId: string, parameters: string[]) => Promise<string>;
  integrateEvent: (event: ServerEvent) => void;
  markSocketConnected: (connected: boolean) => void;
  setServerUrl: (url: string) => void;
  clearError: () => void;
};

const initialSession = (() => {
  if (typeof window === 'undefined') {
    return { serverUrl: '', token: '' };
  }
  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as { serverUrl?: string; token?: string };
      return {
        serverUrl: parsed.serverUrl ?? '',
        token: parsed.token ?? '',
      };
    }
    const fallbackServer = window.localStorage.getItem(SERVER_STORAGE_KEY) ?? '';
    return { serverUrl: fallbackServer, token: '' };
  } catch (error) {
    console.warn('Failed to load stored session', error);
    return { serverUrl: '', token: '' };
  }
})();

const useCommandStore = create<StoreState>((set, get) => ({
  serverUrl: initialSession.serverUrl,
  token: initialSession.token,
  status: initialSession.token ? 'connecting' : 'disconnected',
  socketConnected: false,
  loading: false,
  error: undefined,
  commands: [],
  history: [],
  login: async ({ serverUrl, username, password }) => {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    if (!normalizedUrl) {
      set({ error: 'Please provide a server URL.' });
      throw new Error('Missing server URL');
    }

    set({ status: 'connecting', error: undefined, loading: true, serverUrl: normalizedUrl });

    try {
      const response = await axios.post<LoginResponse>(
        `${normalizedUrl}/api/auth/login`,
        { username, password },
        { timeout: 8000 }
      );

      const token = response.data.token;
      set({ token, status: 'connected', loading: false });

      if (typeof window !== 'undefined') {
        window.localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ serverUrl: normalizedUrl, token })
        );
      }
    } catch (error) {
      const message =
        axios.isAxiosError(error)
          ? error.response?.data?.message ?? error.response?.statusText ?? 'Unable to authenticate'
          : (error as Error).message;
      set({ status: 'disconnected', loading: false, error: message, token: '' });
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      }
      throw error;
    }
  },
  logout: () => {
    set({ token: '', status: 'disconnected', socketConnected: false, commands: [], history: [] });
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  },
  fetchData: async () => {
    const { serverUrl, token } = get();
    if (!serverUrl || !token) return;
    try {
      set({ loading: true, error: undefined });
      const [commandsRes, historyRes] = await Promise.all([
        axios.get<CommandDefinition[]>(`${serverUrl}/api/commands`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
        }),
        axios.get<ExecutionLog[]>(`${serverUrl}/api/history`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
        }),
      ]);

      const commands = commandsRes.data.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );
      const history = historyRes.data.sort(
        (a, b) => dayjs(b.startedAt).valueOf() - dayjs(a.startedAt).valueOf()
      );
      set({ commands, history, loading: false, status: 'connected' });
    } catch (error) {
      const message =
        axios.isAxiosError(error)
          ? error.response?.data?.message ?? error.response?.statusText ?? 'Unable to reach server'
          : (error as Error).message;
      set({ loading: false, error: message });
    }
  },
  execute: async (commandId, parameters) => {
    const { serverUrl, token } = get();
    if (!serverUrl || !token) {
      throw new Error('Not authenticated');
    }
    try {
      const response = await axios.post<ExecutionLog>(
        `${serverUrl}/api/commands/${commandId}/execute`,
        { parameters },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15000,
        }
      );
      return response.data.id;
    } catch (error) {
      const message =
        axios.isAxiosError(error)
          ? error.response?.data?.message ?? error.response?.statusText ?? 'Command failed'
          : (error as Error).message;
      set({ error: message });
      throw error;
    }
  },
  integrateEvent: (event) => {
    set((state) => {
      switch (event.type) {
        case 'command_created': {
          const commands = [event.payload, ...state.commands.filter((c) => c.id !== event.payload.id)]
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
          return { commands };
        }
        case 'command_updated': {
          const commands = [event.payload, ...state.commands.filter((c) => c.id !== event.payload.id)]
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
          return { commands };
        }
        case 'command_deleted': {
          const commands = state.commands.filter((command) => command.id !== event.payload.id);
          return { commands };
        }
        case 'execution_started':
        case 'execution_updated':
        case 'execution_finished': {
          const history = [event.payload, ...state.history.filter((item) => item.id !== event.payload.id)]
            .sort((a, b) => dayjs(b.startedAt).valueOf() - dayjs(a.startedAt).valueOf())
            .slice(0, 100);
          return { history };
        }
        default:
          return {};
      }
    });
  },
  markSocketConnected: (connected: boolean) => set({ socketConnected: connected }),
  setServerUrl: (url: string) => {
    const normalizedUrl = normalizeServerUrl(url);
    set({ serverUrl: normalizedUrl });
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SERVER_STORAGE_KEY, normalizedUrl);
      const session = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (session) {
        try {
          const parsed = JSON.parse(session);
          window.localStorage.setItem(
            SESSION_STORAGE_KEY,
            JSON.stringify({ ...parsed, serverUrl: normalizedUrl })
          );
        } catch {
          // ignore
        }
      }
    }
  },
  clearError: () => set({ error: undefined }),
}));

function useCommandStoreSelector<T>(selector: (state: StoreState) => T): T {
  return useCommandStore(selector);
}

function useHydrateSession() {
  const token = useCommandStoreSelector((state) => state.token);
  const fetchData = useCommandStoreSelector((state) => state.fetchData);

  useEffect(() => {
    if (token) {
      fetchData().catch(() => {
        /* errors handled in store */
      });
    }
  }, [token, fetchData]);
}

function useLiveEvents() {
  const serverUrl = useCommandStoreSelector((state) => state.serverUrl);
  const token = useCommandStoreSelector((state) => state.token);
  const integrateEvent = useCommandStoreSelector((state) => state.integrateEvent);
  const markSocketConnected = useCommandStoreSelector((state) => state.markSocketConnected);
  const status = useCommandStoreSelector((state) => state.status);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!serverUrl || !token || status === 'disconnected') {
      return;
    }

    const wsUrl = `${toWebSocketUrl(serverUrl)}?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;
    markSocketConnected(false);

    socket.addEventListener('open', () => {
      markSocketConnected(true);
    });

    socket.addEventListener('close', () => {
      markSocketConnected(false);
    });

    socket.addEventListener('error', () => {
      markSocketConnected(false);
    });

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data as string) as ServerEvent;
        integrateEvent(data);
      } catch (error) {
        console.warn('Unable to parse message from server', error);
      }
    });

    return () => {
      socketRef.current?.close();
      socketRef.current = null;
      markSocketConnected(false);
    };
  }, [serverUrl, token, status, integrateEvent, markSocketConnected]);
}

function StatusIndicator() {
  const status = useCommandStoreSelector((state) => state.status);
  const socketConnected = useCommandStoreSelector((state) => state.socketConnected);

  const label = useMemo(() => {
    if (status === 'disconnected') return 'Disconnected';
    if (!socketConnected) return 'Connecting…';
    return 'Live';
  }, [status, socketConnected]);

  const colorClass = useMemo(() => {
    if (status === 'disconnected') return 'bg-red-500/80';
    if (!socketConnected) return 'bg-amber-500/80';
    return 'bg-emerald-500/80';
  }, [status, socketConnected]);

  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold text-slate-900', colorClass)}>
      <span className="h-2 w-2 rounded-full bg-slate-900" />
      {label}
    </span>
  );
}

function LoginView() {
  const login = useCommandStoreSelector((state) => state.login);
  const setServerUrl = useCommandStoreSelector((state) => state.setServerUrl);
  const status = useCommandStoreSelector((state) => state.status);
  const loading = useCommandStoreSelector((state) => state.loading);
  const error = useCommandStoreSelector((state) => state.error);
  const clearError = useCommandStoreSelector((state) => state.clearError);
  const storedServerUrl = useCommandStoreSelector((state) => state.serverUrl);
  const [serverUrl, setServerUrlInput] = useState(storedServerUrl ?? '');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setServerUrlInput(storedServerUrl ?? '');
  }, [storedServerUrl]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearError();
    setSubmitting(true);
    try {
      setServerUrl(serverUrl);
      await login({ serverUrl, username, password });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col justify-center bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/70 p-8 shadow-xl backdrop-blur">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-white">Remote Command Center</h1>
          <p className="mt-2 text-sm text-slate-400">Connect to your secure command server</p>
        </div>
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </div>
        )}
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-300">Server address</span>
            <input
              value={serverUrl}
              onChange={(event) => setServerUrlInput(event.target.value)}
              onBlur={() => setServerUrl(serverUrl)}
              placeholder="https://command-center.local:6280"
              inputMode="url"
              className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
              required
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-300">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
              placeholder="admin"
              required
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-slate-300">Password</span>
            <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-4">
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                className="h-12 flex-1 bg-transparent text-sm text-slate-100 focus:outline-none"
                placeholder="••••••••"
                required
              />
              <button
                type="button"
                className="text-xs font-medium text-slate-400"
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          <button
            type="submit"
            className="mt-2 inline-flex h-12 items-center justify-center rounded-xl bg-accent font-semibold text-slate-900 transition hover:bg-accent/90 disabled:opacity-40"
            disabled={submitting || loading || status === 'connecting'}
          >
            {submitting || loading ? 'Connecting…' : 'Connect securely'}
          </button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-500">
          Built for mobile. Ensure the server app is online and reachable from your network.
        </p>
      </div>
    </div>
  );
}

function CommandCard({ command, onOpen }: { command: CommandDefinition; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/50 p-4 text-left transition hover:border-accent/60 hover:bg-slate-900/80"
    >
      <div className="flex items-start justify-between">
        <h3 className="text-base font-semibold text-white">{command.name}</h3>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300">
          {command.allowArguments ? 'Parameterized' : 'Fixed'}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-400">{command.description ?? 'No description provided'}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-400">
        <span className="rounded-full bg-slate-800/80 px-2 py-1 font-medium">{command.executable}</span>
        {command.tags.map((tag) => (
          <span key={tag} className="rounded-full bg-slate-800/40 px-2 py-1">#{tag}</span>
        ))}
      </div>
    </button>
  );
}

function CommandDetailSheet({
  command,
  onClose,
  onExecute,
  executing,
}: {
  command: CommandDefinition;
  onClose: () => void;
  onExecute: (parameters: string[]) => Promise<void>;
  executing: boolean;
}) {
  const [parameterInput, setParameterInput] = useState(command.args.join('\n'));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setParameterInput(command.args.join('\n'));
    setError(null);
  }, [command]);

  const handleExecute = async () => {
    setError(null);
    const parameters = parameterInput
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);

    if (!command.allowArguments && parameters.length && parameters.join(',') !== command.args.join(',')) {
      setError('This command does not accept custom parameters. Please reset to defaults.');
      return;
    }

    try {
      await onExecute(parameters);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger command');
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/70 px-4 pb-6">
      <div className="w-full max-w-lg rounded-3xl border border-slate-800 bg-slate-900/95 p-6">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">{command.name}</h2>
            <p className="text-xs text-slate-400">{command.description ?? 'No description provided'}</p>
          </div>
          <button className="text-sm text-slate-400" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-xs text-slate-400">
          <div className="font-mono text-slate-200">{command.executable}</div>
          {command.args.length > 0 && (
            <div className="mt-2">
              Default parameters: <span className="font-mono">{command.args.join(', ')}</span>
            </div>
          )}
        </div>

        <label className="mt-4 flex flex-col gap-2 text-sm text-slate-300">
          Runtime parameters
          <textarea
            className="min-h-[120px] rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
            placeholder="One parameter per line"
            value={parameterInput}
            disabled={!command.allowArguments}
            onChange={(event) => setParameterInput(event.target.value)}
          />
          {!command.allowArguments && (
            <span className="text-xs text-slate-500">
              Custom parameters are disabled for this command.
            </span>
          )}
        </label>

        {error && (
          <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={handleExecute}
          disabled={executing}
          className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-xl bg-accent font-semibold text-slate-900 transition hover:bg-accent/90 disabled:opacity-40"
        >
          {executing ? 'Dispatching…' : 'Execute command'}
        </button>
      </div>
    </div>
  );
}

function HistoryList() {
  const history = useCommandStoreSelector((state) => state.history);

  if (history.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-500">
        No command executions yet. Trigger a command to see output here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-slate-800">
      {history.map((record) => (
        <li key={record.id} className="py-4">
          <div className="flex items-center justify-between text-sm">
            <div>
              <p className="font-semibold text-white">{record.commandName}</p>
              <p className="text-xs text-slate-400">
                {dayjs(record.startedAt).format('MMM D, HH:mm:ss')} • {record.requestedBy}
              </p>
            </div>
            <span
              className={clsx('rounded-full px-3 py-1 text-xs font-semibold text-slate-900', {
                'bg-emerald-500/80': record.status === 'success',
                'bg-amber-500/80': record.status === 'running' || record.status === 'pending',
                'bg-red-500/80': record.status === 'error',
              })}
            >
              {record.status}
            </span>
          </div>
          {record.output && (
            <pre className="mt-3 max-h-40 overflow-auto rounded-xl bg-slate-950/60 p-3 text-xs text-slate-300">
              <code>{record.output}</code>
            </pre>
          )}
          {record.error && (
            <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {record.error}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function Dashboard() {
  const commands = useCommandStoreSelector((state) => state.commands);
  const logout = useCommandStoreSelector((state) => state.logout);
  const execute = useCommandStoreSelector((state) => state.execute);
  const loading = useCommandStoreSelector((state) => state.loading);
  const error = useCommandStoreSelector((state) => state.error);
  const clearError = useCommandStoreSelector((state) => state.clearError);
  const serverUrl = useCommandStoreSelector((state) => state.serverUrl);
  const [selectedCommand, setSelectedCommand] = useState<CommandDefinition | null>(null);
  const [executing, setExecuting] = useState(false);

  const handleExecute = useCallback(
    async (parameters: string[]) => {
      if (!selectedCommand) return;
      setExecuting(true);
      clearError();
      try {
        await execute(selectedCommand.id, parameters);
        setSelectedCommand(null);
      } finally {
        setExecuting(false);
      }
    },
    [execute, selectedCommand, clearError]
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 pb-24">
      <header className="sticky top-0 z-30 border-b border-slate-900/80 bg-slate-950/80 px-6 py-5 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Remote Command Center</p>
            <h1 className="text-xl font-semibold text-white">Remote client console</h1>
          </div>
          <div className="flex items-center gap-3">
            <StatusIndicator />
            <button
              className="rounded-full border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-400 transition hover:border-red-500/60 hover:text-red-300"
              onClick={logout}
            >
              Sign out
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500">Connected to {serverUrl}</p>
      </header>

      <main className="px-6">
        {error && (
          <div className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Available commands</h2>
            {loading && <span className="text-xs text-slate-400">Syncing…</span>}
          </div>
          {commands.length === 0 ? (
            <p className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 text-sm text-slate-400">
              No commands are available yet. Ask the server administrator to register commands.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 pb-6 sm:grid-cols-2">
              {commands.map((command) => (
                <CommandCard key={command.id} command={command} onOpen={() => setSelectedCommand(command)} />
              ))}
            </div>
          )}
        </section>

        <section className="mt-6 rounded-3xl border border-slate-900/80 bg-slate-950/60 p-6">
          <h2 className="text-lg font-semibold text-white">Recent activity</h2>
          <HistoryList />
        </section>
      </main>

      {selectedCommand && (
        <CommandDetailSheet
          command={selectedCommand}
          onClose={() => setSelectedCommand(null)}
          onExecute={handleExecute}
          executing={executing}
        />
      )}
    </div>
  );
}

export default function App() {
  const token = useCommandStoreSelector((state) => state.token);
  useHydrateSession();
  useLiveEvents();

  if (!token) {
    return <LoginView />;
  }

  return <Dashboard />;
}
