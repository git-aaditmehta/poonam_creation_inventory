import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  UserPlus,
  KeyRound,
  CheckCircle2,
  XCircle,
  Loader2,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { StaffUser } from '../types';
import { useToast } from '../context/ToastContext';

export const StaffManagementView: React.FC = () => {
  const { showToast } = useToast();

  const [staffList, setStaffList] = useState<StaffUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Create Staff Modal
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Reset Password Modal
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [activeStaff, setActiveStaff] = useState<StaffUser | null>(null);
  const [resetPasswordVal, setResetPasswordVal] = useState('');
  const [isResetting, setIsResetting] = useState(false);

  const fetchStaff = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.auth.listStaff();
      setStaffList(res.staff);
    } catch (err: any) {
      showToast('error', 'Failed to load staff list', err.message);
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchStaff();
  }, [fetchStaff]);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim() || !newPassword) {
      showToast('error', 'Validation Error', 'Username and password required');
      return;
    }

    setIsCreating(true);
    try {
      await api.auth.createStaff(newUsername.trim(), newPassword);
      showToast('success', 'Staff Created', `User ${newUsername} has been registered`);
      setIsCreateOpen(false);
      setNewUsername('');
      setNewPassword('');
      fetchStaff();
    } catch (err: any) {
      showToast('error', 'Creation Failed', err.message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleToggleActive = async (staff: StaffUser) => {
    const nextState = staff.is_active ? false : true;
    try {
      await api.auth.toggleStaff(staff.id, nextState);
      showToast('success', 'Status Updated', `${staff.username} is now ${nextState ? 'Active' : 'Inactive'}`);
      fetchStaff();
    } catch (err: any) {
      showToast('error', 'Update Failed', err.message);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeStaff || !resetPasswordVal) return;

    setIsResetting(true);
    try {
      await api.auth.resetStaffPassword(activeStaff.id, resetPasswordVal);
      showToast('success', 'Password Reset', `Password updated for ${activeStaff.username}`);
      setIsResetOpen(false);
      setResetPasswordVal('');
    } catch (err: any) {
      showToast('error', 'Reset Failed', err.message);
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto', width: '100%' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 24,
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Users size={24} color="var(--gold-primary)" />
            <h2 style={{ fontSize: 22, fontWeight: 700 }}>Staff Account Management</h2>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            Control staff access credentials and authorization state.
          </p>
        </div>

        <button onClick={() => setIsCreateOpen(true)} className="btn btn-primary">
          <UserPlus size={16} /> Create Staff User
        </button>
      </div>

      {/* Staff Table */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
          <Loader2 size={32} className="animate-spin" style={{ margin: '0 auto 12px' }} />
          <div>Loading staff directory...</div>
        </div>
      ) : staffList.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '60px 20px',
            background: 'var(--bg-surface-1)',
            borderRadius: 'var(--radius-lg)',
            border: '1px dashed var(--border-medium)',
          }}
        >
          <Users size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ fontSize: 16 }}>No Staff Accounts</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
            Create an operator account for your workshop staff.
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created Date</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {staffList.map((staff) => (
                <tr key={staff.id}>
                  <td>
                    <div style={{ fontWeight: 700, fontSize: 14 }} className="mono">
                      {staff.username}
                    </div>
                  </td>
                  <td>
                    <span className="badge badge-gold">Staff Operator</span>
                  </td>
                  <td>
                    {staff.is_active ? (
                      <span className="badge badge-emerald" style={{ display: 'inline-flex', gap: 4 }}>
                        <CheckCircle2 size={11} /> Active
                      </span>
                    ) : (
                      <span className="badge badge-rose" style={{ display: 'inline-flex', gap: 4 }}>
                        <XCircle size={11} /> Deactivated
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }} className="mono">
                    {staff.created_at?.slice(0, 10)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 8 }}>
                      <button
                        onClick={() => {
                          setActiveStaff(staff);
                          setResetPasswordVal('');
                          setIsResetOpen(true);
                        }}
                        className="btn btn-secondary"
                        style={{ padding: '6px 10px', fontSize: 12 }}
                      >
                        <KeyRound size={13} /> Reset Password
                      </button>

                      <button
                        onClick={() => handleToggleActive(staff)}
                        className={`btn ${staff.is_active ? 'btn-danger' : 'btn-primary'}`}
                        style={{ padding: '6px 10px', fontSize: 12 }}
                      >
                        {staff.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Modal */}
      {isCreateOpen && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Register New Staff User</h3>
              <button
                onClick={() => setIsCreateOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">
                    Username <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    className="input mono"
                    placeholder="e.g. staff_rahul"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">
                    Initial Password <span className="required">*</span>
                  </label>
                  <input
                    type="password"
                    className="input"
                    placeholder="••••••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Staff accounts cannot view cost prices or delete transactions.
                  </span>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsCreateOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={isCreating}>
                  {isCreating ? <Loader2 size={14} className="animate-spin" /> : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {isResetOpen && activeStaff && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <div className="modal-header">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>Reset Password for {activeStaff.username}</h3>
              <button
                onClick={() => setIsResetOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleResetSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">
                    New Password <span className="required">*</span>
                  </label>
                  <input
                    type="password"
                    className="input"
                    placeholder="••••••••••••"
                    value={resetPasswordVal}
                    onChange={(e) => setResetPasswordVal(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsResetOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={isResetting}>
                  {isResetting ? <Loader2 size={14} className="animate-spin" /> : 'Save New Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
