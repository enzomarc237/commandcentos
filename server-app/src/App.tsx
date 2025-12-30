import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import dayjs from 'dayjs';
import { useForm } from 'react-hook-form';
import clsx from 'clsx';

const isTauriRuntime = typeof window !== 'undefined' && '__TAURI_IPC__' in window;

export type CommandDefinition = {
  id: string;
  name: string;
  executable: string;
  args: string[];
  description?: string;
  tags?: string[];
  allowArguments: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ExecutionStatus = 'pending' | 'running' | 'success' | 'error';

export type ExecutionLog = {
  id: string;
  commandId: string;
  commandName: string;
  requestedBy: string;
  status: ExecutionStatus;
  output: string;
  error: string | null;
  parameters: string[];
  startedAt: string;
  finishedAt?: string;
};

export type CommandCenterEvent =
  | { type: 'command_created'; payload: CommandDefinition }
  | { type: 'command_updated'; payload: CommandDefinition }
  | { type: 'command_deleted'; payload: { id: string } }
  | { type: 'execution_started'; payload: ExecutionLog }
  | { type: 'execution_updated'; payload: ExecutionLog }
  | { type: 'execution_finished'; payload: ExecutionLog };

type CommandFormValues = {
  id?: string;
  name: string;
  executable: string;
  args: string;
  description?: string;
  tags?: string;
  allowArguments: boolean;
};

async function invokeOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime) {
    throw new Error('The server console must run inside the Tauri shell.');
  }
  return invoke<T>(cmd, args);
}

function useCommandCenterData() {
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [history, setHistory] = useState<ExecutionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setLoading(true);
      const [commandList, historyList] = await Promise.all([
        invokeOrThrow<CommandDefinition[]>('list_commands'),
        invokeOrThrow<ExecutionLog[]>('list_history'),
      ]);
      setCommands(commandList);
      setHistory(historyList);
      setError(null);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    let isMounted = true;

    const setupListener = async () => {
      const unlisten = await listen<CommandCenterEvent>('command-center://event', (event) => {
        if (!isMounted) {
          return;
        }
        const payload = event.payload;
        switch (payload.type) {
          case 'command_created':
          case 'command_updated': {
            setCommands((prev) => {
              const existingIndex = prev.findIndex((item) => item.id === payload.payload.id);
              if (existingIndex >= 0) {
                const next = [...prev];
                next.splice(existingIndex, 1, payload.payload);
                return next;
              }
              return [payload.payload, ...prev];
            });
            break;
          }
          case 'command_deleted': {
            setCommands((prev) => prev.filter((item) => item.id !== payload.payload.id));
            break;
          }
          case 'execution_started':
          case 'execution_updated':
          case 'execution_finished': {
            setHistory((prev) => {
              const existingIndex = prev.findIndex((item) => item.id === payload.payload.id);
              if (existingIndex >= 0) {
                const next = [...prev];
                next.splice(existingIndex, 1, payload.payload);
                return next;
              }
              return [payload.payload, ...prev].sort((a, b) =>
                dayjs(b.startedAt).valueOf() - dayjs(a.startedAt).valueOf()
              );
            });
            break;
          }
        }
      });
      return unlisten;
    };

    const unlistenPromise = setupListener();

    return () => {
      isMounted = false;
      unlistenPromise.then((unlisten) => {
        if (unlisten) {
          unlisten();
        }
      });
    };
  }, []);

  return {
    commands,
    setCommands,
    history,
    setHistory,
    loading,
    error,
    refresh,
  };
}

