import React from 'react';

/**
 * Page title block. Pages no longer get a back arrow or a reload button here (removed on request): navigation is the
 * sidebar, and data refreshes on its own. The onRefresh/showBack/onBack props are still accepted and simply ignored,
 * so existing pages keep working unchanged.
 */
// eslint-disable-next-line no-unused-vars
const PageHeader = ({ title, subtitle, onRefresh, showBack, onBack, actionLabel, onAction, actionIcon, children, titleStyle = {} }) => {
  return (
    <div
      className="page-header stack-on-mobile"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '1rem',
        flexWrap: 'wrap',
        marginBottom: 0
      }}
    >
      {/* Left Side: Titles */}
      <div style={{ flex: '1 1 min-content' }}>
        <h1 className="text-fluid-h1" style={{ margin: 0, letterSpacing: '-1.5px', color: 'var(--admin-text-primary)', lineHeight: 1.1, fontWeight: '950', textTransform: 'uppercase', ...titleStyle }}>
          {title}
        </h1>
        <p style={{ margin: '0.5rem 0 0 0', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: '500', maxWidth: '600px' }}>
          {subtitle}
        </p>
      </div>

      {/* Right Side: Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        {children}
        {actionLabel && (
          <button
            onClick={onAction}
            style={{
              background: 'var(--admin-brand)', color: 'var(--admin-text-on-brand)', border: 'none',
              padding: '0.75rem 1.5rem', borderRadius: '4px', fontWeight: '950',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem',
              fontSize: '0.75rem', letterSpacing: '1px', whiteSpace: 'nowrap'
            }}
          >
            {actionIcon}
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
};

export default PageHeader;