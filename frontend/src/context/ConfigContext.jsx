import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { SHOP_CONFIG } from '../config/constants';
import { logger } from '../utils/logger';

const ConfigContext = createContext();

export const ConfigProvider = ({ children }) => {
  const [settings, setSettings] = useState({
    MAX_BAYS: SHOP_CONFIG.MAX_BAYS,
    MAX_VEHICLES_PER_STAFF: 4,
    OPENING_HOUR: SHOP_CONFIG.OPENING_HOUR,
    CLOSING_HOUR: SHOP_CONFIG.CLOSING_HOUR,
    IS_24_7: false,
    BUSINESS_NAME: 'COMAR GARAGE',
    // Tier 2.7: public-facing business identity (Business Hub = single source of
    // truth). Landing renders these so hub edits reflect on the website.
    BUSINESS_CONTACT_NUMBER: '',
    BUSINESS_EMAIL: '',
    BUSINESS_ADDRESS: '',
    // Tier 2.8: admin-editable FAQ entries shared with the landing page.
    FAQS: [],
    PAYMENT_ACCOUNT_NAME: 'COMAR GARAGE',
    PAYMENT_ACCOUNT_NUMBER: '0912 345 6789',
    PAYMENT_QR_URL: null,
    qr_code_url: null,
    qr_account_name: '',
    qr_account_number: '',
    // Task B: the primary QR recipient fields + version.
    QR_ACCOUNT_NAME: '',
    QR_ACCOUNT_NUMBER: '',
    QR_CONFIG_VERSION: 1,
    QR_CONFIG_COMPLETE: false,
    loaded: false
  });

  const parseHour = (timeStr, defaultHour) => {
    if (!timeStr) return defaultHour;
    try {
      const upperTime = timeStr.toUpperCase();
      // Handle "08:00 AM" or "17:00"
      if (!upperTime.includes('AM') && !upperTime.includes('PM')) {
        return parseInt(upperTime.split(':')[0], 10);
      }
      const [time, modifier] = upperTime.split(' ');
      let [h] = time.split(':');
      h = parseInt(h, 10);
      if (modifier === 'PM' && h < 12) h += 12;
      if (modifier === 'AM' && h === 12) h = 0;
      return h;
    } catch (e) {
      return defaultHour;
    }
  };

  const refreshConfig = async () => {
    try {
      logger.admin('Synchronizing live shop configuration...');
      const { data, error } = await supabase
        .from('business_config')
        .select('*')
        .maybeSingle();

      if (error) throw error;

      if (data) {
        const qrAccountName = data.qr_account_name || data.payment_account_name || data.gcash_name || '';
        const qrAccountNumber = data.qr_account_number || data.payment_account_number || data.gcash_number || '';
        const qrCodeUrl = data.qr_code_url || data.payment_qr_url || data.gcash_qr_url || data.qr_photo_url || null;

        // Tier 2.9: keep the shared service-catalog cache in lock-step with the
        // persisted catalog so admin edits (Business Hub "Service Catalog") reach
        // the public landing page and the booking wizard on every device, not
        // only the browser that made the edit.
        if (Array.isArray(data.custom_services)) {
          try {
            localStorage.setItem('speedway_custom_services', JSON.stringify(data.custom_services));
            if (typeof window !== 'undefined') {
              window.__speedway_custom_services_cache = data.custom_services;
            }
          } catch { /* ignore quota / private-mode errors */ }
        }
        setSettings({
          MAX_BAYS: data.slots_per_hour || SHOP_CONFIG.MAX_BAYS,
          MAX_VEHICLES_PER_STAFF: Number(data.max_vehicles_per_staff) || 4,
          // When the shop is open 24 hours the whole day is bookable. Report the
          // window as 0..24 so the existing timeline/grid math (which derives its
          // hour axis from CLOSING_HOUR - OPENING_HOUR) spans the full day with no
          // changes to those components.
          OPENING_HOUR: data.is_24_7 === true ? 0 : parseHour(data.opening_hour, SHOP_CONFIG.OPENING_HOUR),
          CLOSING_HOUR: data.is_24_7 === true ? 24 : parseHour(data.closing_hour, SHOP_CONFIG.CLOSING_HOUR),
          IS_24_7: data.is_24_7 === true,
          BUSINESS_NAME: data.business_name || 'COMAR GARAGE',
          BUSINESS_CONTACT_NUMBER: data.contact_number || '',
          BUSINESS_EMAIL: data.email_address || '',
          BUSINESS_ADDRESS: data.business_address || '',
          FAQS: Array.isArray(data.faqs) ? data.faqs : [],
          // Task B: the mandated QR recipients are the source of truth. Legacy
          // payment_account_* / gcash_* keys remain as fallbacks so older rows
          // still render a QR during the migration window.
          qr_code_url: qrCodeUrl,
          qr_account_name: qrAccountName,
          qr_account_number: qrAccountNumber,
          QR_ACCOUNT_NAME: qrAccountName,
          QR_ACCOUNT_NUMBER: qrAccountNumber,
          QR_CONFIG_VERSION: data.qr_config_version ?? 1,
          QR_CONFIG_COMPLETE: data.qr_config_complete === true,
          PAYMENT_ACCOUNT_NAME: qrAccountName || 'COMAR GARAGE',
          PAYMENT_ACCOUNT_NUMBER: qrAccountNumber || '0912 345 6789',
          PAYMENT_QR_URL: qrCodeUrl,
          loaded: true
        });
      } else {
        // Table is empty, use defaults and mark as loaded
        setSettings(prev => ({ ...prev, loaded: true }));
        logger.warn('Business configuration is empty. Using defaults.');
      }
    } catch (err) {
      logger.error('Config Sync Error', err);
      setSettings(prev => ({ ...prev, loaded: true })); // Proceed with defaults
    }
  };

  useEffect(() => {
    refreshConfig();

    // REAL-TIME SYNC: Listen for live updates to business settings
    const channel = supabase
      .channel('public:business_config')
      .on('postgres_changes', 
          { event: '*', schema: 'public', table: 'business_config' }, 
          () => {
            logger.admin('Live configuration update detected. Synchronizing...');
            refreshConfig();
          }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <ConfigContext.Provider value={{ settings, refreshConfig }}>
      {children}
    </ConfigContext.Provider>
  );
};

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (!context) throw new Error('useConfig must be used within a ConfigProvider');
  return context;
};
