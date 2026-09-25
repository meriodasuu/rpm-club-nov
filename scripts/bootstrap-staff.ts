import { transaction, closePool } from "../src/lib/db";
async function main() {
  const telegramId = process.argv[2];
  if (!telegramId || !/^\d{1,20}$/.test(telegramId))
    throw new Error(
      "Usage: npm run staff:bootstrap -- TELEGRAM_NUMERIC_ID; register in the bot first",
    );
  await transaction(async (tx) => {
    await tx.query("LOCK TABLE admin_memberships IN EXCLUSIVE MODE");
    if ((await tx.query("SELECT id FROM admin_memberships LIMIT 1")).length)
      throw new Error(
        "First-admin bootstrap already completed; use the team screen",
      );
    const [user] = await tx.query<{ id: string; name: string }>(
      "SELECT id,name FROM users WHERE telegram_id=$1 AND status='active' FOR UPDATE",
      [telegramId],
    );
    if (!user)
      throw new Error("An active registered Telegram user is required");
    await tx.query(
      "INSERT INTO admin_memberships(telegram_user_id,name,role) VALUES($1,$2,'admin')",
      [user.id, user.name],
    );
  });
  console.log(
    "First administrator added. Open /admin in the bot and set the email and password.",
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closePool);
