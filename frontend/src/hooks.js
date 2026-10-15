import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data with loading + error state. Re-runs when `deps` change; `reload()` forces a refresh.
 * `silent` reloads (used by polling) do not flip the page back into the loading state.
 */
export function useApi(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async ({ silent = false } = {}) => {
    const id = ++seq.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetcherRef.current();
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ data: silent ? s.data : null, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    run();
    return () => {
      seq.current += 1; // ignore responses that arrive after unmount / dependency change
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload: run };
}

export function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Runs `fn` every `ms` while `active` is true (used to watch running campaigns). */
export function usePolling(fn, ms, active) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}

export function useDocumentTitle(title) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

/** Simple controlled-form helper that also holds server-side field errors. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = useCallback((name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  }, []);
  const bind = (name) => ({
    value: values[name] ?? '',
    onChange: (e) => set(name, e.target.type === 'checkbox' ? e.target.checked : e.target.value),
  });
  return { values, setValues, errors, setErrors, set, bind };
}
