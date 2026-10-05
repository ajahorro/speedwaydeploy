// Must stay the first import: declares the CSS cascade-layer order (see ui.css).
import './styles/ui.css';
import React, { Suspense, lazy, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { TOASTER_DEFAULTS } from './utils/toastChrome';
import ErrorBoundary from './components/ErrorBoundary';
import { installGlobalErrorReporter } from './utils/globalErrorReporter';
import { UIProvider } from './context/UIContext';
import { ImagePreviewProvider } from './context/ImagePreviewContext';
import { AuthProvider } from './context/AuthContext';
import { UnifiedProvider } from './context/UnifiedContext';
import { ThemeProvider } from './context/ThemeContext';
import { ConfigProvider } from './context/ConfigContext';
import { ChatProvider } from './context/ChatContext';
const AdminLayout = lazy(() => import('./pages/Admin/AdminLayout'));
const AdminDashboard = lazy(() => import('./pages/Admin/AdminDashboard'));
const AdminBookings = lazy(() => import('./pages/Admin/AdminBookings'));
const AdminBookingDetails = lazy(() => import('./pages/Admin/AdminBookingDetails'));
const AdminSchedule = lazy(() => import('./pages/Admin/AdminSchedule'));
const AdminPayments = lazy(() => import('./pages/Admin/AdminPayments'));
const AdminRefunds = lazy(() => import('./pages/Admin/AdminRefunds'));
import LoadingState from './components/LoadingState';

// Lazy so the chart library only loads for admins who open the report.
const FinancialReportsPage = lazy(() => import('./features/financial-reports/FinancialReportsPage'));
const financialReports = (defaultTab) => (
  <Suspense fallback={<LoadingState message="Loading reports..." />}>
    <FinancialReportsPage defaultTab={defaultTab} />
  </Suspense>
);
const AdminAuditLogs = lazy(() => import('./pages/Admin/AdminAuditLogs'));
const AdminAccountsManagement = lazy(() => import('./pages/Admin/AdminAccountsManagement'));
const AdminUserManagement = lazy(() => import('./pages/Admin/AdminUserManagement'));
const AdminSettings = lazy(() => import('./pages/Admin/AdminSettings'));
const BusinessHub = lazy(() => import('./pages/Admin/BusinessHub'));
const AdminNotifications = lazy(() => import('./pages/Admin/AdminNotifications'));
const AdminChat = lazy(() => import('./pages/Admin/AdminChat'));
const AdminProfile = lazy(() => import('./pages/Admin/AdminProfile'));
const AdminAcceptInvite = lazy(() => import('./pages/Admin/AdminAcceptInvite'));
const AdminWalkInForm = lazy(() => import('./pages/Admin/AdminWalkInWizard'));
const StaffLayout = lazy(() => import('./pages/Staff/StaffLayout'));
const StaffDashboard = lazy(() => import('./pages/Staff/StaffDashboard'));
const StaffActiveJobs = lazy(() => import('./pages/Staff/StaffActiveJobs'));
const StaffWorkHistory = lazy(() => import('./pages/Staff/StaffWorkHistory'));
const StaffJobDetails = lazy(() => import('./pages/Staff/StaffJobDetails'));
const StaffProfile = lazy(() => import('./pages/Staff/StaffProfile'));
const StaffDuty = lazy(() => import('./pages/Staff/StaffDuty'));
const StaffNotifications = lazy(() => import('./pages/Staff/StaffNotifications'));
const StaffSettings = lazy(() => import('./pages/Staff/StaffSettings'));
import Landing from './pages/Landing';
import Login from './pages/Login';
import ProtectedRoute from './components/ProtectedRoute';
const CustomerLayout = lazy(() => import('./pages/Customer/CustomerLayout'));
const CustomerDashboard = lazy(() => import('./pages/Customer/CustomerDashboard'));
const CustomerBookAppointment = lazy(() => import('./pages/Customer/CustomerBookAppointment'));
const CustomerMyBookings = lazy(() => import('./pages/Customer/CustomerMyBookings'));
const CustomerBilling = lazy(() => import('./pages/Customer/CustomerBilling'));
const CustomerGarage = lazy(() => import('./pages/Customer/CustomerGarage'));
const GlobalNotifications = lazy(() => import('./pages/GlobalNotifications'));
const CustomerSettings = lazy(() => import('./pages/Customer/CustomerSettings'));
const CustomerProfile = lazy(() => import('./pages/Customer/CustomerProfile'));
const CustomerBookingDetails = lazy(() => import('./pages/Customer/CustomerBookingDetails'));
const CustomerReceipt = lazy(() => import('./pages/Customer/CustomerReceipt'));
const PasswordConfirmation = lazy(() => import('./pages/PasswordConfirmation'));
const AuthCallback = lazy(() => import('./pages/AuthCallback'));
import './index.css';

const InputCapitalizationController = () => {
  useEffect(() => {
    const capitalizeFirstLetter = (event) => {
      const target = event.target;
      const isTextInput = target instanceof HTMLInputElement && target.type === 'text';
      const isTextArea = target instanceof HTMLTextAreaElement;
      if ((!isTextInput && !isTextArea) || target.dataset.noAutoCapitalize !== undefined) return;

      const match = target.value.match(/^(\s*)([a-z])/);
      if (!match) return;

      const next = `${match[1]}${match[2].toUpperCase()}${target.value.slice(match[0].length)}`;
      // Assign through the PROTOTYPE setter, not target.value. React tracks each field's value on
      // the element itself; setting target.value here updated that tracker, so React then saw "no
      // change" and never called onChange for the first letter of a typed, pasted or single-event
      // entry (search boxes silently stayed unfiltered). The prototype setter leaves the tracker
      // alone, so onChange fires with the capitalised text.
      const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setValue) setValue.call(target, next); else target.value = next;
    };

    document.addEventListener('input', capitalizeFirstLetter, true);
    return () => document.removeEventListener('input', capitalizeFirstLetter, true);
  }, []);

  return null;
};

