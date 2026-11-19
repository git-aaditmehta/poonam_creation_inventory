import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { api } from './api';
import type { User, InventoryCategory, BaseInventoryItem } from './types';
import { ToastProvider, useToast } from './context/ToastContext';
import { localDb } from './lib/localDb';
import { syncEngine, type SyncStatus } from './lib/syncEngine';
import { LoginView } from './components/LoginView';
import { Navigation, TopHeader, type ActiveTab } from './components/Navigation';
import { PlatedJewelryView } from './components/PlatedJewelryView';
import { RawJewelryView } from './components/RawJewelryView';
import { StonesView } from './components/StonesView';
import { FoilView } from './components/FoilView';
import { StockOperationsView } from './components/StockOperationsView';
import { LowStockView } from './components/LowStockView';
const TransactionHistoryView = lazy(() => import('./components/TransactionHistoryView').then((m) => ({ default: m.TransactionHistoryView })));
const ExcelImportView = lazy(() => import('./components/ExcelImportView').then((m) => ({ default: m.ExcelImportView })));
import { StaffManagementView } from './components/StaffManagementView';
const BackupView = lazy(() => import('./components/BackupView').then((m) => ({ default: m.BackupView })));
import { SyncQueueView } from './components/SyncQueueView';
const CostingCloudGate = lazy(() => import('./components/CostingCloudGate').then((m) => ({ default: m.CostingCloudGate })));
const CostingView = lazy(() => import('./components/CostingView').then((m) => ({ default: m.CostingView })));
const CostingMaterialsView = lazy(() => import('./components/CostingMaterialsView').then((m) => ({ default: m.CostingMaterialsView })));
import { SyncStatusBar } from './components/SyncStatusBar';
const ScanJewelryView = lazy(() => import('./components/ScanJewelryView').then((m) => ({ default: m.ScanJewelryView })));
const ScanDinoView = lazy(() => import('./components/ScanDinoView').then((m) => ({ default: m.ScanDinoView })));
import { ErrorBoundary } from './components/ErrorBoundary';
import { LLAMA_SCAN_ENABLED } from './config/features';
import { saveLastUser, loadLastUser, clearLastUser, hasStoredToken, getQueueOwner, setQueueOwner } from './lib/lastUser';
import { getPendingCount } from './lib/pendingOps';
import { applyAppUpdate } from './lib/serviceWorker';
import { syncGridPhotos, requestPersistentStorage } from './lib/photoOffline';
import { dailyLimitMessage } from './utils/friendlyErrors';
import { startCostingSync, stopCostingSync, syncCostingNow, costingWaitingCount, clearLocalCosting } from './lib/costingSync';
import { Loader2 } from 'lucide-react';

