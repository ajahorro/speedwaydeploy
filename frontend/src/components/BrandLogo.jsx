import React from 'react';

const BrandLogo = ({ width = '150px', height = 'auto' }) => (
  <div style={{ width, height, background: 'var(--admin-brand)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-on-brand)', fontWeight: 'bold' }}>
    COMAR GARAGE
  </div>
);

export default BrandLogo;
