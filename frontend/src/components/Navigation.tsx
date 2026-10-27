import React from 'react';
import {
  Sparkles,
  Layers,
  Gem,
  Scroll,
  ArrowUpDown,
  AlertTriangle,
  History,
  FileSpreadsheet,
  Users,
  Database,
  LogOut,
  Menu,
  X,
  ShieldCheck,
  UserCheck,
  ChevronLeft,
  ChevronRight,
  Wifi,
  WifiOff,
  RefreshCw,
  IndianRupee,
  Boxes,
} from 'lucide-react';
import type { User } from '../types';
import type { SyncStatus } from '../lib/syncEngine';

export type ActiveTab =
  | 'plated'
  | 'raw'
  | 'stones'
  | 'foil'
  | 'operations'
  | 'costing'
  | 'costing-materials'
  | 'low-stock'
  | 'history'
  | 'excel'
  | 'sync-queue'
  | 'staff'
  | 'backup';

interface NavigationProps {
  user: User;
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  onLogout: () => void;
  lowStockCount: number;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean | ((prev: boolean) => boolean)) => void;
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  syncStatus?: SyncStatus;
}

export const Navigation: React.FC<NavigationProps> = ({
  user,
  activeTab,
  setActiveTab,
  onLogout,
  lowStockCount,
  sidebarCollapsed,
  setSidebarCollapsed,
  mobileMenuOpen,
  setMobileMenuOpen,
  syncStatus,
}) => {
  const isOwner = user.role === 'owner';

  const handleTabClick = (tab: ActiveTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileMenuOpen && (
        <div
          onClick={() => setMobileMenuOpen(false)}
          className="mobile-backdrop"
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${mobileMenuOpen ? 'mobile-open' : ''}`}
        aria-label="Sidebar navigation"
      >
        {/* Brand & Collapse Header */}
        <div className="sidebar-header">
          <div
            className="brand-badge"
            onClick={() => sidebarCollapsed && setSidebarCollapsed(false)}
            style={{ cursor: sidebarCollapsed ? 'pointer' : 'default' }}
            title={sidebarCollapsed ? 'Click to expand' : undefined}
          >
            <div className="brand-icon">
              <Sparkles size={18} />
            </div>
            {!sidebarCollapsed && (
              <div className="brand-text">
                <div style={{ fontSize: 15, fontWeight: 700, color: '#FFFFFF' }}>
                  Poonam Creation
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                  Inventory System
                </div>
              </div>
            )}
          </div>

          {/* Desktop collapse toggle */}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="collapse-btn"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>

          {/* Mobile close button */}
          <button
            onClick={() => setMobileMenuOpen(false)}
            className="mobile-close-btn"
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Nav Items */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }}>
          <div className="nav-label">Core Categories</div>
          <div className="nav-group">
            <button
              className={`nav-item ${activeTab === 'plated' ? 'active' : ''}`}
              onClick={() => handleTabClick('plated')}
              title="Plated Jewelry"
            >
              <Sparkles size={18} />
              <span>Plated Jewelry</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'raw' ? 'active' : ''}`}
              onClick={() => handleTabClick('raw')}
              title="Raw Jewelry Casting"
            >
              <Layers size={18} />
              <span>Raw Jewelry</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'stones' ? 'active' : ''}`}
              onClick={() => handleTabClick('stones')}
              title="Kundan Stone"
            >
              <Gem size={18} />
              <span>Kundan Stone</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'foil' ? 'active' : ''}`}
              onClick={() => handleTabClick('foil')}
              title="Silver & Metal Foil"
            >
              <Scroll size={18} />
              <span>Foil</span>
            </button>
          </div>

          <div className="nav-label" style={{ marginTop: 12 }}>
            Actions
          </div>
          <div className="nav-group">
            <button
              className={`nav-item ${activeTab === 'operations' ? 'active' : ''}`}
              onClick={() => handleTabClick('operations')}
              title="Stock Operations"
            >
              <ArrowUpDown size={18} />
              <span>Stock Operations</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'sync-queue' ? 'active' : ''}`}
              onClick={() => handleTabClick('sync-queue')}
              title="Sync Queue & Offline Operations"
              style={{ display: 'flex', justifyContent: sidebarCollapsed ? 'center' : 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <RefreshCw size={18} className={syncStatus?.isSyncing ? 'animate-spin' : ''} />
                <span>Sync Queue</span>
              </div>
              {!sidebarCollapsed && (syncStatus?.pendingCount ?? 0) > 0 && (
                <span style={{ background: 'rgba(245,158,11,0.2)', color: '#F59E0B', padding: '2px 8px', borderRadius: '9999px', fontSize: 11, fontWeight: 600 }}>{syncStatus?.pendingCount}</span>
              )}
            </button>
          </div>

          {isOwner && (
            <>
              <div className="nav-label" style={{ marginTop: 12 }}>
                Owner Controls
              </div>
              <div className="nav-group">
                <button
                  className={`nav-item ${activeTab === 'costing' ? 'active' : ''}`}
                  onClick={() => handleTabClick('costing')}
                  title="Private Jewelry Costing"
                >
                  <IndianRupee size={18} />
                  <span>Jewelry Costing</span>
                </button>
                <button
                  className={`nav-item ${activeTab === 'costing-materials' ? 'active' : ''}`}
                  onClick={() => handleTabClick('costing-materials')}
                  title="Raw Materials & Categories"
                >
                  <Boxes size={18} />
                  <span>Materials & Categories</span>
                </button>
                <button
                  className={`nav-item ${activeTab === 'low-stock' ? 'active' : ''} ${lowStockCount > 0 ? 'has-alert' : ''}`}
                  onClick={() => handleTabClick('low-stock')}
                  title={`Low Stock Alerts (${lowStockCount})`}
                  style={{ display: 'flex', justifyContent: sidebarCollapsed ? 'center' : 'space-between' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <AlertTriangle size={18} color="#F59E0B" />
                    <span>Low Stock Alert</span>
                  </div>
                  {!sidebarCollapsed && lowStockCount > 0 && (
                    <span style={{ background: 'rgba(245,158,11,0.2)', color: '#F59E0B', padding: '2px 8px', borderRadius: '9999px', fontSize: 11, fontWeight: 600 }}>{lowStockCount}</span>
                  )}
                </button>
                <button
                  className={`nav-item ${activeTab === 'history' ? 'active' : ''}`}
                  onClick={() => handleTabClick('history')}
                  title="Transaction Audit History"
                >
                  <History size={18} />
                  <span>Transaction Audit</span>
                </button>
                <button
                  className={`nav-item ${activeTab === 'excel' ? 'active' : ''}`}
                  onClick={() => handleTabClick('excel')}
                  title="Excel Import & Staging"
                >
                  <FileSpreadsheet size={18} />
                  <span>Excel Staging</span>
                </button>
                <button
                  className={`nav-item ${activeTab === 'staff' ? 'active' : ''}`}
                  onClick={() => handleTabClick('staff')}
                  title="Staff Management"
                >
                  <Users size={18} />
                  <span>Staff Access</span>
                </button>
                <button
                  className={`nav-item ${activeTab === 'backup' ? 'active' : ''}`}
                  onClick={() => handleTabClick('backup')}
                  title="System Storage & Backup"
                >
                  <Database size={18} />
                  <span>Backup & Storage</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Sync Status Indicator */}
        {!sidebarCollapsed && syncStatus && (
          <div style={{
            margin: '8px 12px', padding: '8px 12px', borderRadius: 8,
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: syncStatus.isOnline ? '#10b981' : '#ef4444',
              boxShadow: syncStatus.isOnline ? '0 0 6px #10b981' : '0 0 6px #ef4444',
              flexShrink: 0,
            }} />
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.3 }}>
              {syncStatus.isOnline ? 'Online' : 'Offline'}
              {syncStatus.isSyncing && ' • Syncing...'}
            </div>
          </div>
        )}
        {sidebarCollapsed && syncStatus && (
          <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0' }} title={syncStatus.isOnline ? 'Online' : 'Offline'}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: syncStatus.isOnline ? '#10b981' : '#ef4444',
              boxShadow: syncStatus.isOnline ? '0 0 6px #10b981' : '0 0 6px #ef4444',
            }} />
          </div>
        )}

        {/* User Profile Footer */}
        <div className="sidebar-footer">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
              justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            }}
            title={`${user.username || user.email} (${user.role} role)`}
          >
            <div
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.10)',
                border: '1px solid rgba(255,255,255,0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.8)',
              }}
            >
              {isOwner ? <ShieldCheck size={18} /> : <UserCheck size={18} />}
            </div>
            {!sidebarCollapsed && (
              <div className="sidebar-user-details" style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: '#FFFFFF',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user.username || user.email}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', textTransform: 'capitalize' }}>
                  {user.role}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={onLogout}
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.10)',
              color: 'rgba(255,255,255,0.6)',
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)',
              padding: sidebarCollapsed ? '6px' : '6px 10px',
              fontSize: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}
            title="Log out"
            aria-label="Log out"
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="mobile-bottom-nav">
        <button
          className={`mobile-nav-btn ${activeTab === 'plated' ? 'active' : ''}`}
          onClick={() => setActiveTab('plated')}
        >
          <Sparkles size={18} />
          <span>Plated</span>
        </button>
        <button
          className={`mobile-nav-btn ${activeTab === 'raw' ? 'active' : ''}`}
          onClick={() => setActiveTab('raw')}
        >
          <Layers size={18} />
          <span>Raw</span>
        </button>
        <button
          className={`mobile-nav-btn ${activeTab === 'stones' ? 'active' : ''}`}
          onClick={() => setActiveTab('stones')}
        >
          <Gem size={18} />
          <span>Kundan</span>
        </button>
        <button
          className={`mobile-nav-btn ${activeTab === 'foil' ? 'active' : ''}`}
          onClick={() => setActiveTab('foil')}
        >
          <Scroll size={18} />
          <span>Foil</span>
        </button>
        <button
          className={`mobile-nav-btn ${activeTab === 'operations' ? 'active' : ''}`}
          onClick={() => setActiveTab('operations')}
        >
          <ArrowUpDown size={18} />
          <span>Ops</span>
        </button>
      </nav>
    </>
  );
};

export interface TopHeaderProps {
  user: User;
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  lowStockCount: number;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean | ((prev: boolean) => boolean)) => void;
  setMobileMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  syncStatus?: SyncStatus;
}

export const TopHeader: React.FC<TopHeaderProps> = ({
  user,
  activeTab,
  setActiveTab,
  lowStockCount,
  sidebarCollapsed,
  setSidebarCollapsed,
  setMobileMenuOpen,
  syncStatus,
}) => {
  const isOwner = user.role === 'owner';

  const toggleSidebar = () => {
    if (window.innerWidth <= 900) {
      setMobileMenuOpen((prev) => !prev);
    } else {
      setSidebarCollapsed((prev) => !prev);
    }
  };

  return (
    <header className="top-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          onClick={toggleSidebar}
          className="header-menu-btn"
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label="Toggle sidebar"
        >
          <Menu size={20} />
        </button>
        <div>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            {activeTab === 'plated' && 'Plated Jewelry'}
            {activeTab === 'raw' && 'Raw Jewelry Casting'}
            {activeTab === 'stones' && 'Kundan Stone'}
            {activeTab === 'foil' && 'Silver & Metal Foil'}
            {activeTab === 'operations' && 'Stock Operations'}
            {activeTab === 'costing' && 'Private Jewelry Costing'}
            {activeTab === 'costing-materials' && 'Raw Materials & Categories'}
            {activeTab === 'low-stock' && 'Low Stock Center'}
            {activeTab === 'history' && 'Transaction History Audit'}
            {activeTab === 'excel' && 'Excel Import & Staging'}
            {activeTab === 'sync-queue' && 'Sync Queue & Offline Ops'}
            {activeTab === 'staff' && 'Staff Accounts'}
            {activeTab === 'backup' && 'System Storage & Backup'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Online/Offline indicator in header */}
        {syncStatus && (
          <button
            type="button"
            onClick={() => setActiveTab('sync-queue')}
            title="Click to view Sync Queue"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 6,
              background: syncStatus.isOnline ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${syncStatus.isOnline ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
              cursor: 'pointer',
            }}
          >
            {syncStatus.isOnline
              ? <Wifi size={13} style={{ color: '#10b981' }} />
              : <WifiOff size={13} style={{ color: '#ef4444' }} />
            }
            <span style={{ fontSize: 11, fontWeight: 500, color: syncStatus.isOnline ? '#10b981' : '#ef4444' }}>
              {syncStatus.isOnline ? 'Online' : 'Offline'}
            </span>
            {(syncStatus.pendingCount ?? 0) > 0 && (
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                background: '#f59e0b', color: '#000', marginLeft: 2
              }}>
                {syncStatus.pendingCount}
              </span>
            )}
          </button>
        )}
        {isOwner ? (
          <span className="badge badge-gold">Owner</span>
        ) : (
          <span className="badge badge-emerald">Staff</span>
        )}
        {isOwner && lowStockCount > 0 && (
          <button
            onClick={() => setActiveTab('low-stock')}
            className="badge badge-amber"
            style={{ cursor: 'pointer', border: 'none' }}
            title="View low stock items"
          >
            ⚠️ {lowStockCount} Low
          </button>
        )}
      </div>
    </header>
  );
};
