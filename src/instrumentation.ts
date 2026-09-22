export function register() {
  // Preview deployments receive their final hostname from Vercel at runtime.
  if (!process.env.APP_URL && process.env.VERCEL_URL) {
    process.env.APP_URL = `https://${process.env.VERCEL_URL}`;
  }
}