const AppContent: React.FC = () => {
  const { showToast } = useToast();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('plated');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem('sidebar_collapsed') === 'true';
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(syncEngine.status);

  const handleSetSidebarCollapsed = (collapsed: boolean | ((prev: boolean) => boolean)) => {
    setSidebarCollapsed((prev) => {
      const next = typeof collapsed === 'function' ? collapsed(prev) : collapsed;
      localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    });
  };

  // Quick action prefill state for Stock Operations
  const [opCategory, setOpCategory] = useState<InventoryCategory>('plated_jewelry');
  const [opItem, setOpItem] = useState<BaseInventoryItem | null>(null);

  // Initialize localDb worker on app start (once)
  useEffect(() => {
    localDb.init();
  }, []);

  /**
   * Forget the signed-out user's inventory copy on this phone (Costing is kept: it is the owner's local data).
   * `keepPendingOps` (expired login): unsent offline stock changes survive until someone logs in again.
   */
  const wipeLocalSession = useCallback(async (keepPendingOps = false) => {
    syncEngine.stop();
    clearLastUser();
    if (!keepPendingOps) setQueueOwner(null);
    try {
      await localDb.ready;
      await localDb.clearAll({ keepPendingOps });
    } catch {
      /* ignore */
    }
  }, []);

  /** A verified login: remember the user; drop a queue left behind by a DIFFERENT user. */
  const acceptVerifiedUser = useCallback(async (user: User) => {
    saveLastUser(user);
    const owner = getQueueOwner();
    if (owner && owner !== user.id) {
      try {
        await localDb.ready;
        await localDb.exec('DELETE FROM pending_ops');
        await clearLocalCosting(); // a different person on this phone never sees the previous owner's Costing
      } catch {
        /* ignore */
      }
    }
    setQueueOwner(user.id);
    setCurrentUser(user);
  }, []);

  // Verify the login. Opens INSTANTLY with the last verified user (works offline) and checks in the
  // background; only a real "not valid" answer from the server (401) logs out — never a missing network.
  const checkSession = useCallback(async () => {
    const cached = hasStoredToken() ? loadLastUser() : null;
    if (cached) {
      setCurrentUser((prev) => prev ?? cached);
      setIsInitializing(false);
    }
    if (!hasStoredToken()) {
      setCurrentUser(null);
      setIsInitializing(false);
      return;
    }
    try {
      const res = await api.auth.me();
      await acceptVerifiedUser(res.user);
    } catch (err: any) {
      if (err?.status === 401 || err?.status === 403) {
        // The 401 handler (auth-unauthorized) clears the token and local data
        setCurrentUser(null);
      } else if (!cached) {
        // No network and never verified on this phone: the login screen is the only option
        setCurrentUser(null);
      }
      // else: offline / server unreachable → keep working with the cached user
    } finally {
      setIsInitializing(false);
    }
  }, [acceptVerifiedUser]);

  useEffect(() => {
    checkSession();

    const handleUnauthorized = () => {
      wipeLocalSession(true); // keep unsent stock changes for the same user's next login
      setCurrentUser(null);
    };
    // Back online after an offline start: confirm the login is still valid
    const handleOnline = () => {
      if (hasStoredToken()) checkSession();
    };
    window.addEventListener('auth-unauthorized', handleUnauthorized);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('auth-unauthorized', handleUnauthorized);
      window.removeEventListener('online', handleOnline);
    };
  }, [checkSession, wipeLocalSession]);

  // Every grid photo kept on this phone (also offline): after login, after each sync, when back online.
  // Storage is requested as permanent so the browser does not silently clear photos or offline data.
  useEffect(() => {
    if (!currentUser) return;
    requestPersistentStorage();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => syncGridPhotos(), delay);
    };
    schedule(1500);
    const onChange = () => schedule(3000);
    const onOnline = () => schedule(1000);
    window.addEventListener('localdb-change', onChange);
    window.addEventListener('online', onOnline);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('localdb-change', onChange);
      window.removeEventListener('online', onOnline);
    };
  }, [currentUser]);

  // The cloud's free daily limit is used up: tell the user once (per 30 min) what that means and when it renews
  useEffect(() => {
    let lastShown = 0;
    const onLimit = (e: Event) => {
      if (Date.now() - lastShown < 30 * 60_000) return;
      lastShown = Date.now();
      showToast(
        'warning',
        'Cloud daily limit reached',
        `${dailyLimitMessage({ data: (e as CustomEvent).detail })} Stock in/out and Costing changes stay on this phone and upload automatically then.`
      );
    };
    window.addEventListener('cloud-daily-limit', onLimit);
    return () => window.removeEventListener('cloud-daily-limit', onLimit);
  }, [showToast]);

  // A new app version has been downloaded in the background
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener('app-update-available', onUpdate);
    return () => window.removeEventListener('app-update-available', onUpdate);
  }, []);

  // Costing: synced with the cloud on the owner's devices only. Staff devices never keep Costing data.
  useEffect(() => {
    if (!currentUser) return;
    if (currentUser.role === 'owner') {
      startCostingSync();
    } else {
      stopCostingSync();
      clearLocalCosting().catch(() => undefined);
    }
    return () => stopCostingSync();
  }, [currentUser]);

  useEffect(() => {
    const onNotice = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      showToast(d.type || 'info', d.title || 'Costing', d.message || '');
    };
    window.addEventListener('costing-notice', onNotice);
    return () => window.removeEventListener('costing-notice', onNotice);
  }, [showToast]);

  // A stock change made on this phone was refused by the server and has been undone: say so clearly
  useEffect(() => {
    const onRejected = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const what = d.operation === 'add' ? `Adding ${d.quantity}` : `Removing ${d.quantity}`;
      showToast(
        'error',
        `Stock change undone: ${d.itemId ?? 'item'}`,
        `${what} was refused (${d.message}). The stock shown now is the real stock. Details in Sync Queue.`
      );
    };
    window.addEventListener('stock-op-rejected', onRejected);
    return () => window.removeEventListener('stock-op-rejected', onRejected);
  }, [showToast]);

  // Start sync engine when user is logged in, stop on logout
  useEffect(() => {
    if (!currentUser) {
      syncEngine.stop();
      return;
    }

    // Wait for localDb to be ready, then start sync
    localDb.ready.then(() => {
      syncEngine.start();
    }).catch((err) => {
      console.error('[App] Failed to start sync engine:', err);
    });

    const unsub = syncEngine.subscribe(setSyncStatus);
    return () => {
      unsub();
    };
  }, [currentUser]);

  // Update low stock count from local DB when data changes
  const updateLowStockCount = useCallback(async () => {
    if (!currentUser || currentUser.role !== 'owner') return;
    try {
      // Try reading from local DB first (instant)
      await localDb.ready;
      const lowStockItems = await localDb.getLowStockItems();
      setLowStockCount(lowStockItems.length);
    } catch {
      // Fallback to API
      try {
        const res = await api.inventory.getLowStock();
        setLowStockCount(res.total);
      } catch { /* ignore */ }
    }
  }, [currentUser]);

  useEffect(() => {
    updateLowStockCount();

    // Re-check when local data changes (sync complete)
    const handler = () => updateLowStockCount();
    window.addEventListener('localdb-change', handler);
    return () => window.removeEventListener('localdb-change', handler);
  }, [updateLowStockCount]);

  const handleLogout = async () => {
    // Logging out must reach the server (so the login is cancelled there too)
    if (!navigator.onLine) {
      showToast('warning', 'You are offline', 'Logging out needs internet. Everything else keeps working offline.');
      return;
    }
    // Unsent offline stock changes would be lost: try to send them first, then ask
    try {
      if ((await getPendingCount()) > 0) await syncEngine.triggerSync();
      if (currentUser?.role === 'owner') await syncCostingNow();
      const left = await getPendingCount();
      const leftCosting = currentUser?.role === 'owner' ? await costingWaitingCount() : 0;
      if (left + leftCosting > 0) {
        const parts = [
          left > 0 ? `${left} stock change(s)` : '',
          leftCosting > 0 ? `${leftCosting} Costing change(s)` : '',
        ].filter(Boolean).join(' and ');
        if (!window.confirm(`${parts} on this phone have not reached the cloud yet (see Sync Queue). Log out anyway and lose them?`)) {
          return;
        }
      }
    } catch {
      /* local DB unavailable: nothing to lose */
    }
    try {
      await api.auth.logout();
    } catch (err: any) {
      if (err?.status !== 401) {
        showToast('error', 'Logout Failed', err.message);
        return;
      }
    }
    await wipeLocalSession();
    stopCostingSync();
    try {
      await clearLocalCosting(); // it is in the cloud; nothing of the owner's costs stays on this phone
    } catch {
      /* ignore */
    }
    setCurrentUser(null);
    showToast('info', 'Logged Out', 'You have been signed out.');
  };

  const handleQuickOperate = (category: InventoryCategory, item: BaseInventoryItem) => {
    setOpCategory(category);
    setOpItem(item);
    setActiveTab('operations');
  };

  if (isInitializing) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-base)',
          color: 'var(--text-primary)',
        }}
      >
        <Loader2 size={36} className="animate-spin" color="var(--teal-deep)" />
        <div style={{ marginTop: 16, fontSize: 14, color: 'var(--text-secondary)' }}>
          Connecting to Poonam Creation...
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <LoginView
        onLoginSuccess={(user) => {
          acceptVerifiedUser(user);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      <Navigation
        user={currentUser}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onLogout={handleLogout}
        lowStockCount={lowStockCount}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={handleSetSidebarCollapsed}
        mobileMenuOpen={mobileMenuOpen}
        setMobileMenuOpen={setMobileMenuOpen}
        syncStatus={syncStatus}
      />

      <div className={`main-area ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <TopHeader
          user={currentUser}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          lowStockCount={lowStockCount}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={handleSetSidebarCollapsed}
          setMobileMenuOpen={setMobileMenuOpen}
          syncStatus={syncStatus}
        />

        <SyncStatusBar />

        {updateReady && (
          <button
            type="button"
            onClick={applyAppUpdate}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
              padding: '10px 14px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
              background: 'var(--teal-deep)', color: '#fff',
            }}
          >
            A new version of the app is ready — tap to update
          </button>
        )}

        <main className="main-content">
        {/* Screens that use the Excel/PDF libraries load on first open (stored on the phone, so offline too) */}
        <Suspense fallback={<div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading…</div>}>
        {activeTab === 'plated' && (
          <PlatedJewelryView
            user={currentUser}
            onQuickOperate={(cat, item) => handleQuickOperate(cat, item)}
          />
        )}
        {activeTab === 'raw' && (
          <RawJewelryView
            user={currentUser}
            onQuickOperate={(cat, item) => handleQuickOperate(cat, item)}
          />
        )}
        {activeTab === 'stones' && (
          <StonesView
            user={currentUser}
            onQuickOperate={(cat, item) => handleQuickOperate(cat, item)}
          />
        )}
        {activeTab === 'foil' && (
          <FoilView
            user={currentUser}
            onQuickOperate={(cat, item) => handleQuickOperate(cat, item)}
          />
        )}
        {LLAMA_SCAN_ENABLED && activeTab === 'scan' && (
          <ScanJewelryView
            user={currentUser}
            onQuickOperate={(cat, item) => handleQuickOperate(cat, item)}
          />
        )}
        {activeTab === 'scan-dino' && (
          <Suspense fallback={<div style={{ padding: 24, textAlign: 'center' }}>Loading Scan DINO…</div>}>
            <ScanDinoView
              user={currentUser}
              onQuickOperate={(cat, item) => handleQuickOperate(cat, item)}
            />
          </Suspense>
        )}
        {activeTab === 'operations' && (
          <StockOperationsView
            user={currentUser}
            initialCategory={opCategory}
            initialItem={opItem}
            onOperationSuccess={() => updateLowStockCount()}
          />
        )}
        {activeTab === 'costing' && currentUser.role === 'owner' && (
          <ErrorBoundary fallbackTitle="Costing System Error">
            <CostingCloudGate>
              <CostingView onNavigateToMaterials={() => setActiveTab('costing-materials')} />
            </CostingCloudGate>
          </ErrorBoundary>
        )}
        {activeTab === 'costing-materials' && currentUser.role === 'owner' && (
          <ErrorBoundary fallbackTitle="Costing Materials Error">
            <CostingCloudGate>
              <CostingMaterialsView onNavigateToCosting={() => setActiveTab('costing')} onOpenKundanStones={() => setActiveTab('stones')} />
            </CostingCloudGate>
          </ErrorBoundary>
        )}
        {activeTab === 'low-stock' && currentUser.role === 'owner' && (
          <LowStockView
            onQuickRestock={(cat, item) => handleQuickOperate(cat, item)}
          />
        )}
        {activeTab === 'history' && currentUser.role === 'owner' && (
          <TransactionHistoryView />
        )}
        {activeTab === 'excel' && currentUser.role === 'owner' && (
          <ExcelImportView />
        )}
        {activeTab === 'sync-queue' && (
          <SyncQueueView />
        )}
        {activeTab === 'staff' && currentUser.role === 'owner' && (
          <StaffManagementView />
        )}
        {activeTab === 'backup' && currentUser.role === 'owner' && (
          <BackupView />
        )}
        </Suspense>
        </main>
      </div>
    </div>
  );
};

export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}
