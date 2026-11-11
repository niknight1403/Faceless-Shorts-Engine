import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { PrismaClient, MembershipRole } from "@prisma/client";

const scrypt = promisify(scryptCallback);
const prisma = new PrismaClient();

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }) as Buffer;
  return ["scrypt", "16384", "8", "1", salt.toString("hex"), derived.toString("hex")].join("$");
}

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  const organizationName = process.env.BOOTSTRAP_ADMIN_ORGANIZATION?.trim() || "Faceless Shorts";
  const forcePasswordReset = process.env.BOOTSTRAP_ADMIN_FORCE_RESET === "true";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("BOOTSTRAP_ADMIN_EMAIL_invalid_or_missing");
  if (password.length < 14) throw new Error("BOOTSTRAP_ADMIN_PASSWORD_must_be_at_least_14_characters");
  if (password.length > 1024) throw new Error("BOOTSTRAP_ADMIN_PASSWORD_too_long");

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser?.passwordHash && !forcePasswordReset) {
    throw new Error("admin_already_exists_set_BOOTSTRAP_ADMIN_FORCE_RESET=true_to_rotate_password");
  }
  const hash = await passwordHash(password);
  const slug = organizationName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "faceless-shorts";
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name: "Niko", passwordHash: hash },
    update: { passwordHash: hash, name: existingUser?.name ?? "Niko" }
  });
  const organization = await prisma.organization.upsert({
    where: { slug },
    create: { name: organizationName, slug },
    update: { name: organizationName }
  });
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: organization.id } },
    create: { userId: user.id, organizationId: organization.id, role: MembershipRole.ADMIN },
    update: { role: MembershipRole.ADMIN }
  });
  console.log(JSON.stringify({ status: "admin_bootstrapped", email, organization: organization.slug, role: "ADMIN" }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "admin_bootstrap_failed");
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