function CommandForm({
  onSubmit,
  onCancel,
  loading,
  initialData,
}: {
  onSubmit: (values: CommandFormValues) => Promise<void>;
  onCancel?: () => void;
  loading: boolean;
  initialData?: CommandDefinition | null;
}) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CommandFormValues>({
    defaultValues: initialData
      ? {
          id: initialData.id,
          name: initialData.name,
          executable: initialData.executable,
          args: initialData.args.join('\n'),
          description: initialData.description ?? '',
          tags: (initialData.tags ?? []).join(', '),
          allowArguments: initialData.allowArguments,
        }
      : {
          name: '',
          executable: '',
          args: '',
          description: '',
          tags: '',
          allowArguments: true,
        },
  });

  useEffect(() => {
    if (initialData) {
      reset({
        id: initialData.id,
        name: initialData.name,
        executable: initialData.executable,
        args: initialData.args.join('\n'),
        description: initialData.description ?? '',
        tags: (initialData.tags ?? []).join(', '),
        allowArguments: initialData.allowArguments,
      });
    }
  }, [initialData, reset]);

  const submitHandler = handleSubmit(async (values) => {
    await onSubmit(values);
    if (!initialData) {
      reset({
        name: '',
        executable: '',
        args: '',
        description: '',
        tags: '',
        allowArguments: watch('allowArguments'),
      });
    }
  });

  return (
    <form className="flex flex-col gap-4" onSubmit={submitHandler}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-slate-300">Command Name</span>
          <input
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="Reboot App Server"
            {...register('name', { required: 'Name is required' })}
          />
          {errors.name && <span className="text-xs text-danger">{errors.name.message}</span>}
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-slate-300">Executable</span>
          <input
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="/usr/bin/python3"
            {...register('executable', { required: 'Executable path is required' })}
          />
          {errors.executable && (
            <span className="text-xs text-danger">{errors.executable.message}</span>
          )}
        </label>
      </div>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-slate-300">Default Arguments</span>
        <textarea
          rows={3}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
          placeholder="--log-level=info"
          {...register('args')}
        />
        <span className="text-xs text-slate-500">One argument per line. Variables allowed via {{placeholder}}</span>
      </label>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-slate-300">Description</span>
          <textarea
            rows={3}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="Short description of what the command does"
            {...register('description')}
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-slate-300">Tags</span>
          <input
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
            placeholder="maintenance, deployments"
            {...register('tags')}
          />
          <span className="text-xs text-slate-500">Comma separated</span>
        </label>
      </div>
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-700 bg-slate-900"
          {...register('allowArguments')}
        />
        <span className="text-sm text-slate-300">Allow runtime arguments from remote clients</span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow transition hover:bg-primary/90"
          disabled={isSubmitting || loading}
        >
          {initialData ? 'Save changes' : 'Create command'}
        </button>
        {initialData && (
          <button
            type="button"
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-800"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function StatusBadge({ status }: { status: ExecutionStatus }) {
  const label = useMemo(() => {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'running':
        return 'Running';
      case 'success':
        return 'Success';
      case 'error':
        return 'Failed';
      default:
        return status;
    }
  }, [status]);

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold',
        status === 'pending' && 'bg-slate-800 text-slate-200',
        status === 'running' && 'bg-primary/20 text-primary',
        status === 'success' && 'bg-success/20 text-success',
        status === 'error' && 'bg-danger/20 text-danger'
      )}
    >
      {label}
    </span>
  );
}

