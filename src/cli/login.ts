/**
 * Interactive sign-in to yumi.market: asks for the e-mail, the site sends a
 * one-time code, you type it here. The session is saved to the session file.
 *
 *   npm run login
 *   npm run login -- --logout
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createClientFromEnv } from "../yumi/index.js";

const yumi = createClientFromEnv();

if (process.argv.includes("--logout")) {
  await yumi.logout();
  console.log("Сесію видалено.");
  process.exit(0);
}

if (await yumi.isLoggedIn()) {
  console.log("Вже виконано вхід. Для виходу: npm run login -- --logout");
  process.exit(0);
}

const rl = createInterface({ input, output });
try {
  const email = (await rl.question("Email акаунта yumi.market: ")).trim();
  await yumi.sendLoginCode(email);
  console.log("Код надіслано на пошту.");
  const code = (await rl.question("Код з листа: ")).trim();
  const { loggedIn } = await yumi.verifyLoginCode(code);
  console.log(loggedIn ? "Вхід виконано, сесію збережено." : "Не вдалося увійти: перевірте код і спробуйте ще раз.");
  process.exitCode = loggedIn ? 0 : 1;
} catch (err) {
  console.error("Помилка:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  rl.close();
}
