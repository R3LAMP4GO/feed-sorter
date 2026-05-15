// Browser-side API base URL constant. Reads from NEXT_PUBLIC_API_URL.

export const API_BASE_URL_CLIENT =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';