export default function App() {
  const { commands, setCommands, history, loading, error, refresh } = useCommandCenterData();
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [selectedCommand, setSelectedCommand] = useState<CommandDefinition | null>(null);
  const [executionMessage, setExecutionMessage] = useState<string | null>(null);
  const [busyCommandId, setBusyCommandId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const filteredCommands = useMemo(() => {
    if (!filter.trim()) {
      return commands;
    }
    const lower = filter.toLowerCase();
    return commands.filter((command) => {
      return (
        command.name.toLowerCase().includes(lower) ||
        command.executable.toLowerCase().includes(lower) ||
        (command.tags ?? []).some((tag) => tag.toLowerCase().includes(lower))
      );
    });
  }, [commands, filter]);

  const handleFormSubmit = async (values: CommandFormValues) => {
    try {
      const payload = {
        id: values.id,
        name: values.name,
        executable: values.executable,
        args: values.args
          .split('\n')
          .map((arg) => arg.trim())
          .filter(Boolean),
        description: values.description?.trim().length ? values.description.trim() : null,
        tags: values.tags
          ?.split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        allow_arguments: values.allowArguments,
      };
      const saved = await invokeOrThrow<CommandDefinition>('create_or_update_command', payload);
      setCommands((prev) => {
        const index = prev.findIndex((item) => item.id === saved.id);
        if (index >= 0) {
          const copy = [...prev];
          copy.splice(index, 1, saved);
          return copy;
        }
        return [saved, ...prev];
      });
      setFormMode('create');
      setSelectedCommand(null);
      setExecutionMessage('Command saved successfully');
    } catch (err) {
      console.error(err);
      setExecutionMessage(err instanceof Error ? err.message : 'Failed to save command');
    }
  };

  const handleEdit = (command: CommandDefinition) => {
    setFormMode('edit');
    setSelectedCommand(command);
    setExecutionMessage(null);
  };

  const handleDelete = async (command: CommandDefinition) => {
    try {
      await invokeOrThrow<void>('delete_command', { id: command.id });
      setCommands((prev) => prev.filter((item) => item.id !== command.id));
      setExecutionMessage('Command deleted');
      if (selectedCommand?.id === command.id) {
        setSelectedCommand(null);
        setFormMode('create');
      }
    } catch (err) {
      console.error(err);
      setExecutionMessage(err instanceof Error ? err.message : 'Failed to delete command');
    }
  };

  const handleExecute = async (command: CommandDefinition) => {
    try {
      setBusyCommandId(command.id);
      setExecutionMessage(null);
      const record = await invokeOrThrow<ExecutionLog>('execute_command', {
        id: command.id,
        args: command.allowArguments ? command.args : undefined,
        requested_by: 'local-admin',
      });
      setExecutionMessage(`Execution ${record.id} queued`);
    } catch (err) {
      console.error(err);
      setExecutionMessage(err instanceof Error ? err.message : 'Failed to execute command');
    } finally {
      setBusyCommandId(null);
    }
  };

  const resetForm = () => {
    setSelectedCommand(null);
    setFormMode('create');
    setExecutionMessage(null);
  };

  return (
    <div className="flex h-screen flex-col bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">Remote Command Center</h1>
            <p className="text-sm text-slate-400">Server console • Secure macOS orchestration</p>
          </div>
          <button
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800"
            onClick={refresh}
          >
            Refresh data
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 overflow-hidden px-6 py-6">
        {!isTauriRuntime && (
          <div className="rounded-lg border border-amber-600/60 bg-amber-500/10 p-4 text-sm text-amber-300">
            The server console is designed to run inside the native Tauri shell. Local preview mode
            is limited.
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
            {error}
          </div>
        )}
        {executionMessage && (
          <div className="rounded-lg border border-primary/40 bg-primary/10 p-4 text-sm text-primary">
            {executionMessage}
          </div>
        )}
        <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-[420px_minmax(0,1fr)]">
          <section className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {formMode === 'create' ? 'Create command' : 'Edit command'}
              </h2>
              {formMode === 'edit' && (
                <button
                  className="text-sm text-primary hover:underline"
                  onClick={resetForm}
                >
                  New command
                </button>
              )}
            </div>
            <CommandForm
              onSubmit={handleFormSubmit}
              onCancel={formMode === 'edit' ? resetForm : undefined}
              loading={loading}
              initialData={selectedCommand}
            />
          </section>

          <section className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/60">
            <div className="flex flex-col gap-4 border-b border-slate-800 p-6 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">Registered commands</h2>
                <p className="text-sm text-slate-400">
                  Manage command catalog and monitor execution history.
                </p>
              </div>
              <input
                className="w-full max-w-xs rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Search commands"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>

            <div className="flex h-full flex-col overflow-hidden">
              <div className="flex-1 overflow-auto">
                <table className="min-w-full divide-y divide-slate-800">
                  <thead className="bg-slate-900/80">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Name
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Command
                      </th>
                      <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 lg:table-cell">
                        Tags
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {filteredCommands.map((command) => (
                      <tr key={command.id} className="hover:bg-slate-800/40">
                        <td className="px-4 py-4 text-sm text-slate-200">
                          <div className="font-semibold text-white">{command.name}</div>
                          <div className="text-xs text-slate-400">
                            Updated {dayjs(command.updatedAt).format('MMM D, YYYY HH:mm')}
                          </div>
                        </td>
                        <td className="px-4 py-4 text-sm text-slate-300">
                          <code className="rounded bg-slate-900 px-2 py-1 text-xs text-slate-200">
                            {command.executable}
                          </code>
                          {command.args.length > 0 && (
                            <div className="mt-1 text-xs text-slate-400">
                              Args: {command.args.join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="hidden px-4 py-4 text-sm text-slate-300 lg:table-cell">
                          <div className="flex flex-wrap gap-2">
                            {(command.tags ?? []).map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full bg-slate-800/80 px-2 py-1 text-xs text-slate-200"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-4 text-sm">
                          <div className="flex flex-row flex-wrap gap-2">
                            <button
                              className="rounded-lg border border-slate-700 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800"
                              onClick={() => handleEdit(command)}
                            >
                              Edit
                            </button>
                            <button
                              className="rounded-lg border border-danger/60 px-3 py-1 text-xs font-medium text-danger hover:bg-danger/10"
                              onClick={() => handleDelete(command)}
                            >
                              Delete
                            </button>
                            <button
                              className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                              onClick={() => handleExecute(command)}
                              disabled={busyCommandId === command.id}
                            >
                              {busyCommandId === command.id ? 'Running…' : 'Execute'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredCommands.length === 0 && (
                      <tr>
                        <td className="px-4 py-6 text-center text-sm text-slate-400" colSpan={4}>
                          {loading ? 'Loading commands…' : 'No commands registered yet'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-slate-800">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-slate-300 hover:bg-slate-800/60">
                    Execution history
                    <span className="text-xs text-slate-500">(latest 50 records)</span>
                  </summary>
                  <div className="max-h-72 overflow-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                        <tr>
                          <th className="px-4 py-2 text-left">Command</th>
                          <th className="px-4 py-2 text-left">Status</th>
                          <th className="px-4 py-2 text-left">Requested by</th>
                          <th className="px-4 py-2 text-left">Started</th>
                          <th className="px-4 py-2 text-left">Finished</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {history.map((record) => (
                          <tr key={record.id} className="hover:bg-slate-800/40">
                            <td className="px-4 py-2 text-slate-200">{record.commandName}</td>
                            <td className="px-4 py-2">
                              <StatusBadge status={record.status} />
                            </td>
                            <td className="px-4 py-2 text-slate-400">{record.requestedBy}</td>
                            <td className="px-4 py-2 text-slate-400">
                              {dayjs(record.startedAt).format('MMM D, HH:mm:ss')}
                            </td>
                            <td className="px-4 py-2 text-slate-400">
                              {record.finishedAt
                                ? dayjs(record.finishedAt).format('MMM D, HH:mm:ss')
                                : '—'}
                            </td>
                          </tr>
                        ))}
                        {history.length === 0 && (
                          <tr>
                            <td className="px-4 py-4 text-center text-slate-400" colSpan={5}>
                              No executions recorded yet.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
