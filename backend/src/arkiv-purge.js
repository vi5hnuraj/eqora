// One-off purge: remove smoke/test entities the service wallet owns so the
// demo journal starts from a clean chain state. Manual UI trades (sessions
// t-*/s-*) are kept unless --all is passed. Reporter + UI writes rebuild it.
//
//   npm run purge:demo          # drop smoke data, keep manual t-/s- entries
//   node src/arkiv-purge.js --all   # drop everything the service wallet owns
import { deleteNote, getLeaderboard, publicClient } from "./arkiv.js";
import { and, eq } from "@arkiv-network/sdk/query";
import { str } from "@arkiv-network/sdk/attr";

const SERVICE = "0xd25f8736c3efc19a7cb7a3d15f2af22c2980e317";
const KINDS = [
  "trade_journal",
  "journal_note",
  "user_profile",
  "loan_memo",
  "leaderboard_entry",
  "session_snapshot",
  "lend_event",
];

const val = (a) => a?.value ?? a;
const dropAll = process.argv.includes("--all");
const dry = process.argv.includes("--dry");

const keepTrade = (attrs) =>
  !dropAll && /^(t-|s-)/.test(String(val(attrs?.session) ?? ""));

async function main() {
  const targets = [];
  for (const kind of KINDS) {
    const builder = publicClient
      .select({ key: true, owner: true, attributes: true })
      .where(and(eq("kind", str(kind))))
      .limit(200);
    let kept = 0;
    let seen = 0;
    for await (const e of builder) {
      if (String(e.owner ?? "").toLowerCase() !== SERVICE) continue;
      seen += 1;
      if (kind === "trade_journal" && keepTrade(e.attributes)) {
        kept += 1;
        continue;
      }
      targets.push({ kind, key: e.key });
    }
    console.log(`[purge] ${kind}: ${seen} owned${kept ? `, keeping ${kept} manual` : ""}`);
  }

  console.log(`[purge] ${targets.length} entities to delete${dry ? " (--dry, stopping)" : ""}`);
  if (dry || !targets.length) {
    if (!dry) await getLeaderboard({ limit: 5, refresh: true });
    return;
  }

  let removed = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      await deleteNote(t.key);
      removed += 1;
      process.stdout.write(`  deleted ${t.kind} ${t.key.slice(0, 14)}…\n`);
    } catch (error) {
      failed += 1;
      console.log(`  skip ${t.kind} ${t.key.slice(0, 14)}…: ${error.message}`);
    }
  }
  console.log(`[purge] removed ${removed}, skipped ${failed}`);

  // Re-aggregate the leaderboard from whatever journal rows remain.
  const board = await getLeaderboard({ limit: 5, refresh: true });
  console.log(`[purge] leaderboard re-synced — ${board.rows.length} row(s)`);
}

main().catch((error) => {
  console.error("[purge] failed:", error.message);
  process.exitCode = 1;
});
