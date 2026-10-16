// Explicit disposable database only. This setup NEVER drops or resets any database.
if (
  !process.env.AGENT_TEST_DATABASE_URL ||
  !new URL(process.env.AGENT_TEST_DATABASE_URL).pathname.startsWith('/stackpanel_agent_audit_')
) {
  throw new Error('Agent 集成测试要求独立的 stackpanel_agent_audit_* 测试库');
}
process.env.DATABASE_URL = process.env.AGENT_TEST_DATABASE_URL;
process.env.JWT_SECRET = 'agent_integration_secret_at_least_32_chars_012345';
process.env.SETTINGS_ENCRYPTION_KEY = 'agent_integration_settings_key_at_least_32_chars';
process.env.API_LOG_LEVEL = 'silent';

process.env.AGENT_PUBLIC_ORIGIN = 'https://api.stackpanel.test';
process.env.AGENT_WEB_ORIGIN = 'https://stackpanel.test';
