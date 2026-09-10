export type SystemInfoLoader = (signal?: AbortSignal) => Promise<void>;

export interface SystemInfoLoaderStart {
  loadId: number;
  load: SystemInfoLoader;
  /** Aborted exactly once when this run is superseded (replacement, clear, or a newer start). */
  signal: AbortSignal;
}

export interface SystemInfoLoaderController {
  readonly current: SystemInfoLoader | null;
  readonly loading: boolean;
  register(loader: SystemInfoLoader | null): boolean;
  clear(): boolean;
  start(opening: boolean): SystemInfoLoaderStart | null;
  complete(loadId: number): boolean;
}

/**
 * System-info loader lifecycle for the AppShell toolbar. A null report is the
 * reporting effect's cleanup churn (the body re-reports the same loader in
 * the same commit), so register ignores it while a loader is registered; a
 * same-reference re-report is churn too. Genuine removal goes through clear.
 * Every registration/removal bumps the load id, so a stale in-flight load's
 * completion can never clear loading started by a newer generation.
 */
export function createSystemInfoLoaderController(): SystemInfoLoaderController {
  let current: SystemInfoLoader | null = null;
  let loadId = 0;
  let loading = false;
  let activeAbort: AbortController | null = null;
  const abortActive = () => {
    if (activeAbort === null) return;
    activeAbort.abort();
    activeAbort = null;
  };
  return {
    get current() {
      return current;
    },
    get loading() {
      return loading;
    },
    register(loader) {
      if (loader === current) return false;
      if (loader === null && current !== null) return false;
      abortActive();
      loadId += 1;
      current = loader;
      loading = false;
      return true;
    },
    clear() {
      if (current === null) return false;
      abortActive();
      loadId += 1;
      current = null;
      loading = false;
      return true;
    },
    start(opening) {
      if (!opening || loading || current === null) return null;
      abortActive();
      loadId += 1;
      loading = true;
      const controller = new AbortController();
      activeAbort = controller;
      return { loadId, load: current, signal: controller.signal };
    },
    complete(id) {
      if (loadId !== id) return false;
      loading = false;
      activeAbort = null;
      return true;
    },
  };
}
