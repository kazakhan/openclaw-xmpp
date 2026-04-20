export const Config = {
  // File Transfer Settings
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_CONCURRENT_TRANSFERS: 3,

  // Message Store Settings
  MAX_MESSAGES_PER_FILE: 256,
  MESSAGE_QUEUE_MAX_SIZE: 100,
  MESSAGE_CLEANUP_MAX_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours

  // Rate Limiting
  RATE_LIMIT_MAX_REQUESTS: 10,
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute

  // Session Timeouts
  IBB_SESSION_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  IBB_CLEANUP_INTERVAL_MS: 60 * 1000, // 1 minute

  // Logging
  DEBUG_LOG_FILE: 'cli-debug.log',

  // Security
  MAX_MESSAGE_BODY_SIZE: 64 * 1024,  // 64KB max inbound message body

  // Reconnection
  RECONNECT_BASE_MS: 1000,
  RECONNECT_MAX_MS: 60000,
  RECONNECT_BACKOFF_FACTOR: 2,
};

export type Config = typeof Config;
