import { supabase } from '../lib/supabase';

/**
 * Record an authenticated admin mutation without allowing audit failure to
 * change the user's successful operation result.
 */
export const writeAdminAuditLog = async ({ actionType, details, metadata = null }) => {
  try {
    const { data: { user } = {} } = await supabase.auth.getUser();
    const row = {
      action_type: actionType,
      actor_id: user?.id || null,
      actor_name: user?.email || 'Administrator',
      actor_role: 'ADMIN',
      details,
      metadata,
      created_at: new Date().toISOString(),
    };
    let { error } = await supabase.from('audit_logs').insert(row);
    if (error && (error.code === 'PGRST204' || error.code === '42703')) {
      const lean = { ...row };
      delete lean.actor_id;
      delete lean.metadata;
      ({ error } = await supabase.from('audit_logs').insert(lean));
    }

    if (error) {
      console.warn(`[AUDIT] ${actionType} was not recorded:`, error.code || '', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[AUDIT] ${actionType} failed:`, error?.message || error);
    return false;
  }
};
