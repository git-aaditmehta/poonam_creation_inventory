import React, { useState, useEffect, useCallback } from 'react';
import { api } from './api';
import type { User, InventoryCategory, BaseInventoryItem } from './types';
import { ToastProvider, useToast } from './context/ToastContext';
import { LoginView } from './components/LoginView';
import { Navigation, TopHeader, type ActiveTab } from './components/Navigation';
import { PlatedJewelryView } from './components/PlatedJewelryView';
import { RawJewelryView } from './components/RawJewelryView';
import { StonesView } from './components/StonesView';
import { FoilView } from './components/FoilView';
import { StockOperationsView } from './components/StockOperationsView';
import { LowStockView } from './components/LowStockView';
import { TransactionHistoryView } from './components/TransactionHistoryView';
import { ExcelImportView } from './components/ExcelImportView';
import { StaffManagementView } from './components/StaffManagementView';
import { BackupView } from './components/BackupView';
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

  // Verify auth session on initial load
  const checkSession = useCallback(async () => {
    try {
      const res = await api.auth.me();
      setCurrentUser(res.user);
    } catch {
      setCurrentUser(null);
    } finally {
      setIsInitializing(false);
    }
  }, []);

  useEffect(() => {
    checkSession();

    const handleUnauthorized = () => {
      setCurrentUser(null);
    };
    window.addEventListener('auth-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth-unauthorized', handleUnauthorized);
  }, [checkSession]);

  // Fetch low stock alert count for Owner
  const updateLowStockCount = useCallback(async () => {
    if (!currentUser || currentUser.role !== 'owner') return;
    try {
      const res = await api.inventory.getLowStock();
      setLowStockCount(res.total);
    } catch {
      // ignore
    }
  }, [currentUser]);

  useEffect(() => {
    updateLowStockCount();
  }, [updateLowStockCount]);

  const handleLogout = async () => {
    try {
      await api.auth.logout();
      setCurrentUser(null);
      showToast('info', 'Logged Out', 'You have been signed out.');
    } catch (err: any) {
      showToast('error', 'Logout Failed', err.message);
    }
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
    return <LoginView onLoginSuccess={(user) => setCurrentUser(user)} />;
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
        />

        <main className="main-content">
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
        {activeTab === 'operations' && (
          <StockOperationsView
            user={currentUser}
            initialCategory={opCategory}
            initialItem={opItem}
            onOperationSuccess={() => updateLowStockCount()}
          />
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
        {activeTab === 'staff' && currentUser.role === 'owner' && (
          <StaffManagementView />
        )}
        {activeTab === 'backup' && currentUser.role === 'owner' && (
          <BackupView />
        )}
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
