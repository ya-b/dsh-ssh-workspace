/** Certificate-free PSK authentication and AEAD records; no unauthenticated cipher fallback. */
export const SSH_STREAM_TLS_OPTIONS = {
  ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
} as const
