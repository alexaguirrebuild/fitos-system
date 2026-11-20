/**
 * Genera el hash de la contraseña del dueño para OWNER_PASSWORD_HASH.
 *   npm run hash-password            → la pide sin mostrarla
 *   echo 'clave' | npm run -s hash-password   → la lee de stdin
 * Por stdout sale solo el hash; los mensajes van por stderr.
 */
import { hashPassword } from "../src/server/auth";

function readHidden(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => (data += chunk));
      stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
      stdin.on("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    let value = "";
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelado.")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const password = await readHidden("Contraseña: ");
  if (process.stdin.isTTY) {
    const again = await readHidden("Repítela: ");
    if (again !== password) throw new Error("No coinciden.");
  }
  process.stdout.write((await hashPassword(password)) + "\n");
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
