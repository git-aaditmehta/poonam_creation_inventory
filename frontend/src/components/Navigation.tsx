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
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

export const Navigation: React.FC<NavigationProps> = ({
  user,
  activeTab,
  setActiveTab,
  onLogout,
  lowStockCount,
  sidebarOpen,
  setSidebarOpen,
}) => {
  const isOwner = user.role === 'owner';

  const handleTabClick = (tab: ActiveTab) => {
    setActiveTab(tab);
    setSidebarOpen(false);
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(4px)',
            zIndex: 35,
          }}
        />
      )}

      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        {/* Brand */}
        <div
          style={{
            padding: '20px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div className="brand-badge">
            <div className="brand-icon">
              <Sparkles size={18} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>
                Poonam Creation
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                Inventory Atelier
              </div>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              display: 'none',
            }}
            className="mobile-close-btn"
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Nav Items */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
          <div className="nav-label">Core Categories</div>
          <div className="nav-group">
            <button
              className={`nav-item ${activeTab === 'plated' ? 'active' : ''}`}
              onClick={() => handleTabClick('plated')}
            >
              <Sparkles size={16} />
              <span>Plated Jewelry</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'raw' ? 'active' : ''}`}
              onClick={() => handleTabClick('raw')}
            >
              <Layers size={16} />
              <span>Raw Jewelry</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'stones' ? 'active' : ''}`}
              onClick={() => handleTabClick('stones')}
            >
              <Gem size={16} />
              <span>Stones</span>
            </button>
            <button
              className={`nav-item ${activeTab === 'foil' ? 'active' : ''}`}
              onClick={() => handleTabClick('foil')}
            >
              <Scroll size={16} />
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
            >
              <ArrowUpDown size={16} />
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
                  className={`nav-item ${activeTab === 'low-stock' ? 'active' : ''}`}
                  onClick={() => handleTabClick('low-stock')}
                  style={{ display: 'flex', justifyContent: 'space-between' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <AlertTriangle size={16} color="var(--amber-text)" />
                    <span>Low Stock Alert</span>
                  </div>
                  {lowStockCount > 0 && (
                    <span className="badge badge-amber">{lowStockCount}</span>
                  )}
                </button>
                <button
                  className={`nav-item ${activeTab === 'history' ? 'active' : ''}`}
                  onClick={() => handleTabClick('history')}
                >
                  <History size={16} />
                  <span>Transaction Audit</span>
                </button>
                <button
                  className={`nav-item ${activeTab === 'excel' ? 'active' : ''}`}
                  onClick={() => handleTabClick('excel')}
                >
                  <FileSpreadsheet size={16} />
                  <span>Excel Staging</span>
                </button>
                <button
                  className={`nav-item ${activeTab === 'staff' ? 'active' : ''}`}
                  onClick={() => handleTabClick('staff')}
                >
                  <Users size={16} />
                  <span>Staff Access</span>
                </button>
                <button
                  className={`nav-item ${activeTab === 'backup' ? 'active' : ''}`}
                  onClick={() => handleTabClick('backup')}
                >
                  <Database size={16} />
                  <span>Backup & Storage</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* User Footer */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div
              style={{
                width: 34,
                height: 34,
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
            <div style={{ minWidth: 0 }}>
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
          </div>
          <button
            onClick={onLogout}
            className="btn btn-secondary"
            style={{ padding: '6px 10px', fontSize: 12 }}
            title="Log out"
          >
            <LogOut size={14} />
          </button>
        </div>
      </aside>

      {/* Top Header */}
      <header className="top-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              display: 'flex',
              padding: 4,
            }}
            aria-label="Toggle menu"
          >
            <Menu size={22} />
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
            >
              ⚠️ {lowStockCount} Low
            </button>
          )}
        </div>
      </header>

      {/* Mobile Bottom Navigation Bar (5 thumb-accessible buttons) */}
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
