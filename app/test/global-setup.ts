import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

// Fresh SQLite database for every test run.
export default function setup() {
  rmSync("prisma/test.sqlite", { force: true });
  execSync("npx prisma migrate deploy", {
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: "file:./test.sqlite" },
  });
}
