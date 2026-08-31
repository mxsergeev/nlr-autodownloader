import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { assertCompatibleLegacySchema } from "../services/schema-validation.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(__dirname, "..");
const prismaCommand = path.join(
  serverDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma"
);

const BASELINE_MIGRATION = "20260829000000_init";
const LIFECYCLE_MIGRATION = "20260829000001_add_query_lifecycle_fields";

/**
 * Applies tracked migrations on fresh databases and safely adopts databases
 * created by the old `prisma db push` startup command. Adoption marks the
 * historical schema baseline as applied without recreating or deleting any
 * application rows; the lifecycle ALTER migration is then applied normally.
 */
async function main() {
  if (!process.env.DATABASE_URL?.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a SQLite file URL");
  }

  const prisma = new PrismaClient();
  let shouldRunDeploy = true;

  try {
    const tables = await prisma.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    );
    const tableNames = new Set(tables.map(({ name }) => name));

    if (tableNames.has("_prisma_migrations")) {
      // A database with migration history is already under Prisma's normal
      // control. Let migrate deploy report any genuine drift/failure.
    } else if (tableNames.has("Query") || tableNames.has("SearchResult")) {
      if (!tableNames.has("Query") || !tableNames.has("SearchResult")) {
        throw new Error(
          "Legacy database has only one application table; refusing migration. Restore a backup and investigate the database first."
        );
      }

      const queryColumns = await getColumnNames(prisma, "Query");
      const searchResultColumns = await getColumnNames(prisma, "SearchResult");
      const constraints = await getLegacyConstraints(prisma);
      assertCompatibleLegacySchema(queryColumns, searchResultColumns, constraints);

      const hasGeneration = queryColumns.has("generation");
      const hasResumeStatus = queryColumns.has("resumeStatus");
      if (hasGeneration !== hasResumeStatus) {
        throw new Error(
          "Legacy database has only one Query lifecycle column (generation/resumeStatus); refusing partial migration. Restore a backup and investigate the database first."
        );
      }

      // Close Prisma before the CLI creates/updates _prisma_migrations.
      await prisma.$disconnect();
      await runPrisma(["migrate", "resolve", "--applied", BASELINE_MIGRATION]);
      if (hasGeneration && hasResumeStatus) {
        // A database already upgraded by db push has the final shape, so both
        // tracked migrations are adopted without replaying their DDL.
        await runPrisma(["migrate", "resolve", "--applied", LIFECYCLE_MIGRATION]);
        shouldRunDeploy = false;
      }
    }

    if (shouldRunDeploy) await runPrisma(["migrate", "deploy"]);
  } finally {
    // disconnect() is idempotent and also safe after the explicit legacy
    // branch disconnect above.
    await prisma.$disconnect().catch(() => null);
  }
}

async function getColumnNames(prisma, tableName) {
  const columns = await prisma.$queryRawUnsafe(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
  return new Set(columns.map(({ name }) => name));
}

async function getLegacyConstraints(prisma) {
  return {
    queryIndexes: await getIndexDefinitions(prisma, "Query"),
    searchResultIndexes: await getIndexDefinitions(prisma, "SearchResult"),
    searchResultForeignKeys: await getForeignKeyDefinitions(prisma, "SearchResult"),
  };
}

async function getIndexDefinitions(prisma, tableName) {
  const indexes = await prisma.$queryRawUnsafe(`PRAGMA index_list(${quoteIdentifier(tableName)})`);
  return Promise.all(
    indexes.map(async (index) => {
      const columns = await prisma.$queryRawUnsafe(
        `PRAGMA index_info(${quoteIdentifier(index.name)})`
      );
      return {
        name: index.name,
        unique: Number(index.unique) === 1,
        columns: columns
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map(({ name }) => name),
      };
    })
  );
}

async function getForeignKeyDefinitions(prisma, tableName) {
  const foreignKeys = await prisma.$queryRawUnsafe(
    `PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`
  );
  return foreignKeys.map((foreignKey) => ({
    table: foreignKey.table,
    from: foreignKey.from,
    to: foreignKey.to,
    onDelete: foreignKey.on_delete,
    onUpdate: foreignKey.on_update,
  }));
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function runPrisma(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(prismaCommand, args, {
      cwd: serverDirectory,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`Prisma ${args.join(" ")} failed (${signal || `exit ${code}`})`));
    });
  });
}

main().catch((error) => {
  console.error(`[Migration] ${error.message}`);
  process.exitCode = 1;
});
