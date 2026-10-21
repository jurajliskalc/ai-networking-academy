import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { emptyProgress, sanitize, STORAGE_KEY, type Progress } from './progress';

interface Store {
  progress: Progress;
  update: (fn: (p: Progress) => Progress) => void;
  replace: (p: Progress) => void;
}

const Ctx = createContext<Store | null>(null);

function load(): Progress {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return emptyProgress();
  }
}

export function applyTheme(theme: Progress['settings']['theme']) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function ProgressProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<Progress>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch {
      /* private mode or quota: progress simply is not persisted */
    }
  }, [progress]);

  useEffect(() => {
    applyTheme(progress.settings.theme);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(progress.settings.theme);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [progress.settings.theme]);

  // Keep several open tabs in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === STORAGE_KEY && setProgress(load());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((fn: (p: Progress) => Progress) => setProgress((p) => fn(p)), []);
  const replace = useCallback((p: Progress) => setProgress(sanitize(p)), []);
  const value = useMemo(() => ({ progress, update, replace }), [progress, update, replace]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProgress(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useProgress outside ProgressProvider');
  return s;
}
