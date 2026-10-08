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
} from 'lucide-react';
import type { User } from '../types';

export type ActiveTab =
  | 'plated'
  | 'raw'
  | 'stones'
  | 'foil'
  | 'operations'
  | 'low-stock'
  | 'history'
  | 'excel'
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
}) => {
  const isOwner = user.role === 'owner';

  const handleTabClick = (tab: ActiveTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  const toggleSidebar = () => {
    if (window.innerWidth <= 900) {
      setMobileMenuOpen((prev) => !prev);
    } else {
      setSidebarCollapsed((prev) => !prev);
    }
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
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>
                  Poonam Creation
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  Inventory Atelier
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
              title="Precious & Synthetic Stones"
            >
              <Gem size={18} />
              <span>Stones</span>
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
          </div>

          {isOwner && (
            <>
              <div className="nav-label" style={{ marginTop: 12 }}>
                Owner Controls
              </div>
              <div className="nav-group">
                <button
                  className={`nav-item ${activeTab === 'low-stock' ? 'active' : ''} ${lowStockCount > 0 ? 'has-alert' : ''}`}
                  onClick={() => handleTabClick('low-stock')}
                  title={`Low Stock Alerts (${lowStockCount})`}
                  style={{ display: 'flex', justifyContent: sidebarCollapsed ? 'center' : 'space-between' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <AlertTriangle size={18} color="var(--amber-text)" />
                    <span>Low Stock Alert</span>
                  </div>
                  {!sidebarCollapsed && lowStockCount > 0 && (
                    <span className="badge badge-amber">{lowStockCount}</span>
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
                background: isOwner ? 'var(--gold-light)' : 'var(--emerald-bg)',
                border: `1px solid ${isOwner ? 'var(--gold-border)' : 'var(--emerald-border)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: isOwner ? 'var(--gold-primary)' : 'var(--emerald-text)',
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
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user.username || user.email}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                  {user.role} role
                </div>
              </div>
            )}
          </div>
          <button
            onClick={onLogout}
            className="btn btn-secondary"
            style={{ padding: sidebarCollapsed ? '6px' : '6px 10px', fontSize: 12 }}
            title="Log out"
            aria-label="Log out"
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      {/* Top Header */}
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
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {activeTab === 'plated' && 'Plated Jewelry'}
              {activeTab === 'raw' && 'Raw Jewelry Casting'}
              {activeTab === 'stones' && 'Precious & Synthetic Stones'}
              {activeTab === 'foil' && 'Silver & Metal Foil'}
              {activeTab === 'operations' && 'Stock Operations'}
              {activeTab === 'low-stock' && 'Low Stock Center'}
              {activeTab === 'history' && 'Transaction History Audit'}
              {activeTab === 'excel' && 'Excel Import & Staging'}
              {activeTab === 'staff' && 'Staff Accounts'}
              {activeTab === 'backup' && 'System Storage & Backup'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isOwner ? (
            <span className="badge badge-gold">👑 Owner View</span>
          ) : (
            <span className="badge badge-emerald">👷 Staff View</span>
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
          <span>Stones</span>
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
