import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseClient, isSupabaseConfigured } from "./supabaseClient.js";

const LEGACY_KEYS = {
  trades: "td_trades",
  portfolio: "td_portfolio",
  regime: "td_regime",
  regimeSince: "td_regime_since",
};

const LOCAL_SNAPSHOT_KEY = "td_app_snapshot_v1";
const CLOUD_SYNC_META_KEY = "td_cloud_sync_meta_v1";
const CLOUD_TABLE = "app_state";
const SYNC_DEBOUNCE_MS = 1000;
const SYNC_RETRY_INTERVAL_MS = 30000;

const DEFAULT_SNAPSHOT = {
  trades: [],
  portfolio: 100000,
  regime: "bull",
  regimeSince: null,
  updatedAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

function safeParseJson(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readJson(key, fallback) {
  try {
    return safeParseJson(localStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage write failures.
  }
}

function hasLegacyData() {
  try {
    return Object.values(LEGACY_KEYS).some((key) => localStorage.getItem(key) !== null);
  } catch {
    return false;
  }
}

function toNumberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSnapshot(input, options = {}) {
  const { ensureUpdatedAt = true } = options;
  const source = input && typeof input === "object" ? input : {};
  const snapshot = {
    trades: Array.isArray(source.trades) ? source.trades : [],
    portfolio: toNumberOrDefault(source.portfolio, DEFAULT_SNAPSHOT.portfolio),
    regime: typeof source.regime === "string" && source.regime
      ? source.regime
      : DEFAULT_SNAPSHOT.regime,
    regimeSince: typeof source.regimeSince === "string" && source.regimeSince
      ? source.regimeSince
      : null,
    updatedAt: typeof source.updatedAt === "string" && source.updatedAt
      ? source.updatedAt
      : null,
  };

  if (ensureUpdatedAt && !snapshot.updatedAt) {
    snapshot.updatedAt = nowIso();
  }

  return snapshot;
}

function loadLocalSnapshot() {
  const snapshot = readJson(LOCAL_SNAPSHOT_KEY, null);
  if (snapshot && typeof snapshot === "object") {
    return {
      snapshot: normalizeSnapshot(snapshot),
      hasLocalData: true,
    };
  }

  const hasLegacy = hasLegacyData();
  const legacySnapshot = normalizeSnapshot(
    {
      trades: readJson(LEGACY_KEYS.trades, DEFAULT_SNAPSHOT.trades),
      portfolio: readJson(LEGACY_KEYS.portfolio, DEFAULT_SNAPSHOT.portfolio),
      regime: readJson(LEGACY_KEYS.regime, DEFAULT_SNAPSHOT.regime),
      regimeSince: readJson(LEGACY_KEYS.regimeSince, DEFAULT_SNAPSHOT.regimeSince),
      updatedAt: hasLegacy ? nowIso() : null,
    },
    { ensureUpdatedAt: hasLegacy },
  );

  return {
    snapshot: hasLegacy ? legacySnapshot : normalizeSnapshot(DEFAULT_SNAPSHOT),
    hasLocalData: hasLegacy,
  };
}

function persistLocalSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  writeJson(LEGACY_KEYS.trades, normalized.trades);
  writeJson(LEGACY_KEYS.portfolio, normalized.portfolio);
  writeJson(LEGACY_KEYS.regime, normalized.regime);
  writeJson(LEGACY_KEYS.regimeSince, normalized.regimeSince);
  writeJson(LOCAL_SNAPSHOT_KEY, normalized);
}

function resolveUpdater(updater, currentValue) {
  return typeof updater === "function" ? updater(currentValue) : updater;
}

function toTimestamp(value) {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function writeSyncMeta(patch, userId) {
  const current = readJson(CLOUD_SYNC_META_KEY, {});
  writeJson(CLOUD_SYNC_META_KEY, {
    ...current,
    ...patch,
    userId: userId ?? current.userId ?? null,
    metaUpdatedAt: nowIso(),
  });
}

async function ensureAnonymousUserId(supabase) {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;

  let session = sessionData?.session ?? null;
  if (!session) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    session = data?.session ?? null;
  }

  if (session?.user?.id) return session.user.id;

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData?.user?.id) {
    throw new Error("Supabase anonymous user unavailable.");
  }
  return userData.user.id;
}

export function useSyncedAppState() {
  const initialRef = useRef(loadLocalSnapshot());
  const supabaseRef = useRef(getSupabaseClient());
  const [snapshot, setSnapshot] = useState(initialRef.current.snapshot);
  const [cloudSync, setCloudSync] = useState(() => ({
    enabled: isSupabaseConfigured(),
    ready: !isSupabaseConfigured(),
    lastSyncedAt: null,
    error: null,
  }));

  const snapshotRef = useRef(snapshot);
  const cloudSyncRef = useRef(cloudSync);
  const userIdRef = useRef(null);
  const hasLocalDataRef = useRef(initialRef.current.hasLocalData);
  const pendingSyncRef = useRef(false);
  const bootstrappedRef = useRef(!isSupabaseConfigured());
  const debounceTimerRef = useRef(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    cloudSyncRef.current = cloudSync;
  }, [cloudSync]);

  const updateCloudSyncState = useCallback((patch) => {
    setCloudSync((prev) => ({ ...prev, ...patch }));
    writeSyncMeta(patch, userIdRef.current);
  }, []);

  const applyRemoteSnapshot = useCallback((remotePayload, remoteUpdatedAt = null) => {
    const nextSnapshot = normalizeSnapshot(
      {
        ...(remotePayload || {}),
        updatedAt: remotePayload?.updatedAt || remoteUpdatedAt || nowIso(),
      },
      { ensureUpdatedAt: true },
    );
    pendingSyncRef.current = false;
    hasLocalDataRef.current = true;
    persistLocalSnapshot(nextSnapshot);
    setSnapshot(nextSnapshot);
  }, []);

  const pushSnapshotToCloud = useCallback(async (supabase, userId, localSnapshot) => {
    const { error } = await supabase.from(CLOUD_TABLE).upsert(
      {
        user_id: userId,
        payload: localSnapshot,
        updated_at: nowIso(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;
  }, []);

  const flushPendingSync = useCallback(async () => {
    const supabase = supabaseRef.current;
    if (!supabase) return false;
    if (!bootstrappedRef.current || !cloudSyncRef.current.ready) return false;
    if (!pendingSyncRef.current) return false;
    if (typeof navigator !== "undefined" && !navigator.onLine) return false;
    if (!userIdRef.current) return false;

    const localSnapshot = snapshotRef.current;
    try {
      const { data: remoteRow, error: fetchError } = await supabase
        .from(CLOUD_TABLE)
        .select("payload,updated_at")
        .eq("user_id", userIdRef.current)
        .maybeSingle();
      if (fetchError) throw fetchError;

      if (remoteRow) {
        const remotePayload = normalizeSnapshot(remoteRow.payload, { ensureUpdatedAt: false });
        const remoteUpdatedAt = remotePayload.updatedAt || remoteRow.updated_at || null;
        if (toTimestamp(remoteUpdatedAt) > toTimestamp(localSnapshot.updatedAt)) {
          applyRemoteSnapshot(remotePayload, remoteUpdatedAt);
          updateCloudSyncState({ error: null, lastSyncedAt: nowIso() });
          return true;
        }
      }

      await pushSnapshotToCloud(supabase, userIdRef.current, localSnapshot);
      pendingSyncRef.current = false;
      updateCloudSyncState({ error: null, lastSyncedAt: nowIso() });
      return true;
    } catch (error) {
      pendingSyncRef.current = true;
      updateCloudSyncState({
        error: error?.message || "Cloud sync failed",
      });
      return false;
    }
  }, [applyRemoteSnapshot, pushSnapshotToCloud, updateCloudSyncState]);

  const scheduleDebouncedSync = useCallback(() => {
    if (!pendingSyncRef.current) return;
    if (!cloudSyncRef.current.enabled || !cloudSyncRef.current.ready) return;
    if (!bootstrappedRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      void flushPendingSync();
    }, SYNC_DEBOUNCE_MS);
  }, [flushPendingSync]);

  const updateLocalSnapshot = useCallback((producer) => {
    setSnapshot((previous) => {
      const nextValue = producer(previous);
      const nextSnapshot = normalizeSnapshot({ ...nextValue, updatedAt: nowIso() });
      hasLocalDataRef.current = true;
      pendingSyncRef.current = true;
      persistLocalSnapshot(nextSnapshot);
      return nextSnapshot;
    });
  }, []);

  const setTrades = useCallback((updater) => {
    updateLocalSnapshot((previous) => ({
      ...previous,
      trades: resolveUpdater(updater, previous.trades),
    }));
  }, [updateLocalSnapshot]);

  const setPortfolio = useCallback((updater) => {
    updateLocalSnapshot((previous) => ({
      ...previous,
      portfolio: toNumberOrDefault(resolveUpdater(updater, previous.portfolio), previous.portfolio),
    }));
  }, [updateLocalSnapshot]);

  const setRegime = useCallback((updater) => {
    updateLocalSnapshot((previous) => ({
      ...previous,
      regime: resolveUpdater(updater, previous.regime),
    }));
  }, [updateLocalSnapshot]);

  const setRegimeSince = useCallback((updater) => {
    updateLocalSnapshot((previous) => {
      const value = resolveUpdater(updater, previous.regimeSince);
      return {
        ...previous,
        regimeSince: typeof value === "string" && value ? value : null,
      };
    });
  }, [updateLocalSnapshot]);

  useEffect(() => {
    scheduleDebouncedSync();
  }, [snapshot.updatedAt, cloudSync.ready, cloudSync.enabled, scheduleDebouncedSync]);

  useEffect(() => {
    const supabase = supabaseRef.current;
    if (!supabase) {
      bootstrappedRef.current = true;
      updateCloudSyncState({ enabled: false, ready: true, error: null });
      return undefined;
    }

    let cancelled = false;

    const bootstrap = async () => {
      try {
        const userId = await ensureAnonymousUserId(supabase);
        if (cancelled) return;

        userIdRef.current = userId;
        const localSnapshot = snapshotRef.current;
        const localUpdatedAt = toTimestamp(localSnapshot.updatedAt);

        const { data: remoteRow, error: fetchError } = await supabase
          .from(CLOUD_TABLE)
          .select("payload,updated_at")
          .eq("user_id", userId)
          .maybeSingle();
        if (fetchError) throw fetchError;
        if (cancelled) return;

        if (!remoteRow && hasLocalDataRef.current) {
          await pushSnapshotToCloud(supabase, userId, localSnapshot);
        } else if (remoteRow) {
          const remotePayload = normalizeSnapshot(remoteRow.payload, { ensureUpdatedAt: false });
          const remoteUpdatedAt = remotePayload.updatedAt || remoteRow.updated_at || null;
          if (toTimestamp(remoteUpdatedAt) > localUpdatedAt) {
            applyRemoteSnapshot(remotePayload, remoteUpdatedAt);
          } else if (hasLocalDataRef.current && localUpdatedAt > toTimestamp(remoteUpdatedAt)) {
            await pushSnapshotToCloud(supabase, userId, localSnapshot);
          }
        }

        pendingSyncRef.current = false;
        bootstrappedRef.current = true;
        updateCloudSyncState({
          enabled: true,
          ready: true,
          error: null,
          lastSyncedAt: nowIso(),
        });
      } catch (error) {
        if (cancelled) return;
        bootstrappedRef.current = true;
        updateCloudSyncState({
          enabled: true,
          ready: true,
          error: error?.message || "Supabase bootstrap failed",
        });
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [applyRemoteSnapshot, pushSnapshotToCloud, updateCloudSyncState]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleOnline = () => {
      if (pendingSyncRef.current) {
        void flushPendingSync();
      }
    };

    const intervalId = window.setInterval(() => {
      if (pendingSyncRef.current) {
        void flushPendingSync();
      }
    }, SYNC_RETRY_INTERVAL_MS);

    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.clearInterval(intervalId);
    };
  }, [flushPendingSync]);

  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  }, []);

  return {
    regime: snapshot.regime,
    setRegime,
    regimeSince: snapshot.regimeSince,
    setRegimeSince,
    portfolio: snapshot.portfolio,
    setPortfolio,
    trades: snapshot.trades,
    setTrades,
    cloudSync,
  };
}

