import { setupTelegram } from './lib/telegram-setup';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--check', '--apply'].includes(arg))) {
    throw new Error('Usage: npm run telegram:setup -- --check|--apply');
  }
  const result = await setupTelegram(process.env, args[0] === '--apply');
  console.log(JSON.stringify(result, null, 2));
  if (!result.mainMiniAppEnabled) console.log('BotFather: enable Main Mini App using miniAppUrl above.');
  console.log('API settings do not prove end-to-end delivery. Test /start, contact and Mini App; run the worker for replies.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Telegram setup failed');
  process.exitCode = 1;
}