// Suppress React Router v7 Future Flag Warnings
const originalWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('React Router Future Flag Warning')) {
    return;
  }
  originalWarn(...args);
};

// Install the global unhandled-error net once, before the tree mounts, so even
// a boot-time rejection is caught and surfaced rather than silently dropped.
installGlobalErrorReporter();

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <ConfigProvider>
      <ThemeProvider>
        <AuthProvider>
          <ChatProvider>
            <InputCapitalizationController />
            <UnifiedProvider>
              <BrowserRouter>
                <UIProvider>
                <ImagePreviewProvider>
                {/* Proactive "backend offline" signal. Booking submission is
                    fail-closed, so surfacing an unreachable scheduling server
                    BEFORE the user fills in the wizard (instead of a scary
                    console refusal at submit time) is the right UX. */}
                <Suspense fallback={<LoadingState message="Loading..." />}>
                <Routes>
                {/* Public Routes */}
                <Route path="/" element={<Landing />} />
                <Route path="/login" element={<Login />} />
                <Route path="/accept-invite" element={<AdminAcceptInvite />} />
                {/* Landing page for Supabase auth email links (signup
                    confirmation, recovery, email change). The session arrives in
                    the URL FRAGMENT, which /login never read — so a freshly
                    confirmed customer was shown a login form instead of being
                    signed in. This route consumes it and redirects by role. */}
                <Route path="/auth/callback" element={<AuthCallback />} />
                <Route path="/password-confirmation" element={<PasswordConfirmation />} />

                {/* Admin Routes */}
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute allowedRoles={['ADMIN']}>
                      <AdminLayout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<AdminDashboard />} />
                  <Route path="business" element={<BusinessHub />} />
                  <Route path="walk-in" element={<AdminWalkInForm />} />
                  <Route path="bookings" element={<AdminBookings />} />
                  <Route path="bookings/:id" element={<AdminBookingDetails />} />
                  <Route path="schedule" element={<AdminSchedule />} />
                  <Route path="payments" element={<AdminPayments />} />
                  <Route path="refunds" element={<AdminRefunds />} />
                  <Route path="reports" element={financialReports('overview')} />
                  <Route path="analytics" element={<Navigate to="/admin/reports" replace />} />
                  <Route path="finance" element={<Navigate to="/admin/reports" replace />} />
                  {/* Classic report kept for one release as an instant fallback. */}
                  <Route path="finance/classic" element={<Navigate to="/admin/reports" replace />} />
                  <Route path="audit-logs" element={<AdminAuditLogs />} />
                  <Route path="accounts" element={<AdminAccountsManagement />} />
                  <Route path="users" element={<AdminUserManagement />} />
                  <Route path="settings" element={<AdminSettings />} />
                  <Route path="chat" element={<AdminChat />} />
                  <Route path="notifications" element={<AdminNotifications />} />
                  <Route path="profile" element={<AdminProfile />} />
                  <Route path="*" element={<div style={{ padding: '2rem' }}>Module under development</div>} />
                </Route>

                {/* Staff Routes */}
                <Route
                  path="/staff"
                  element={
                    <ProtectedRoute allowedRoles={['STAFF']}>
                      <StaffLayout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<StaffDashboard />} />
                  <Route path="tasks" element={<StaffActiveJobs />} />
                  <Route path="history" element={<StaffWorkHistory />} />
                  <Route path="duty" element={<StaffDuty />} />
                  <Route path="job/:id" element={<StaffJobDetails />} />
                  <Route path="profile" element={<StaffProfile />} />
                  <Route path="notifications" element={<StaffNotifications />} />
                  <Route path="settings" element={<StaffSettings />} />
                </Route>

                {/* Customer Routes */}
                <Route
                  path="/customer"
                  element={
                    <ProtectedRoute allowedRoles={['CUSTOMER']}>
                      <CustomerLayout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<CustomerDashboard />} />
                  <Route path="book" element={<CustomerBookAppointment />} />
                  <Route path="bookings" element={<CustomerMyBookings />} />
                  <Route path="bookings/:id" element={<CustomerBookingDetails />} />
                  <Route path="billing" element={<CustomerBilling />} />
                  <Route path="garage" element={<CustomerGarage />} />
                  <Route path="notifications" element={<GlobalNotifications />} />
                  <Route path="settings" element={<CustomerSettings />} />
                  <Route path="profile" element={<CustomerProfile />} />
                  <Route path="receipt/:id" element={<CustomerReceipt />} />
                </Route>
                </Routes>
                </Suspense>
                {/* react-hot-toast host — the ONE toast engine for the whole app
                    after Step 7.3 consolidation. Previously no <Toaster/> was
                    mounted, so every `toast.*()` call was a silent no-op; and a
                    second bespoke stack lived in UIContext. Both are resolved:
                    all toast output flows here, styled from the shared
                    token-based chrome in utils/toastChrome so it adapts to
                    dark/light and stays 375px-safe.

                    Stacking + volume are governed by utils/toastManager, which
                    every call site now routes through. The container is pinned
                    top-right with a real vertical gutter so toasts stack in a
                    column instead of overlapping, and `containerStyle` keeps
                    the column below the sticky header (z-index --z-toast so it
                    still outranks modals when a foreground toast must show). */}
                <Toaster
                  position="top-right"
                  gutter={12}
                  containerStyle={{
                    top: 76,
                    right: 20,
                    zIndex: 'var(--z-toast)',
                  }}
                  toastOptions={TOASTER_DEFAULTS}
                />
                </ImagePreviewProvider>
                </UIProvider>
              </BrowserRouter>
            </UnifiedProvider>
          </ChatProvider>
        </AuthProvider>
      </ThemeProvider>
    </ConfigProvider>
  </ErrorBoundary>
);
