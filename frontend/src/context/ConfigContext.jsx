import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { subscribeTable } from '../lib/realtimeHub';
import { SHOP_CONFIG, VEHICLE_TYPE_OPTIONS } from '../config/constants';
import { logger } from '../utils/logger';
import { bayCapacityOf, fetchShopConfig, getShopConfig, subscribeShopConfig } from '../config/shopConfig';

const ConfigContext = createContext();

/** Hour (0-23) from "HH:MM", "HH:MM:SS" or "h:mm AM/PM". */
const parseHour = (timeStr, defaultHour) => {
  if (!timeStr) return defaultHour;
  try {
    const upperTime = String(timeStr).toUpperCase();
    if (!upperTime.includes('AM') && !upperTime.includes('PM')) {
      return parseInt(upperTime.split(':')[0], 10);
    }
    const [time, modifier] = upperTime.split(' ');
    let [h] = time.split(':');
    h = parseInt(h, 10);
    if (modifier === 'PM' && h < 12) h += 12;
    if (modifier === 'AM' && h === 12) h = 0;
    return h;
  } catch {
    return defaultHour;
  }
};

/**
 * Screen-facing settings derived from the business_config row (the Business
 * Hub's single source of truth). `config` is the raw row for screens that need
 * schedule rules, vehicle types or the downpayment policy.
 */
const settingsFromRow = (data) => {
  const qrAccountName = data?.qr_account_name || data?.payment_account_name || data?.gcash_name || '';
  const qrAccountNumber = data?.qr_account_number || data?.payment_account_number || data?.gcash_number || '';
  const qrCodeUrl = data?.qr_code_url || data?.payment_qr_url || data?.gcash_qr_url || data?.qr_photo_url || null;
  // Business Hub vehicle categories as {value,label} options (built-in labels kept).
  const configuredTypes = (Array.isArray(data?.vehicle_types) ? data.vehicle_types : [])
    .map((type) => String(type || '').trim())
    .filter(Boolean)
    .map((type) => VEHICLE_TYPE_OPTIONS.find((option) => option.value.toLowerCase() === type.toLowerCase()) || { value: type, label: type });

  return {
    config: data || null,
    MAX_BAYS: bayCapacityOf(data),
    // When the shop is open 24 hours the whole day is bookable; report 0..24 so
    // grid math spanning CLOSING_HOUR - OPENING_HOUR covers the full day.
    OPENING_HOUR: data?.is_24_7 === true ? 0 : parseHour(data?.opening_hour, SHOP_CONFIG.OPENING_HOUR),
    CLOSING_HOUR: data?.is_24_7 === true ? 24 : parseHour(data?.closing_hour, SHOP_CONFIG.CLOSING_HOUR),
    IS_24_7: data?.is_24_7 === true,
    BOOKING_LEAD_TIME_MINUTES: Number(data?.booking_lead_time_minutes ?? 5),
    MAX_ADVANCE_DAYS: Number(data?.max_advance_days ?? 30),
    CLOSED_WEEKDAYS: Array.isArray(data?.closed_weekdays) ? data.closed_weekdays.map(Number) : [],
    ENFORCE_CAPACITY: data?.enforce_capacity !== false,
    // The built-in list only when the Business Hub has none configured.
    VEHICLE_TYPES: configuredTypes.length ? configuredTypes : VEHICLE_TYPE_OPTIONS,
    DOWNPAYMENT_POLICY: {
      min_total: Number(data?.downpayment_min_total ?? 1000),
      rate: Number(data?.downpayment_rate ?? 0.3),
      high_threshold: Number(data?.downpayment_high_threshold ?? 2000),
      high_rate: Number(data?.downpayment_high_rate ?? 0.5)
    },
    BUSINESS_NAME: data?.business_name || 'COMAR GARAGE',
    BUSINESS_CONTACT_NUMBER: data?.contact_number || '',
    BUSINESS_EMAIL: data?.email_address || '',
    BUSINESS_ADDRESS: data?.business_address || '',
    FAQS: Array.isArray(data?.faqs) ? data.faqs : [],
    // One text for the whole site, edited in the Business Hub (Payment Policy).
    TERMS_AND_CONDITIONS: String(data?.terms_customer || data?.terms_and_conditions || ''),
    // One text and version per role (master plan 1.11); each account accepts its own.
    TERMS: {
      customer: { text: String(data?.terms_customer || data?.terms_and_conditions || ''), version: Number(data?.terms_customer_version || 1) },
      staff: { text: String(data?.terms_staff || ''), version: Number(data?.terms_staff_version || 1) },
      admin: { text: String(data?.terms_admin || ''), version: Number(data?.terms_admin_version || 1) }
    },
    // Task B: the mandated QR recipients; legacy payment_account_* / gcash_*
    // keys remain as fallbacks for older rows.
    qr_code_url: qrCodeUrl,
    qr_account_name: qrAccountName,
    qr_account_number: qrAccountNumber,
    QR_ACCOUNT_NAME: qrAccountName,
    QR_ACCOUNT_NUMBER: qrAccountNumber,
    QR_CONFIG_VERSION: data?.qr_config_version ?? 1,
    QR_CONFIG_COMPLETE: data?.qr_config_complete === true,
    PAYMENT_ACCOUNT_NAME: qrAccountName || 'COMAR GARAGE',
    PAYMENT_ACCOUNT_NUMBER: qrAccountNumber || '0912 345 6789',
    PAYMENT_QR_URL: qrCodeUrl
  };
};

export const ConfigProvider = ({ children }) => {
  const [settings, setSettings] = useState(() => ({ ...settingsFromRow(getShopConfig()), loaded: false, loadError: null }));

  const refreshConfig = useCallback(async () => {
    try {
      logger.admin('Synchronizing live shop configuration...');
      const row = await fetchShopConfig({ force: true });
      if (!row) logger.warn('Business configuration is empty. Using defaults.');
    } catch (err) {
      logger.error('Config Sync Error', err);
      setSettings((prev) => ({ ...prev, loaded: true, loadError: err?.message || 'Shop settings could not be loaded.' }));
    }
  }, []);

  useEffect(() => {
    // Every load (initial, realtime, focus, or a Business Hub save) lands here.
    const unsubscribe = subscribeShopConfig((row) => {
      setSettings({ ...settingsFromRow(row), loaded: true, loadError: null });
    });

    refreshConfig();

    // Live updates when the Business Hub saves, plus a refresh when the tab
    // regains focus so a long-open booking screen never keeps old settings.
    const stopRealtime = subscribeTable({ table: 'business_config' }, () => {
      logger.admin('Live configuration update detected. Synchronizing...');
      refreshConfig();
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshConfig();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      stopRealtime();
    };
  }, [refreshConfig]);

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
